// Compare a screenshot of the built UI against the Figma export, find where they differ,
// and name the Figma layers in those regions so the agent knows what to fix.
import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { readPng, writePng, crop, resize, flatten, hstack, shrinkMax } from './image.js';

const DIFF_COLOR = [255, 0, 64];
const AA_COLOR = [255, 210, 0];
const PANEL_MAX = 900; // px: max width of each panel in side-by-side.png
const r1 = (n) => Math.round(n * 10) / 10;

export function loadDesign(designDir) {
  const specFile = path.join(designDir, 'spec.json');
  if (!fs.existsSync(specFile)) throw new Error(`${designDir} is not a figma-lens export (no spec.json)`);
  const { meta, spec } = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const screenFile = path.join(designDir, meta.screen);
  if (!fs.existsSync(screenFile)) throw new Error(`missing ${screenFile}`);
  return { meta, spec, screen: readPng(screenFile) };
}

function flattenNodes(node, depth = 0, out = []) {
  out.push({ node, depth });
  for (const c of node.children || []) flattenNodes(c, depth + 1, out);
  return out;
}

function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// Most specific layers covering a region: high overlap relative to the smaller box, deeper first.
function nodesFor(region, nodes) {
  const ra = region.w * region.h;
  return nodes
    .filter(({ depth }) => depth > 0)
    .map(({ node, depth }) => {
      const na = Math.max(1, node.box.w * node.box.h);
      const inter = overlap(region, node.box);
      return { node, depth, score: inter / Math.min(na, ra), area: na };
    })
    .filter((c) => c.score >= 0.5)
    .sort((a, b) => b.score - a.score || b.depth - a.depth || a.area - b.area)
    .slice(0, 3)
    .map(({ node }) => ({ id: node.id, type: node.type, name: node.name, ...(node.text ? { text: node.text.characters.slice(0, 60) } : {}) }));
}

// Group mismatching pixels into rectangles on a coarse grid (cell = N design units).
function findRegions(mask, W, H, scale, cellUnits, frame, nodes) {
  const cellPx = Math.max(1, Math.round(cellUnits * scale));
  const cols = Math.ceil(W / cellPx);
  const rows = Math.ceil(H / cellPx);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / cellPx) * cols;
    for (let x = 0; x < W; x++) if (mask[y * W + x]) counts[row + Math.floor(x / cellPx)]++;
  }
  const hot = (i) => counts[i] / (cellPx * cellPx) > 0.02;
  const seen = new Uint8Array(cols * rows);
  const regions = [];
  for (let i = 0; i < counts.length; i++) {
    if (seen[i] || !hot(i)) continue;
    let minC = cols, minR = rows, maxC = 0, maxR = 0, px = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      const c = j % cols;
      const r = (j - c) / cols;
      minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      px += counts[j];
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const k = nr * cols + nc;
        if (!seen[k] && hot(k)) { seen[k] = 1; stack.push(k); }
      }
    }
    const x = minC * cellUnits, y = minR * cellUnits;
    const box = {
      x, y,
      w: Math.min(frame.w, (maxC + 1) * cellUnits) - x,
      h: Math.min(frame.h, (maxR + 1) * cellUnits) - y,
    };
    const areaPx = Math.max(1, box.w * box.h * scale * scale);
    regions.push({ box, diffPixels: px, mismatchPct: r1((px / areaPx) * 100), nodes: nodesFor(box, nodes) });
  }
  return regions.sort((a, b) => b.diffPixels - a.diffPixels);
}

// How a score was computed, recorded in history.json so the "previous run" trend never compares two
// different metrics. Runs from before this field existed were plain pixel scores.
export const metricFor = (textToleranceUnits) => (textToleranceUnits > 0 ? `text-tolerant-${textToleranceUnits}` : 'pixel');

// Perceived color distance (YIQ, same idea as pixelmatch) between two opaque RGBA pixels.
function colorDelta(a, i, b, j) {
  const dr = a[i] - b[j], dg = a[i + 1] - b[j + 1], db = a[i + 2] - b[j + 2];
  const y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
  const iq = dr * 0.59597799 - dg * 0.2741761 - db * 0.32180189;
  const q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
}

// True when pixel (x,y) of `src` has a close-colored pixel in `other` within `r` px.
function nearMatch(src, other, W, H, x, y, r, maxDelta) {
  const i = (y * W + x) * 4;
  for (let yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r); yy++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++) {
      if (colorDelta(src, i, other, (yy * W + xx) * 4) <= maxDelta) return true;
    }
  }
  return false;
}

