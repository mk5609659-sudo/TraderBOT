'use strict';

const sharp = require('sharp');

let _tf = null;
let _cocoModel = null;
let _blazeModel = null;

async function getTf() {
  if (!_tf) {
    console.log('[image-editor] loading TensorFlow.js...');
    _tf = require('@tensorflow/tfjs-node');
    console.log('[image-editor] TensorFlow.js ready.');
  }
  return _tf;
}

// ─── Background Removal ───────────────────────────────────────────────────────
async function removeBackground(inputBuffer) {
  const { removeBackground: rmbg } = require('@imgly/background-removal-node');
  const ab = inputBuffer.buffer.slice(
    inputBuffer.byteOffset,
    inputBuffer.byteOffset + inputBuffer.byteLength
  );
  const result = await rmbg(ab, { model: 'small', output: { type: 'foreground' } });
  const resultAb = await result.arrayBuffer();
  return Buffer.from(resultAb);
}

// ─── Image Upscaler ───────────────────────────────────────────────────────────
async function upscaleImage(inputBuffer, scale = 4) {
  const meta = await sharp(inputBuffer).metadata();
  const newWidth  = Math.min(Math.round(meta.width  * scale), 7680);
  const newHeight = Math.min(Math.round(meta.height * scale), 4320);

  const sigma = scale >= 4 ? 1.5 : 0.8;
  const m1    = scale >= 4 ? 1.5 : 1.0;
  const m2    = scale >= 4 ? 0.7 : 0.4;

  return sharp(inputBuffer)
    .resize(newWidth, newHeight, { kernel: sharp.kernel.lanczos3, fit: 'fill' })
    .sharpen({ sigma, m1, m2, x1: 2, y2: 10, y3: 20 })
    .png()
    .toBuffer();
}

// ─── Object Detection ─────────────────────────────────────────────────────────
async function loadCocoModel() {
  if (_cocoModel) return _cocoModel;
  await getTf();
  const cocoSsd = require('@tensorflow-models/coco-ssd');
  console.log('[image-editor] loading COCO-SSD model...');
  _cocoModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  console.log('[image-editor] COCO-SSD ready.');
  return _cocoModel;
}

async function detectObjects(inputBuffer) {
  const model = await loadCocoModel();
  const tf    = await getTf();

  const meta   = await sharp(inputBuffer).metadata();
  const maxDim = 640;
  const scale  = Math.min(maxDim / meta.width, maxDim / meta.height, 1);
  const resW   = Math.round(meta.width  * scale);
  const resH   = Math.round(meta.height * scale);

  const { data } = await sharp(inputBuffer)
    .resize(resW, resH)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = tf.tensor3d(new Uint8Array(data), [resH, resW, 3]);
  const preds  = await model.detect(tensor);
  tensor.dispose();

  return preds.map(p => ({
    label: p.class,
    score: Math.round(p.score * 100),
    bbox: {
      x: Math.max(0, Math.round(p.bbox[0] / scale)),
      y: Math.max(0, Math.round(p.bbox[1] / scale)),
      w: Math.min(Math.round(p.bbox[2] / scale), meta.width),
      h: Math.min(Math.round(p.bbox[3] / scale), meta.height),
    },
  }));
}

async function inpaintRegion(inputBuffer, { x, y, w, h }) {
  const meta = await sharp(inputBuffer).metadata();
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(w, meta.width  - x);
  h = Math.min(h, meta.height - y);
  if (w <= 0 || h <= 0) return inputBuffer;

  const padX = Math.round(w * 0.5);
  const padY = Math.round(h * 0.5);
  const cx   = Math.max(0, x - padX);
  const cy   = Math.max(0, y - padY);
  const cw   = Math.min(meta.width  - cx, w + padX * 2);
  const ch   = Math.min(meta.height - cy, h + padY * 2);

  const blurSigma = Math.max(12, Math.min(w, h) / 2.5);

  const blurredCtx = await sharp(inputBuffer)
    .extract({ left: cx, top: cy, width: cw, height: ch })
    .blur(blurSigma)
    .png()
    .toBuffer();

  const fillX = x - cx;
  const fillY = y - cy;
  const fillW = Math.min(w, cw - fillX);
  const fillH = Math.min(h, ch - fillY);
  if (fillW <= 0 || fillH <= 0) return inputBuffer;

  const fillPatch = await sharp(blurredCtx)
    .extract({ left: fillX, top: fillY, width: fillW, height: fillH })
    .png()
    .toBuffer();

  return sharp(inputBuffer)
    .composite([{ input: fillPatch, left: x, top: y }])
    .png()
    .toBuffer();
}

