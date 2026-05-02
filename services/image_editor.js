'use strict';

const sharp = require('sharp');

let _tf         = null;
let _cocoModel  = null;
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
// Fix: normalise to PNG first, then wrap in a fresh Blob.
// Buffer.buffer is a SHARED pool ArrayBuffer — ONNX Runtime rejects it when
// byteOffset > 0.  Creating a Blob from [pngBuffer] always works.
async function removeBackground(inputBuffer) {
  const { removeBackground: rmbg } = require('@imgly/background-removal-node');
  const pngBuffer = await sharp(inputBuffer).png().toBuffer();
  const blob      = new Blob([pngBuffer], { type: 'image/png' });
  const result    = await rmbg(blob, { model: 'small', output: { type: 'foreground' } });
  return Buffer.from(await result.arrayBuffer());
}

// ─── Image Upscaler ───────────────────────────────────────────────────────────
async function upscaleImage(inputBuffer, scale = 4) {
  const meta      = await sharp(inputBuffer).metadata();
  const newWidth  = Math.min(Math.round(meta.width  * scale), 7680);
  const newHeight = Math.min(Math.round(meta.height * scale), 4320);

  const sigma = scale >= 4 ? 1.5 : 0.8;
  const m1    = scale >= 4 ? 1.5 : 1.0;
  const m2    = scale >= 4 ? 0.7 : 0.4;

  const upscaled = await sharp(inputBuffer)
    .resize(newWidth, newHeight, { kernel: sharp.kernel.lanczos3, fit: 'fill' })
    .sharpen({ sigma, m1, m2, x1: 2, y2: 10, y3: 20 })
    .png()
    .toBuffer();

  // Encode as JPEG if PNG is too large for Discord (8 MB limit)
  const DISCORD_MAX = 7.5 * 1024 * 1024;
  if (upscaled.length > DISCORD_MAX) {
    const jpg90 = await sharp(upscaled).jpeg({ quality: 90 }).toBuffer();
    if (jpg90.length <= DISCORD_MAX) return { buf: jpg90, ext: 'jpg' };
    const jpg75 = await sharp(upscaled).jpeg({ quality: 75 }).toBuffer();
    return { buf: jpg75, ext: 'jpg' };
  }
  return { buf: upscaled, ext: 'png' };
}