const INK_TOLERANCE = 0.25; // text with ±25% more/less ink than the design is a real weight/size/color change

// Total "ink" in a box: how far each pixel is from the box's background color (the most common one).
function inkIn(img, W, b, bg) {
  let ink = 0;
  for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) ink += Math.sqrt(colorDelta(img.data, (y * W + x) * 4, bg, 0));
  return ink;
}

function backgroundOf(img, W, b) {
  const counts = new Map();
  let best = 0, key = 0;
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      const i = (y * W + x) * 4;
      const k = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
      const n = (counts.get(k) || 0) + 1;
      counts.set(k, n);
      if (n > best) { best = n; key = k; }
    }
  }
  return [(key >> 16) & 255, (key >> 8) & 255, key & 255, 255];
}

/**
 * Where font rendering noise may be forgiven. Font rasterizers (Figma vs Chrome/Skia vs Flutter) place
 * glyph edges and hinting differently by a pixel or so; that is noise, not a bug. A TEXT layer only
 * qualifies when both images hold about the same amount of ink in its box; otherwise (bolder/lighter
 * weight, other size, other color) it is compared strictly and returned as a suspect.
 */
function textAreas(nodes, d, a, W, H, scale) {
  const ok = [], bad = [];
  for (const { node } of nodes) {
    if (node.type !== 'TEXT' || !node.box) continue;
    const b = {
      x0: Math.max(0, Math.floor(node.box.x * scale)), y0: Math.max(0, Math.floor(node.box.y * scale)),
      x1: Math.min(W, Math.ceil((node.box.x + node.box.w) * scale)), y1: Math.min(H, Math.ceil((node.box.y + node.box.h) * scale)),
    };
    if (b.x1 <= b.x0 || b.y1 <= b.y0) continue;
    const bg = backgroundOf(d, W, b);
    const inkD = inkIn(d, W, b, bg), inkA = inkIn(a, W, b, bg);
    const ratio = inkD > 0 ? inkA / inkD : inkA > 0 ? Infinity : 1;
    if (Math.abs(ratio - 1) <= INK_TOLERANCE) ok.push(b);
    else bad.push({ b, suspect: { id: node.id, name: node.name, inkRatio: Number.isFinite(ratio) ? r1(ratio) : null } });
  }
  if (!ok.length && !bad.length) return { tolerant: null, inText: null, suspects: [] };
  const fill = (m, b, v) => { for (let y = b.y0; y < b.y1; y++) m.fill(v, y * W + b.x0, y * W + b.x1); };
  const inText = new Uint8Array(W * H);
  for (const b of ok) fill(inText, b, 1);
  for (const { b } of bad) fill(inText, b, 1);
  let tolerant = null;
  if (ok.length) {
    tolerant = new Uint8Array(W * H);
    for (const b of ok) fill(tolerant, b, 1);
    for (const { b } of bad) fill(tolerant, b, 0); // overlapping suspect text stays strict
  }
  return { tolerant, inText, suspects: bad.map((x) => x.suspect) };
}

/**
 * Pure comparison (no files written). Returns images + stats.
 * cropTop/cropBottom are in pixels of the ACTUAL screenshot (e.g. a phone status bar).
 * Text tolerance (EXPERIMENTAL, off by default): with textToleranceUnits > 0, a differing pixel inside a
 * TEXT layer is ignored when the other image has a matching color within that many design units, both
 * ways. Measured on real browser text it removes only about half of subpixel rendering noise and can
 * hide a one-letter change ("Continue" → "Continua"), so it is opt-in and never the default gate.
 * Text suspects (ink ±25%: weight/size/color) and the raw score are reported either way.
 */