async function removeObjects(inputBuffer, bboxes) {
  let result = inputBuffer;
  for (const bbox of bboxes) {
    result = await inpaintRegion(result, bbox);
  }
  return result;
}

// ─── Face Detection + Swap ────────────────────────────────────────────────────
async function loadBlazeface() {
  if (_blazeModel) return _blazeModel;
  await getTf();
  const blazeface = require('@tensorflow-models/blazeface');
  console.log('[image-editor] loading BlazeFace model...');
  _blazeModel = await blazeface.load();
  console.log('[image-editor] BlazeFace ready.');
  return _blazeModel;
}

async function detectFaces(inputBuffer) {
  const model  = await loadBlazeface();
  const tf     = await getTf();

  const meta   = await sharp(inputBuffer).metadata();
  const maxDim = 256;
  const scale  = Math.min(maxDim / meta.width, maxDim / meta.height, 1);
  const resW   = Math.max(1, Math.round(meta.width  * scale));
  const resH   = Math.max(1, Math.round(meta.height * scale));

  const { data } = await sharp(inputBuffer)
    .resize(resW, resH)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = tf.tensor3d(new Uint8Array(data), [resH, resW, 3]);
  const preds  = await model.estimateFaces(tensor, false);
  tensor.dispose();

  return preds.map(p => {
    const tl = Array.isArray(p.topLeft)     ? p.topLeft     : Array.from(p.topLeft);
    const br = Array.isArray(p.bottomRight) ? p.bottomRight : Array.from(p.bottomRight);
    return {
      x: Math.max(0, Math.round(tl[0] / scale)),
      y: Math.max(0, Math.round(tl[1] / scale)),
      w: Math.max(1, Math.round((br[0] - tl[0]) / scale)),
      h: Math.max(1, Math.round((br[1] - tl[1]) / scale)),
    };
  });
}

async function swapFace(faceSourceBuffer, targetBuffer) {
  const [sourceFaces, targetFaces] = await Promise.all([
    detectFaces(faceSourceBuffer),
    detectFaces(targetBuffer),
  ]);

  if (sourceFaces.length === 0) throw new Error('No face detected in the **face image** (second attachment).');
  if (targetFaces.length === 0) throw new Error('No face detected in the **target image** (first attachment).');

  const src = sourceFaces[0];
  const tgt = targetFaces[0];

  const srcMeta = await sharp(faceSourceBuffer).metadata();
  const tgtMeta = await sharp(targetBuffer).metadata();

  const srcPad = Math.round(Math.min(src.w, src.h) * 0.2);
  const srcX   = Math.max(0, src.x - srcPad);
  const srcY   = Math.max(0, src.y - srcPad);
  const srcW   = Math.min(srcMeta.width  - srcX, src.w + srcPad * 2);
  const srcH   = Math.min(srcMeta.height - srcY, src.h + srcPad * 2);

  const tgtPad = Math.round(Math.min(tgt.w, tgt.h) * 0.15);
  const tgtX   = Math.max(0, tgt.x - tgtPad);
  const tgtY   = Math.max(0, tgt.y - tgtPad);
  const tgtW   = Math.min(tgtMeta.width  - tgtX, tgt.w + tgtPad * 2);
  const tgtH   = Math.min(tgtMeta.height - tgtY, tgt.h + tgtPad * 2);

  const extractedFace = await sharp(faceSourceBuffer)
    .extract({ left: srcX, top: srcY, width: Math.max(1, srcW), height: Math.max(1, srcH) })
    .resize(Math.max(1, tgtW), Math.max(1, tgtH), { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();

  const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tgtW}" height="${tgtH}">
    <defs>
      <radialGradient id="g" cx="50%" cy="44%" rx="44%" ry="46%">
        <stop offset="55%" stop-color="white" stop-opacity="1"/>
        <stop offset="100%" stop-color="white" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <ellipse cx="${tgtW / 2}" cy="${tgtH * 0.44}" rx="${tgtW * 0.44}" ry="${tgtH * 0.46}" fill="url(#g)"/>
  </svg>`;

  const maskedFace = await sharp(extractedFace)
    .composite([{ input: Buffer.from(maskSvg), blend: 'dest-in' }])
    .png()
    .toBuffer();

  return sharp(targetBuffer)
    .composite([{ input: maskedFace, left: tgtX, top: tgtY, blend: 'over' }])
    .png()
    .toBuffer();
}

module.exports = { removeBackground, upscaleImage, detectObjects, removeObjects, swapFace };
