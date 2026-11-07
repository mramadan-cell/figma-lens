// figma-lens parity: compare two exports of the same frame (e.g. the desktop plugin's and the browser's)
// field by field: layer tree, tokens, icon/image files (by content) and the frame preview (pixels).
// Answers "is the browser export as accurate as the desktop plugin?" with evidence, not a feeling.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

// Differences that say nothing about accuracy.
const VOLATILE_META = new Set(['exportedAt', 'version', 'warnings', 'sectionPlan', 'sectionFiles', 'assetRenames', 'css', 'prototype', 'fileKey']);

function load(dir) {
  const specFile = path.join(dir, 'spec.json');
  if (!fs.existsSync(specFile)) throw new Error(`${dir} is not a figma-lens export (no spec.json)`);
  const { meta, spec } = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  let tokens = {};
  try {
    tokens = JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8'));
  } catch {
    // older exports
  }
  const files = [];
  for (const sub of ['assets', 'images']) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      const buf = fs.readFileSync(path.join(d, f));
      files.push({ path: `${sub}/${f}`, hash: crypto.createHash('sha1').update(buf).digest('hex'), size: buf.length });
    }
  }
  return { dir, meta, spec, tokens, files };
}

function nodesById(spec) {
  const m = new Map();
  const walk = (n) => {
    m.set(n.id, n);
    for (const c of n.children || []) walk(c);
  };
  walk(spec);
  return m;
}

const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x));

// An asset path differs between versions only by its name (asset naming changed); files are compared by content.
const assetRef = (v) => (typeof v === 'string' && /^(assets|images)\//.test(v) ? 'file' : v);
function normalize(key, v) {
  if (key === 'asset' || key === 'image') return assetRef(v);
  if (key === 'fills' || key === 'stroke') return JSON.parse(JSON.stringify(v === undefined ? null : v), (k, x) => (k === 'image' || k === 'asset' ? assetRef(x) : x));
  return v;
}

function pixelDiff(a, b) {
  const fa = path.join(a.dir, a.meta.screen || '');
  const fb = path.join(b.dir, b.meta.screen || '');
  if (!a.meta.screen || !b.meta.screen || !fs.existsSync(fa) || !fs.existsSync(fb)) return { skipped: 'frame preview missing in one export' };
  let pa;
  let pb;
  try {
    pa = PNG.sync.read(fs.readFileSync(fa));
    pb = PNG.sync.read(fs.readFileSync(fb));
  } catch (e) {
    return { skipped: `frame preview unreadable (${e.message})` };
  }
  if (pa.width !== pb.width || pa.height !== pb.height) return { skipped: `different preview sizes ${pa.width}×${pa.height} vs ${pb.width}×${pb.height}` };
  const n = pixelmatch(pa.data, pb.data, null, pa.width, pa.height, { threshold: 0.1 });
  return { width: pa.width, height: pa.height, diffPixels: n, mismatchPct: +((100 * n) / (pa.width * pa.height)).toFixed(3) };
}

/** Compare two export folders. Returns a structured report; `same` is true when nothing that matters differs. */
export function parity(dirA, dirB, { examples = 12 } = {}) {
  const a = load(dirA);
  const b = load(dirB);
  const r = { a: { dir: a.dir, version: a.meta.version, nodeCount: a.meta.nodeCount }, b: { dir: b.dir, version: b.meta.version, nodeCount: b.meta.nodeCount } };

  r.meta = [];
  r.versionOnly = []; // a field one figma-lens version writes and the other doesn't: not an accuracy difference
  const otherVersion = a.meta.version !== b.meta.version;
  for (const k of new Set([...Object.keys(a.meta), ...Object.keys(b.meta)])) {
    if (VOLATILE_META.has(k)) continue;
    if (stable(a.meta[k]) === stable(b.meta[k])) continue;
    if (otherVersion && (a.meta[k] === undefined || b.meta[k] === undefined)) r.versionOnly.push(k);
    else r.meta.push({ key: k, a: a.meta[k], b: b.meta[k] });
  }

  const na = nodesById(a.spec);
  const nb = nodesById(b.spec);
  r.layers = { a: na.size, b: nb.size, onlyA: [...na.keys()].filter((id) => !nb.has(id)), onlyB: [...nb.keys()].filter((id) => !na.has(id)) };
  const byField = new Map();
  const css = { a: 0, b: 0, differ: 0 };
  for (const [id, x] of na) {
    const y = nb.get(id);
    if (!y) continue;
    if (x.css && !y.css) css.a++;
    else if (!x.css && y.css) css.b++;
    else if (x.css && stable(x.css) !== stable(y.css)) css.differ++;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (k === 'children' || k === 'css') continue;
      if (stable(normalize(k, x[k])) === stable(normalize(k, y[k]))) continue;
      const list = byField.get(k) || [];
      list.push({ id, name: x.name, a: x[k], b: y[k] });
      byField.set(k, list);
    }
  }
  r.fields = [...byField.entries()].map(([key, list]) => ({ key, count: list.length, examples: list.slice(0, examples) })).sort((p, q) => q.count - p.count);
  r.css = css;

  const keys = (o) => Object.keys(o || {});
  const tokenDiff = (kind) => {
    const ta = a.tokens[kind] || {};
    const tb = b.tokens[kind] || {};
    const onlyA = keys(ta).filter((k) => !(k in tb));
    const onlyB = keys(tb).filter((k) => !(k in ta));
    const differ = keys(ta).filter((k) => k in tb && stable(ta[k]) !== stable(tb[k]));
    return { a: keys(ta).length, b: keys(tb).length, onlyA, onlyB, differ };
  };
  r.tokens = { variables: tokenDiff('variables'), styles: tokenDiff('styles') };

  const ha = new Map(a.files.map((f) => [f.hash, f]));
  const hb = new Map(b.files.map((f) => [f.hash, f]));
  r.files = {
    a: a.files.length,
    b: b.files.length,
    sameContent: [...ha.keys()].filter((h) => hb.has(h)).length,
    onlyA: [...ha.values()].filter((f) => !hb.has(f.hash)).map((f) => f.path),
    onlyB: [...hb.values()].filter((f) => !ha.has(f.hash)).map((f) => f.path),
  };
  r.preview = pixelDiff(a, b);

  const t = r.tokens;
  r.same = !r.meta.length && !r.layers.onlyA.length && !r.layers.onlyB.length && !r.fields.length
    && !t.variables.onlyA.length && !t.variables.onlyB.length && !t.variables.differ.length
    && !t.styles.onlyA.length && !t.styles.onlyB.length && !t.styles.differ.length
    && !r.files.onlyA.length && !r.files.onlyB.length
    && (r.preview.mismatchPct === undefined || r.preview.mismatchPct < 0.1);
  return r;
}

