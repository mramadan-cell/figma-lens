// Demo assets for a README: an animated GIF (first build → fixed build) and a still
// before/after image. Each frame is: Figma | build | diff. Bar colors: blue = Figma,
// red = first build, green = fixed build, pink = diff.
import fs from 'node:fs';
import path from 'node:path';
import gifenc from 'gifenc';
import { computeDiff } from './compare.js';
import { blank, hstack, vstack, resize, writePng } from './image.js';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const BLUE = [91, 91, 214, 255];
const RED = [220, 38, 38, 255];
const GREEN = [22, 163, 74, 255];
const PINK = [255, 0, 64, 255];

function padTo(img, w, h) {
  if (img.width === w && img.height === h) return img;
  const out = blank(w, h, [245, 245, 247, 255]);
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
}

function fitWidth(img, maxWidth) {
  if (img.width <= maxWidth) return img;
  return resize(img, maxWidth, Math.round(img.height * (maxWidth / img.width)));
}

export function makeDemo({ designDir, before, after, outDir, cropTop = 0, cropBottom = 0, maxWidth = 1200, delayMs = 2200 }) {
  const b = computeDiff({ designDir, actualFile: before, cropTop, cropBottom });
  const a = computeDiff({ designDir, actualFile: after, cropTop, cropBottom });
  let fb = hstack([b.design, b.actual, b.diff], { bar: 10, barColors: [BLUE, RED, PINK] });
  let fa = hstack([a.design, a.actual, a.diff], { bar: 10, barColors: [BLUE, GREEN, PINK] });
  const w = Math.max(fb.width, fa.width);
  const h = Math.max(fb.height, fa.height);
  fb = fitWidth(padTo(fb, w, h), maxWidth);
  fa = fitWidth(padTo(fa, w, h), maxWidth);

  const dir = outDir || path.join(designDir, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  const gifFile = path.join(dir, 'demo.gif');
  const pngFile = path.join(dir, 'before-after.png');

  const gif = GIFEncoder();
  for (const frame of [fb, fa]) {
    const palette = quantize(frame.data, 256);
    const index = applyPalette(frame.data, palette);
    gif.writeFrame(index, frame.width, frame.height, { palette, delay: delayMs });
  }
  gif.finish();
  fs.writeFileSync(gifFile, gif.bytes());
  writePng(pngFile, vstack([fb, fa], { gap: 24 }));

  return {
    gif: gifFile,
    png: pngFile,
    beforePct: b.stats.mismatchPct,
    afterPct: a.stats.mismatchPct,
    frame: b.meta.nodeName,
  };
}