export function computeDiff({ designDir, actualFile, cropTop = 0, cropBottom = 0, threshold = 0.1, cellUnits = 8, textToleranceUnits = 0 }) {
  const { meta, spec, screen } = loadDesign(designDir);
  // Pixels per design unit, measured from the image itself (robust if it isn't exactly frame × meta.scale).
  const scale = meta.width ? screen.width / meta.width : meta.scale || 1;
  const design = flatten(screen);
  let actual = flatten(readPng(actualFile));
  if (cropTop || cropBottom) actual = crop(actual, 0, cropTop, actual.width, actual.height - cropTop - cropBottom);

  // Bring the build onto the design's pixel grid: match width, keep aspect ratio.
  const scaledH = Math.max(1, Math.round(actual.height * (design.width / actual.width)));
  actual = resize(actual, design.width, scaledH);

  const W = design.width;
  const H = Math.min(design.height, actual.height);
  const d = H === design.height ? design : crop(design, 0, 0, W, H);
  const a = H === actual.height ? actual : crop(actual, 0, 0, W, H);
  const diff = new PNG({ width: W, height: H });
  const diffPixels = pixelmatch(d.data, a.data, diff.data, W, H, {
    threshold, includeAA: false, alpha: 0.25, diffColor: DIFF_COLOR, aaColor: AA_COLOR,
  });

  const frame = { w: meta.width, h: meta.height };
  const nodes = flattenNodes(spec);
  const { tolerant, inText, suspects } = textAreas(nodes, d, a, W, H, scale);
  const forgive = textToleranceUnits > 0 ? tolerant : null;
  const r = Math.max(1, Math.round(textToleranceUnits * scale));
  // Same color threshold as pixelmatch: only position is forgiven, so a wrong text color still counts.
  const maxDelta = 35215 * threshold * threshold;
  const mask = new Uint8Array(W * H);
  let diffCount = 0, textNoise = 0, textDiff = 0, textPx = 0;
  for (let i = 0, p = 0; p < W * H; i += 4, p++) {
    const isText = inText !== null && inText[p] === 1;
    if (isText) textPx++;
    if (!(diff.data[i] === DIFF_COLOR[0] && diff.data[i + 1] === DIFF_COLOR[1] && diff.data[i + 2] === DIFF_COLOR[2])) continue;
    if (forgive && forgive[p]) {
      const x = p % W, y = (p - x) / W;
      // Both directions: a glyph pixel in Figma has a twin nearby in the build AND vice versa.
      if (nearMatch(d.data, a.data, W, H, x, y, r, maxDelta) && nearMatch(a.data, d.data, W, H, x, y, r, maxDelta)) {
        textNoise++;
        diff.data.set(AA_COLOR, i); // diff.png: red = counted, amber = forgiven rendering noise
        continue;
      }
    }
    if (isText) textDiff++;
    mask[p] = 1;
    diffCount++;
  }
  const regions = findRegions(mask, W, H, scale, cellUnits, frame, nodes);

  const sections = (meta.sectionFiles || []).map((s) => {
    let px = 0, total = 0;
    const x0 = Math.max(0, Math.round(s.box.x * scale)), y0 = Math.max(0, Math.round(s.box.y * scale));
    const x1 = Math.min(W, Math.round((s.box.x + s.box.w) * scale)), y1 = Math.min(H, Math.round((s.box.y + s.box.h) * scale));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { total++; px += mask[y * W + x]; }
    return { name: s.name, file: s.file, mismatchPct: total ? r1((px / total) * 100) : null, compared: total > 0 };
  });

  return {
    meta,
    design: d,
    actual: a,
    diff,
    stats: {
      metric: metricFor(textToleranceUnits),
      mismatchPct: r1((diffCount / (W * H)) * 100),
      diffPixels: diffCount,
      rawMismatchPct: r1((diffPixels / (W * H)) * 100), // plain pixelmatch, before text tolerance
      text: {
        pixels: textPx,
        mismatchPct: textPx ? r1((textDiff / textPx) * 100) : null, // real text differences, % of text area
        ignoredNoisePx: textNoise,
        suspects, // text layers whose ink differs a lot: weight, size or color (compared strictly)
      },
      comparedPx: { w: W, h: H },
      heightDelta: r1((actual.height - design.height) / scale), // design units; + = build is taller
      regions,
      sections,
    },
  };
}

export const TARGET_PCT = 3; // mismatch % at or under this is done
export const MIN_GAIN = 0.2; // percentage points: a smaller change than this against the session's best is "flat"
export const MAX_CHECKS = 6; // checks per Claude session; the 6th check always stops
const EPS = 1e-9; // so a change of exactly MIN_GAIN counts (3.3 - 0.2 is 3.0999999999999996 in JS)

const improvedOn = (best, pct) => pct <= best - MIN_GAIN + EPS;
const worseThan = (best, pct) => pct >= best + MIN_GAIN - EPS;

