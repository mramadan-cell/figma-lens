// Small PNG helpers on top of pngjs (no native deps): read/write, crop, resize, compose.
import fs from 'node:fs';
import { PNG } from 'pngjs';

export function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

// fast: light compression for images that are only looked at (compare output): several times faster
// to write on big pages, files somewhat larger. Pixels are identical either way.
export function writePng(file, img, { fast = false } = {}) {
  fs.writeFileSync(file, PNG.sync.write(img, fast ? { deflateLevel: 1, deflateStrategy: 3 } : undefined));
}

/**
 * Shrink by an integer factor keeping the most saturated pixel of each block, so 1-pixel diff marks
 * (saturated red) stay visible in a small preview instead of being averaged away. For diff images.
 */
export function shrinkMax(src, factor) {
  if (factor <= 1) return src;
  const w = Math.max(1, Math.floor(src.width / factor));
  const h = Math.max(1, Math.floor(src.height / factor));
  const dst = new PNG({ width: w, height: h });
  const s = src.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = -1;
      let bi = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * src.width;
        for (let dx = 0; dx < factor; dx++) {
          const i = (row + x * factor + dx) * 4;
          const sat = Math.max(s[i], s[i + 1], s[i + 2]) - Math.min(s[i], s[i + 1], s[i + 2]);
          if (sat > best) {
            best = sat;
            bi = i;
          }
        }
      }
      const o = (y * w + x) * 4;
      dst.data[o] = s[bi];
      dst.data[o + 1] = s[bi + 1];
      dst.data[o + 2] = s[bi + 2];
      dst.data[o + 3] = s[bi + 3];
    }
  }
  return dst;
}

export function blank(width, height, rgba = [255, 255, 255, 255]) {
  const img = new PNG({ width, height });
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = rgba[0];
    img.data[i + 1] = rgba[1];
    img.data[i + 2] = rgba[2];
    img.data[i + 3] = rgba[3];
  }
  return img;
}

export function crop(src, x, y, w, h) {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.min(src.width - x, Math.round(w));
  h = Math.min(src.height - y, Math.round(h));
  if (w <= 0 || h <= 0) throw new Error(`crop outside image (${src.width}×${src.height})`);
  const dst = new PNG({ width: w, height: h });
  PNG.bitblt(src, dst, x, y, w, h, 0, 0);
  return dst;
}

// Bilinear resize (good enough to bring a 1x/3x screenshot onto the design's pixel grid).
export function resize(src, width, height) {
  if (src.width === width && src.height === height) return src;
  const dst = new PNG({ width, height });
  const sx = src.width / width;
  const sy = src.height / height;
  const s = src.data;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(src.height - 1, Math.floor(fy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(src.width - 1, Math.floor(fx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = fx - x0;
      const i00 = (y0 * src.width + x0) * 4;
      const i10 = (y0 * src.width + x1) * 4;
      const i01 = (y1 * src.width + x0) * 4;
      const i11 = (y1 * src.width + x1) * 4;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = s[i00 + c] * (1 - wx) + s[i10 + c] * wx;
        const bot = s[i01 + c] * (1 - wx) + s[i11 + c] * wx;
        dst.data[o + c] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return dst;
}

// Flatten transparency onto white so transparent design areas compare like a white app background.
export function flatten(src, bg = [255, 255, 255]) {
  const dst = new PNG({ width: src.width, height: src.height });
  for (let i = 0; i < src.data.length; i += 4) {
    const a = src.data[i + 3] / 255;
    dst.data[i] = Math.round(src.data[i] * a + bg[0] * (1 - a));
    dst.data[i + 1] = Math.round(src.data[i + 1] * a + bg[1] * (1 - a));
    dst.data[i + 2] = Math.round(src.data[i + 2] * a + bg[2] * (1 - a));
    dst.data[i + 3] = 255;
  }
  return dst;
}

// Place images side by side (top-aligned) with a gap and an optional colored bar above each.
export function hstack(images, { gap = 16, bar = 0, barColors = [] } = {}) {
  const width = images.reduce((sum, im) => sum + im.width, 0) + gap * (images.length + 1);
  const height = Math.max(...images.map((im) => im.height)) + gap * 2 + bar;
  const out = blank(width, height, [245, 245, 247, 255]);
  let x = gap;
  images.forEach((im, i) => {
    if (bar && barColors[i]) PNG.bitblt(blank(im.width, bar, barColors[i]), out, 0, 0, im.width, bar, x, gap);
    PNG.bitblt(im, out, 0, 0, im.width, im.height, x, gap + bar);
    x += im.width + gap;
  });
  return out;
}

export function vstack(images, { gap = 16 } = {}) {
  const width = Math.max(...images.map((im) => im.width));
  const height = images.reduce((sum, im) => sum + im.height, 0) + gap * (images.length - 1);
  const out = blank(width, height, [245, 245, 247, 255]);
  let y = 0;
  for (const im of images) {
    PNG.bitblt(im, out, 0, 0, im.width, im.height, 0, y);
    y += im.height + gap;
  }
  return out;
}