const short = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? '(none)' : s.length > 90 ? s.slice(0, 87) + '…' : s;
};

/** Human report lines. */
export function parityLines(r, c) {
  const out = [];
  out.push(c.bold('figma-lens parity'));
  out.push(`A: ${r.a.dir} ${c.gray(`(figma-lens ${r.a.version}, ${r.a.nodeCount} layers)`)}`);
  out.push(`B: ${r.b.dir} ${c.gray(`(figma-lens ${r.b.version}, ${r.b.nodeCount} layers)`)}`);
  if (r.a.version !== r.b.version) out.push(c.yellow('⚠ different figma-lens versions: some differences below can come from the version, not from desktop vs browser'));
  const ok = (good, text) => out.push(`${good ? c.green('✔') : c.red('✖')} ${text}`);
  ok(!r.meta.length, `frame info${r.meta.length ? ': ' + r.meta.map((m) => `${m.key} ${short(m.a)} vs ${short(m.b)}`).join('; ') : ' (id, name, size, page, layer count) identical'}`);
  if (r.versionOnly.length) out.push(`${c.gray('•')} written by only one of the two versions (ignored): ${r.versionOnly.join(', ')}`);
  ok(!r.layers.onlyA.length && !r.layers.onlyB.length, `layers: ${r.layers.a} vs ${r.layers.b}${r.layers.onlyA.length ? `, only in A: ${r.layers.onlyA.slice(0, 8).join(', ')}` : ''}${r.layers.onlyB.length ? `, only in B: ${r.layers.onlyB.slice(0, 8).join(', ')}` : ''}`);
  ok(!r.fields.length, r.fields.length ? `layer properties differ in ${r.fields.reduce((s, f) => s + f.count, 0)} place(s):` : 'every layer property identical (position, size, layout, fills, strokes, effects, text, variables, components, links)');
  for (const f of r.fields) {
    out.push(`    ${c.bold(f.key)} ×${f.count}`);
    for (const e of f.examples.slice(0, 3)) out.push(c.gray(`      ${e.id} "${e.name}": ${short(e.a)} → ${short(e.b)}`));
  }
  const cs = r.css;
  out.push(`${c.gray('•')} CSS (extra, version dependent): ${cs.differ} differ${cs.a ? `, ${cs.a} only in A` : ''}${cs.b ? `, ${cs.b} only in B` : ''}`);
  for (const kind of ['variables', 'styles']) {
    const t = r.tokens[kind];
    ok(!t.onlyA.length && !t.onlyB.length && !t.differ.length, `${kind}: ${t.a} vs ${t.b}${t.differ.length ? `, ${t.differ.length} differ (${t.differ.slice(0, 5).join(', ')})` : ''}${t.onlyA.length ? `, only in A: ${t.onlyA.slice(0, 5).join(', ')}` : ''}${t.onlyB.length ? `, only in B: ${t.onlyB.slice(0, 5).join(', ')}` : ''}`);
  }
  const f = r.files;
  ok(!f.onlyA.length && !f.onlyB.length, `icons/images: ${f.a} vs ${f.b}, ${f.sameContent} identical by content${f.onlyA.length ? `, only in A: ${f.onlyA.slice(0, 5).join(', ')}` : ''}${f.onlyB.length ? `, only in B: ${f.onlyB.slice(0, 5).join(', ')}` : ''}`);
  if (r.preview.skipped) out.push(`${c.yellow('•')} frame preview: not compared (${r.preview.skipped})`);
  else ok(r.preview.mismatchPct < 0.1, `frame preview ${r.preview.width}×${r.preview.height}: ${r.preview.mismatchPct}% pixels differ`);
  out.push(r.same ? c.green(c.bold('\nSAME: the two exports carry the same design data.')) : c.yellow(c.bold('\nDIFFERENT: see the ✖ lines above.')));
  return out;
}