/**
 * Whether another fix-and-check round is worth it, judged against this session's earlier checks
 * (`earlier`: their mismatch % in order, oldest first; `best` is the lowest of them). Rules, in order:
 * target (≤ TARGET_PCT) → STOP; first check → CONTINUE; MAX_CHECKS reached → STOP "limit";
 * improved on best by MIN_GAIN → CONTINUE; worse than best by MIN_GAIN → CONTINUE "regressed"
 * (undo the last change); otherwise flat → STOP "plateau" on the 2nd non-improving check in a row.
 * A worse check counts as non-improving but never stops on its own: stopping there would finish
 * with a worse screen than the session already had.
 * { stop: boolean, why: 'target' | 'plateau' | 'regressed' | 'limit' | null, text, best }
 */
export function verdictFor(mismatchPct, earlier = []) {
  let best = null;
  let streak = 0; // non-improving (worse or flat) checks in a row
  for (const pct of earlier) {
    if (best == null || improvedOn(best, pct)) streak = 0;
    else streak++;
    best = best == null ? pct : Math.min(best, pct);
  }
  const v = (stop, why, text) => ({ stop, why, text, best });
  if (mismatchPct <= TARGET_PCT) return v(true, 'target', `STOP: ${mismatchPct}% is within the ${TARGET_PCT}% target. Finish and write the report.`);
  if (best == null) return v(false, null, 'CONTINUE: fix the biggest differences below, then check again.');
  if (earlier.length + 1 >= MAX_CHECKS) {
    return v(true, 'limit', worseThan(best, mismatchPct)
      ? `STOP: check limit reached (${MAX_CHECKS} checks), and the current code (${mismatchPct}%) is worse than your best result (${best}%). Restore the version that scored ${best}% before finishing (do not check again), then report what still differs and why.`
      : `STOP: check limit reached (${MAX_CHECKS} checks; now ${mismatchPct}%, best ${best}%). Do not check again; report what still differs and why.`);
  }
  if (improvedOn(best, mismatchPct)) return v(false, null, `CONTINUE: improved on your best (${best}% → ${mismatchPct}%). Fix the biggest differences below, then check again.`);
  if (worseThan(best, mismatchPct)) return v(false, 'regressed', `CONTINUE: your last change made it worse (best ${best}%, now ${mismatchPct}%). Undo that change, then check again.`);
  if (streak + 1 >= 2) return v(true, 'plateau', `STOP: no real improvement in the last 2 checks (best ${best}%, now ${mismatchPct}%). Further rounds are unlikely to help; report what still differs and why.`);
  return v(false, null, `CONTINUE: about the same as your best (${best}%, now ${mismatchPct}%). Try a different fix for the biggest differences below, then check again.`);
}

function reportMarkdown(meta, stats, files, prev, verdict) {
  const out = [];
  out.push(`# Compare: ${meta.nodeName}`);
  out.push('');
  const trend = prev != null || verdict.best != null
    ? ` (${[prev != null ? `previous run ${prev}%` : '', verdict.best != null ? `best this session ${verdict.best}%` : ''].filter(Boolean).join(', ')})`
    : '';
  out.push(`**Mismatch: ${stats.mismatchPct}%** of compared pixels${trend}. Target: under 2–3% (text anti-aliasing never reaches 0).`);
  out.push('');
  out.push(`**Verdict: ${verdict.text}**`);
  out.push('');
  if (stats.text.pixels) {
    out.push(stats.text.ignoredNoisePx
      ? `Text: ${stats.text.mismatchPct}% of the text area differs after ignoring ${stats.text.ignoredNoisePx} px of glyph rendering noise ` +
        `(experimental --text-tolerance; it can also hide one-letter changes). The plain pixel diff is ${stats.rawMismatchPct}%.`
      : `Text: ${stats.text.mismatchPct}% of the text area differs.`);
    for (const s of stats.text.suspects.slice(0, 8)) {
      const how = s.inkRatio == null ? 'has text only in the build' : s.inkRatio > 1 ? `has ${s.inkRatio}× the ink (heavier/bigger/darker)` : `has ${s.inkRatio}× the ink (lighter/smaller/paler or missing)`;
      out.push(`- ⚠ \`${s.id}\` "${s.name}" ${how} — check font weight, size and color in spec.md`);
    }
    out.push('');
  }
  out.push(`Images: \`${files.sideBySide}\` (Figma | build | diff) and \`${files.diff}\` (red = different${stats.text.ignoredNoisePx ? ', amber = ignored as font rendering noise' : ''}).`);
  if (Math.abs(stats.heightDelta) >= 2) {
    out.push('');
    out.push(`⚠ The build is **${Math.abs(stats.heightDelta)} units ${stats.heightDelta > 0 ? 'taller' : 'shorter'}** than the frame (${meta.width}×${meta.height}). ` +
      'Only the overlapping height was compared. Check vertical spacing/padding and font line heights first — they shift everything below.');
  }
  out.push('');
  if (stats.sections.some((s) => s.compared)) {
    out.push('## By section');
    for (const s of stats.sections) out.push(`- ${s.name}: ${s.compared ? s.mismatchPct + '%' : 'not compared (outside the build height)'}`);
    out.push('');
  }
  out.push('## Biggest differences (fix top-down)');
  if (!stats.regions.length) out.push('- none above the noise floor 🎉');
  stats.regions.slice(0, 12).forEach((r, i) => {
    const b = r.box;
    const where = r.nodes.length
      ? r.nodes.map((n) => `\`${n.id}\` ${n.type} "${n.name}"${n.text ? ` ("${n.text}")` : ''}`).join(', ')
      : 'no single layer (background / spacing)';
    out.push(`${i + 1}. area ${b.x},${b.y} ${b.w}×${b.h} — ${r.mismatchPct}% different — layers: ${where}`);
  });
  out.push('');
  out.push('Next: open the side-by-side image, look up each listed layer id in spec.md, fix the code, re-run the check.');
  out.push('');
  return out.join('\n');
}

