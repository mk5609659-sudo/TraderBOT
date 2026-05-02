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

// ─── Object Removal (gradient-blend fill) ────────────────────────────────────
// Collects strips from all available sides, then blends them with SVG gradient
// masks so the fill transitions smoothly from surrounding context.
// Top+bottom: sky fades into ground.  Left+right: left side fades into right.
// This removes the visible stretching artifacts of the single-strip approach.
async function inpaintRegion(inputBuffer, { x, y, w, h }) {
  const meta = await sharp(inputBuffer).metadata();
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(w, meta.width  - x);
  h = Math.min(h, meta.height - y);
  if (w <= 0 || h <= 0) return inputBuffer;

  const sh = Math.max(25, Math.round(h * 0.30));
  const sw = Math.max(25, Math.round(w * 0.30));

  // Collect all available surrounding strips scaled to bbox size
  const s = {};
  if (y >= sh)
    s.top = await sharp(inputBuffer)
      .extract({ left: x, top: Math.max(0, y - sh), width: w, height: sh })
      .resize(w, h, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).png().toBuffer();
  if (y + h + sh <= meta.height)
    s.bot = await sharp(inputBuffer)
      .extract({ left: x, top: y + h, width: w, height: Math.min(sh, meta.height - y - h) })
      .resize(w, h, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).png().toBuffer();
  if (x >= sw)
    s.left = await sharp(inputBuffer)
      .extract({ left: Math.max(0, x - sw), top: y, width: sw, height: h })
      .resize(w, h, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).png().toBuffer();
  if (x + w + sw <= meta.width)
    s.right = await sharp(inputBuffer)
      .extract({ left: x + w, top: y, width: Math.min(sw, meta.width - x - w), height: h })
      .resize(w, h, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).png().toBuffer();

  const keys = Object.keys(s);
  if (keys.length === 0) return blurFill(inputBuffer, { x, y, w, h, meta });

  let fill;

  if (s.top && s.bot) {
    // Blend: top strip fades out going down, bottom strip fades out going up
    // Result: smooth vertical gradient from surrounding context
    const topMask = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="white" stop-opacity="1"/>
        <stop offset="100%" stop-color="white" stop-opacity="0"/>
      </linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
    </svg>`;
    const maskedTop = await sharp(s.top)
      .composite([{ input: Buffer.from(topMask), blend: 'dest-in' }]).png().toBuffer();
    fill = await sharp(s.bot)
      .composite([{ input: maskedTop, blend: 'over' }]).blur(1.5).png().toBuffer();

  } else if (s.left && s.right) {
    // Horizontal gradient blend
    const leftMask = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="white" stop-opacity="1"/>
        <stop offset="100%" stop-color="white" stop-opacity="0"/>
      </linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
    </svg>`;
    const maskedLeft = await sharp(s.left)
      .composite([{ input: Buffer.from(leftMask), blend: 'dest-in' }]).png().toBuffer();
    fill = await sharp(s.right)
      .composite([{ input: maskedLeft, blend: 'over' }]).blur(1.5).png().toBuffer();

  } else if (s.top && s.left) {
    // Blend top+left with diagonal gradient
    const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="white" stop-opacity="1"/>
        <stop offset="100%" stop-color="white" stop-opacity="0"/>
      </linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
    </svg>`;
    const maskedTop = await sharp(s.top)
      .composite([{ input: Buffer.from(mask), blend: 'dest-in' }]).png().toBuffer();
    fill = await sharp(s.left)
      .composite([{ input: maskedTop, blend: 'over' }]).blur(1.5).png().toBuffer();

  } else {
    // Single strip available — use it with soft edge blur
    fill = await sharp(s[keys[0]]).blur(1.5).png().toBuffer();
  }

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

// ── Strategy 1: BlazeFace at multiple scales ──────────────────────────────────
async function blazefaceAtScale(model, tf, imgBuf, meta, maxDim) {
  const scale = Math.min(maxDim / meta.width, maxDim / meta.height, 1);
  const resW  = Math.max(1, Math.round(meta.width  * scale));
  const resH  = Math.max(1, Math.round(meta.height * scale));

  const { data } = await sharp(imgBuf)
    .resize(resW, resH).removeAlpha().raw().toBuffer({ resolveWithObject: true });

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

// ── Strategy 2: COCO-SSD person → face region heuristic ──────────────────────
// When BlazeFace fails on full-body shots, the person bbox is reliable.
// Face is the top 14 % of the person height, capped at 200 px tall,
// horizontally centred at 55 % of person width.
async function detectFacesViaPerson(inputBuffer) {
  const objects = await detectObjects(inputBuffer);
  const persons = objects.filter(o => o.label === 'person');
  if (persons.length === 0) return [];
  return persons.map(p => {
    const faceH = Math.min(200, Math.max(10, Math.round(p.bbox.h * 0.14)));
    const faceW = Math.min(200, Math.max(10, Math.round(p.bbox.w * 0.55)));
    const faceX = p.bbox.x + Math.round((p.bbox.w - faceW) / 2);
    const faceY = p.bbox.y + Math.round(p.bbox.h * 0.01); // tiny offset past head-top
    return { x: faceX, y: faceY, w: faceW, h: faceH };
  });
}

async function detectFaces(inputBuffer) {
  const model = await loadBlazeface();
  const tf    = await getTf();
  const meta  = await sharp(inputBuffer).metadata();

  // Try BlazeFace at increasing resolutions (higher res finds smaller faces)
  for (const maxDim of [256, 384, 512, 640]) {
    const faces = await blazefaceAtScale(model, tf, inputBuffer, meta, maxDim);
    if (faces.length > 0) return faces;
  }

  // BlazeFace missed every scale — try top 55 % crop (face is usually there
  // in portrait/full-body shots where the head is at the top)
  const cropH   = Math.max(50, Math.round(meta.height * 0.55));
  const topCrop = await sharp(inputBuffer)
    .extract({ left: 0, top: 0, width: meta.width, height: cropH }).png().toBuffer();
  const cropMeta = { width: meta.width, height: cropH };

  for (const maxDim of [384, 512]) {
    const faces = await blazefaceAtScale(model, tf, topCrop, cropMeta, maxDim);
    if (faces.length > 0) return faces; // coords already in original-image space
  }

  // Final fallback: infer face position from COCO-SSD person bounding box
  console.log('[image-editor] BlazeFace found nothing — falling back to person bbox');
  return detectFacesViaPerson(inputBuffer);
}

// ── Per-channel colour/luminance matching ─────────────────────────────────────
// Scales R, G, B channels of srcBuf so its average matches tgtBuf's average.
// This corrects for lighting and skin-tone differences between the two photos.
async function colourMatch(srcBuf, tgtBuf) {
  const avg = async (buf) => {
    const raw = await sharp(buf).resize(8, 8).removeAlpha().raw().toBuffer();
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < raw.length; i += 3) { r += raw[i]; g += raw[i+1]; b += raw[i+2]; }
    const n = raw.length / 3;
    return { r: r / n, g: g / n, b: b / n };
  };
  const [sa, ta] = await Promise.all([avg(srcBuf), avg(tgtBuf)]);
  const clamp = v => Math.min(3.0, Math.max(0.25, v));
  const rS = clamp(sa.r > 2 ? ta.r / sa.r : 1);
  const gS = clamp(sa.g > 2 ? ta.g / sa.g : 1);
  const bS = clamp(sa.b > 2 ? ta.b / sa.b : 1);
  return sharp(srcBuf).linear([rS, gS, bS], [0, 0, 0]).png().toBuffer();
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

  // Source crop: generous padding to include forehead + chin + ears
  const srcPad = Math.round(Math.min(src.w, src.h) * 0.25);
  const srcX   = Math.max(0, src.x - srcPad);
  const srcY   = Math.max(0, src.y - srcPad);
  const srcW   = Math.min(srcMeta.width  - srcX, src.w + srcPad * 2);
  const srcH   = Math.min(srcMeta.height - srcY, src.h + srcPad * 2);

  // Target paste region: match same generous padding
  const tgtPad = Math.round(Math.min(tgt.w, tgt.h) * 0.25);
  const tgtX   = Math.max(0, tgt.x - tgtPad);
  const tgtY   = Math.max(0, tgt.y - tgtPad);
  const tgtW   = Math.min(tgtMeta.width  - tgtX, tgt.w + tgtPad * 2);
  const tgtH   = Math.min(tgtMeta.height - tgtY, tgt.h + tgtPad * 2);

  // Extract and resize source face to match target face region exactly
  const extractedFace = await sharp(faceSourceBuffer)
    .extract({ left: srcX, top: srcY, width: Math.max(1, srcW), height: Math.max(1, srcH) })
    .resize(Math.max(1, tgtW), Math.max(1, tgtH), { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();

  // Extract target face region for colour reference
  const targetFaceRegion = await sharp(targetBuffer)
    .extract({ left: tgtX, top: tgtY, width: Math.max(1, tgtW), height: Math.max(1, tgtH) })
    .png().toBuffer();

  // Match lighting / skin tone of source face to target face
  const colourMatchedFace = await colourMatch(extractedFace, targetFaceRegion);

  // Elliptical feather mask — fade starts at 35 % radius so edges are very soft
  const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tgtW}" height="${tgtH}">
    <defs>
      <radialGradient id="g" cx="50%" cy="44%" rx="46%" ry="48%">
        <stop offset="35%" stop-color="white" stop-opacity="1"/>
        <stop offset="100%" stop-color="white" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <ellipse cx="${tgtW/2}" cy="${tgtH*0.44}" rx="${tgtW*0.46}" ry="${tgtH*0.48}" fill="url(#g)"/>
  </svg>`;

  const maskedFace = await sharp(colourMatchedFace)
    .composite([{ input: Buffer.from(maskSvg), blend: 'dest-in' }])
    .png()
    .toBuffer();

  return sharp(targetBuffer)
    .composite([{ input: maskedFace, left: tgtX, top: tgtY, blend: 'over' }])
    .png()
    .toBuffer();
}

module.exports = { removeBackground, upscaleImage, detectObjects, removeObjects, swapFace };