// ─── Object Detection ─────────────────────────────────────────────────────────
// Fix: use mobilenet_v2 (more accurate than lite_mobilenet_v2) and lower
// the minimum score threshold so partially-occluded objects are caught.
async function loadCocoModel() {
  if (_cocoModel) return _cocoModel;
  await getTf();
  const cocoSsd = require('@tensorflow-models/coco-ssd');
  console.log('[image-editor] loading COCO-SSD model (mobilenet_v2)...');
  _cocoModel = await cocoSsd.load({ base: 'mobilenet_v2' });
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
  // maxNumBoxes=20, minScore=0.30 — catches partially occluded objects
  const preds  = await model.detect(tensor, 20, 0.30);
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

// ─── Object Removal (strip-based fill) ────────────────────────────────────────
// Fix: instead of blurring the area (which leaves an obvious smear), we clone
// the adjacent strip that has the most background context and stretch it to
// fill the gap.  This makes the removal look like the object was never there.
async function inpaintRegion(inputBuffer, { x, y, w, h }) {
  const meta = await sharp(inputBuffer).metadata();
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(w, meta.width  - x);
  h = Math.min(h, meta.height - y);
  if (w <= 0 || h <= 0) return inputBuffer;

  // Strip thickness: 25 % of bbox dimension or at least 20 px
  const sw = Math.max(20, Math.round(w * 0.25));
  const sh = Math.max(20, Math.round(h * 0.25));

  const strips = [];

  // Left strip — scaled to fill the bbox
  if (x >= sw) {
    strips.push({
      weight: x, // more room → prefer it
      buf: await sharp(inputBuffer)
        .extract({ left: x - sw, top: y, width: sw, height: h })
        .resize(w, h, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
        .png().toBuffer(),
    });
  }
  // Right strip
  if (x + w + sw <= meta.width) {
    strips.push({
      weight: meta.width - (x + w),
      buf: await sharp(inputBuffer)
        .extract({ left: x + w, top: y, width: sw, height: h })
        .resize(w, h, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
        .png().toBuffer(),
    });
  }
  // Top strip
  if (y >= sh) {
    strips.push({
      weight: y,
      buf: await sharp(inputBuffer)
        .extract({ left: x, top: y - sh, width: w, height: sh })
        .resize(w, h, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
        .png().toBuffer(),
    });
  }
  // Bottom strip
  if (y + h + sh <= meta.height) {
    strips.push({
      weight: meta.height - (y + h),
      buf: await sharp(inputBuffer)
        .extract({ left: x, top: y + h, width: w, height: sh })
        .resize(w, h, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
        .png().toBuffer(),
    });
  }

  if (strips.length === 0) {
    // Last resort: simple blur fill
    return blurFill(inputBuffer, { x, y, w, h, meta });
  }

  // Use the strip with the most background context around it
  strips.sort((a, b) => b.weight - a.weight);
  // Apply a very soft blur (sigma=1) to the fill so edges blend naturally
  const fill = await sharp(strips[0].buf).blur(1).png().toBuffer();

  return sharp(inputBuffer)
    .composite([{ input: fill, left: x, top: y }])
    .png()
    .toBuffer();
}

async function blurFill(inputBuffer, { x, y, w, h, meta }) {
  const pad  = Math.max(10, Math.round(Math.min(w, h) * 0.3));
  const cx   = Math.max(0, x - pad);
  const cy   = Math.max(0, y - pad);
  const cw   = Math.min(meta.width  - cx, w + pad * 2);
  const ch   = Math.min(meta.height - cy, h + pad * 2);
  const blur = Math.max(8, Math.min(w, h) / 3);

  const blurred  = await sharp(inputBuffer).extract({ left: cx, top: cy, width: cw, height: ch }).blur(blur).png().toBuffer();
  const fillX    = x - cx;
  const fillY    = y - cy;
  const fillW    = Math.min(w, cw - fillX);
  const fillH    = Math.min(h, ch - fillY);
  if (fillW <= 0 || fillH <= 0) return inputBuffer;

  const patch = await sharp(blurred).extract({ left: fillX, top: fillY, width: fillW, height: fillH }).png().toBuffer();
  return sharp(inputBuffer).composite([{ input: patch, left: x, top: y }]).png().toBuffer();
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

// Fix: try multiple input scales (128 → 256 → 512 px) so faces that are
// small relative to the image are still found.
async function detectFaces(inputBuffer) {
  const model = await loadBlazeface();
  const tf    = await getTf();
  const meta  = await sharp(inputBuffer).metadata();

  for (const maxDim of [128, 256, 512]) {
    const scale = Math.min(maxDim / meta.width, maxDim / meta.height, 1);
    const resW  = Math.max(1, Math.round(meta.width  * scale));
    const resH  = Math.max(1, Math.round(meta.height * scale));

    const { data } = await sharp(inputBuffer)
      .resize(resW, resH)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const tensor = tf.tensor3d(new Uint8Array(data), [resH, resW, 3]);
    const preds  = await model.estimateFaces(tensor, false);
    tensor.dispose();

    if (preds.length > 0) {
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
  }

  return [];
}

async function swapFace(faceSourceBuffer, targetBuffer) {
  const [sourceFaces, targetFaces] = await Promise.all([
    detectFaces(faceSourceBuffer),
    detectFaces(targetBuffer),
  ]);

  if (sourceFaces.length === 0) throw new Error('No face detected in the **face image** (second attachment).');
  if (targetFaces.length === 0) throw new Error('No face detected in the **target image** (first attachment).');

  const src     = sourceFaces[0];
  const tgt     = targetFaces[0];
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

  // Soft elliptical feather mask for natural blending
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
