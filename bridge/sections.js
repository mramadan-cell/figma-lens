// Section planning and crops. The plugin sends the frame's top-level blocks; on big pages
// (e.g. an HTML import: one "Main" layer covering the whole page) one block can be the
// entire screenshot, which is useless as a "detail" image and heavy for the agent's context.
// So: split dominant, oversized blocks one level deeper, cut very tall crops into pieces,
// and cap every image's long edge (Claude downsizes larger images anyway).
import { PNG } from 'pngjs';
import { resize } from '../tools/image.js';

export const MAX_EDGE = 1568; // px; longer edges get downscaled to this
const DOMINANT = 0.5; // a block covering more than half the frame…
const HUGE = 2 * MAX_EDGE; // …and longer than this at export scale gets split into its children
const MAX_ASPECT = 3; // crops taller than 3:1 are cut into pieces of at most 2:1
const PIECE_ASPECT = 2;
const MIN_SIDE = 24;
const MAX_SECTIONS = 30;
const MAX_DEPTH = 4;

export function sectionSlug(name) {
  const s = String(name || '')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48)
    .replace(/-+$/, '');
  return s || 'section';
}

/** meta.sections (top-level blocks) → refined list with a file stem each: [{id, name, box, stem}]. */
export function planSections(meta, spec) {
  const list = (meta && meta.sections) || [];
  if (!list.length) return [];
  const byId = new Map();
  (function index(n) {
    if (!n) return;
    byId.set(n.id, n);
    for (const c of n.children || []) index(c);
  })(spec);
  const frameArea = Math.max(1, meta.width * meta.height);
  const scale = meta.scale || 1;
  const out = [];
  const visit = (s, depth) => {
    const node = byId.get(s.id);
    const dominant = (s.box.w * s.box.h) / frameArea > DOMINANT;
    const huge = Math.max(s.box.w, s.box.h) * scale > HUGE;
    if (node && dominant && huge && depth < MAX_DEPTH) {
      let n = node;
      while (n.children && n.children.length === 1) n = n.children[0];
      const kids = (n.children || []).filter((c) => c.box && c.box.w >= MIN_SIDE && c.box.h >= MIN_SIDE);
      if (kids.length >= 2) {
        for (const c of kids) visit({ id: c.id, name: c.name, box: c.box }, depth + 1);
        return;
      }
    }
    out.push({ id: s.id, name: s.name, box: s.box });
  };
  for (const s of list) visit(s, 0);
  return out.slice(0, MAX_SECTIONS).map((s, i) => ({ ...s, stem: `sections/${String(i + 1).padStart(2, '0')}-${sectionSlug(s.name)}` }));
}

const r2 = (n) => Math.round(n * 100) / 100;

/** Crop each planned section out of the screenshot. Returns [{file, buf, id, name, box, px}] (px = pixels per design unit). */
export function cropSections(src, plan, scale) {
  const out = [];
  for (const s of plan) {
    const x = Math.max(0, Math.round(s.box.x * scale));
    const y = Math.max(0, Math.round(s.box.y * scale));
    const w = Math.min(src.width - x, Math.round(s.box.w * scale));
    const h = Math.min(src.height - y, Math.round(s.box.h * scale));
    if (w <= 0 || h <= 0) continue;
    const pieces = h / w > MAX_ASPECT ? Math.ceil(h / (w * PIECE_ASPECT)) : 1;
    const pieceH = Math.ceil(h / pieces);
    for (let k = 0; k < pieces; k++) {
      const py = y + k * pieceH;
      const ph = Math.min(pieceH, y + h - py);
      let img = new PNG({ width: w, height: ph });
      PNG.bitblt(src, img, x, py, w, ph, 0, 0);
      const long = Math.max(w, ph);
      if (long > MAX_EDGE) {
        const f = MAX_EDGE / long;
        img = resize(img, Math.max(1, Math.round(w * f)), Math.max(1, Math.round(ph * f)));
      }
      const box = pieces === 1 ? s.box : { x: s.box.x, y: r2(py / scale), w: s.box.w, h: r2(ph / scale) };
      out.push({
        file: pieces === 1 ? `${s.stem}.png` : `${s.stem}-${k + 1}.png`,
        buf: PNG.sync.write(img),
        id: s.id,
        name: pieces === 1 ? s.name : `${s.name} (${k + 1}/${pieces})`,
        box,
        px: r2(img.width / s.box.w),
      });
    }
  }
  return out;
}