/** Compare and write diff.png, side-by-side.png, report.json, report.md and history.json. */
export function compare(opts) {
  const outDir = opts.outDir || path.join(opts.designDir, 'compare');
  const { meta, design, actual, diff, stats } = computeDiff(opts);
  fs.mkdirSync(outDir, { recursive: true });
  const files = { diff: path.join(outDir, 'diff.png'), sideBySide: path.join(outDir, 'side-by-side.png') };
  // The score above comes from the full-resolution diff. These two images are only for looking at,
  // so they are written fast, and the side-by-side panels are kept at most PANEL_MAX wide
  // (a full 2x page was a 7744×10090 image: ~30 s to write, and viewers shrink it anyway).
  writePng(files.diff, diff, { fast: true });
  const factor = Math.max(1, Math.ceil(design.width / PANEL_MAX));
  const panels = factor > 1
    ? [resize(design, Math.round(design.width / factor), Math.round(design.height / factor)),
       resize(actual, Math.round(actual.width / factor), Math.round(actual.height / factor)),
       shrinkMax(diff, factor)]
    : [design, actual, diff];
  writePng(files.sideBySide, hstack(panels, { bar: 8, barColors: [[91, 91, 214, 255], [31, 35, 40, 255], [255, 0, 64, 255]] }), { fast: true });

  const historyFile = path.join(outDir, 'history.json');
  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch { history = []; }
  if (!Array.isArray(history)) history = [];
  // Only a run scored the same way is a fair "previous".
  const last = history.length ? history[history.length - 1] : null;
  const prev = last && (last.metric || 'pixel') === stats.metric ? last.mismatchPct : null;
  // The verdict judges only checks from the same Claude session (auto mode sets FIGMA_LENS_RUN per
  // session), so a retry's first check is not stopped by the last attempt's scores. Without a run id
  // there is no session to judge against: manual checks pile up across days and would hit MAX_CHECKS.
  const run = opts.runId !== undefined ? opts.runId : process.env.FIGMA_LENS_RUN || null;
  const earlier = run
    ? history.filter((h) => h && h.run === run && (h.metric || 'pixel') === stats.metric && typeof h.mismatchPct === 'number').map((h) => h.mismatchPct)
    : [];
  const verdict = verdictFor(stats.mismatchPct, earlier);
  history.push({ at: new Date().toISOString(), metric: stats.metric, mismatchPct: stats.mismatchPct, rawMismatchPct: stats.rawMismatchPct, actual: path.resolve(opts.actualFile), ...(run ? { run } : {}) });
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 1));

  const report = { frame: meta.nodeName, ...stats, files, previousMismatchPct: prev, bestMismatchPct: verdict.best, verdict };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(outDir, 'report.md'), reportMarkdown(meta, stats, files, prev, verdict));
  return { ...report, reportFile: path.join(outDir, 'report.md') };
}
