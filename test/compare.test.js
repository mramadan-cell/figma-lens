import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blank, writePng, readPng, resize } from '../tools/image.js';
import { compare, computeDiff, verdictFor } from '../tools/compare.js';
import { initMap, loadMap, componentTarget, tokenTarget } from '../tools/map.js';
import { makeDemo } from '../tools/demo.js';
import { renderMarkdown, summarizeUsage } from '../bridge/render-md.js';

const CLI = fileURLToPath(new URL('../bin/figma-lens.js', import.meta.url));
const BLUE = [91, 91, 214, 255];

// Frame 200×100 design units, exported at 2x. A blue "Card" at 20,20 60×30.
function drawScreen({ scale = 2, cardX = 20, extraTop = 0, extraBottom = 0, w = 200, h = 100 } = {}) {
  const img = blank(w * scale, h * scale + extraTop + extraBottom);
  if (extraTop) for (let y = 0; y < extraTop; y++) for (let x = 0; x < img.width; x++) img.data.set([40, 40, 40, 255], (y * img.width + x) * 4);
  for (let y = 20 * scale; y < 50 * scale; y++) {
    for (let x = cardX * scale; x < (cardX + 60) * scale; x++) img.data.set(BLUE, ((y + extraTop) * img.width + x) * 4);
  }
  return img;
}

function makeExport(root, name = 'card-screen') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    tool: 'figma-lens', nodeName: 'Card Screen', nodeId: '1:1', file: 'f', page: 'p', nodeType: 'FRAME', version: '0.2.0',
    width: 200, height: 100, scale: 2, screen: 'screen@2x.png', exportedAt: '2026-11-04T00:00:00.000Z', warnings: [],
    sectionFiles: [{ file: 'sections/01-card.png', id: '1:5', name: 'Card', box: { x: 20, y: 20, w: 60, h: 30 } }],
  };
  const spec = {
    id: '1:1', name: 'Card Screen', type: 'FRAME', box: { x: 0, y: 0, w: 200, h: 100 }, fills: [{ type: 'solid', color: '#FFFFFF' }],
    children: [
      { id: '1:5', name: 'Card', type: 'INSTANCE', box: { x: 20, y: 20, w: 60, h: 30 }, rel: { x: 20, y: 20 },
        fills: [{ type: 'solid', color: '#5B5BD6', var: 'color/primary' }], component: { name: 'Card', variant: 'Style=Filled' } },
      { id: '1:6', name: 'Icon', type: 'INSTANCE', box: { x: 150, y: 20, w: 24, h: 24 }, rel: { x: 150, y: 20 },
        component: { name: 'Icon/Bell' }, asset: 'assets/icon-bell.svg' },
      { id: '1:7', name: 'Badge', type: 'INSTANCE', box: { x: 150, y: 60, w: 30, h: 16 }, rel: { x: 150, y: 60 }, component: { name: 'Badge' } },
    ],
  };
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ meta, spec }));
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({
    variables: { Colors: { modes: ['Light'], vars: { 'color/primary': { type: 'COLOR', values: { Light: '#5B5BD6' } } } } },
    styles: {},
  }));
  writePng(path.join(dir, 'screen@2x.png'), drawScreen());
  return dir;
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'figma-lens-cmp-'));
}

test('identical build at a different pixel density is ~0% different', () => {
  const root = tmp();
  const dir = makeExport(root);
  const shot = path.join(root, 'shot1x.png');
  writePng(shot, drawScreen({ scale: 1 }));
  const { stats } = computeDiff({ designDir: dir, actualFile: shot });
  assert.ok(stats.mismatchPct < 1, `mismatch ${stats.mismatchPct}%`);
  assert.equal(stats.heightDelta, 0);
});

test('a shifted element is found and named by its Figma layer', () => {
  const root = tmp();
  const dir = makeExport(root);
  const shot = path.join(root, 'shifted.png');
  writePng(shot, drawScreen({ cardX: 40 }));
  const r = compare({ designDir: dir, actualFile: shot });
  assert.ok(r.mismatchPct > 2, `mismatch ${r.mismatchPct}%`);
  const named = r.regions.flatMap((g) => g.nodes.map((n) => n.id));
  assert.ok(named.includes('1:5'), `regions name ${JSON.stringify(named)}`);
  assert.ok(r.sections[0].mismatchPct > 10);
  for (const f of ['diff.png', 'side-by-side.png', 'report.json', 'report.md', 'history.json']) {
    assert.ok(fs.existsSync(path.join(dir, 'compare', f)), f);
  }
  const md = fs.readFileSync(path.join(dir, 'compare', 'report.md'), 'utf8');
  assert.match(md, /`1:5` INSTANCE "Card"/);
  // second run remembers the previous score (progress tracking for the fix loop)
  writePng(shot, drawScreen());
  const r2 = compare({ designDir: dir, actualFile: shot });
  assert.equal(r2.previousMismatchPct, r.mismatchPct);
  assert.ok(r2.mismatchPct < 1);
});

test('status bar crop and a taller build are handled', () => {
  const root = tmp();
  const dir = makeExport(root);
  const withBar = path.join(root, 'bar.png');
  writePng(withBar, drawScreen({ extraTop: 48 }));
  assert.ok(computeDiff({ designDir: dir, actualFile: withBar, cropTop: 48 }).stats.mismatchPct < 0.5);

  const taller = path.join(root, 'taller.png');
  writePng(taller, drawScreen({ extraBottom: 60 }));
  const r = compare({ designDir: dir, actualFile: taller });
  assert.equal(r.heightDelta, 30);
  assert.match(fs.readFileSync(r.reportFile, 'utf8'), /30 units taller/);
});

// Fake text: glyph-like stems with anti-aliased edges at (20,60) design units, 2x. `shift` moves the
// whole run by N device pixels, `edge` is the AA edge value, `stem`/`pitch` change the "font".
function drawText(img, { shift = 0, edge = 140, stem = 4, pitch = 10, ink = [17, 17, 17], x = 20, y = 60 } = {}) {
  const px = (xx, yy, v) => img.data.set(v, (yy * img.width + xx) * 4);
  const mix = (t) => ink.map((c, k) => Math.round(c * t + 255 * (1 - t))).concat(255);
  for (let g = 0; g < 12; g++) {
    const x0 = x * 2 + 4 + g * pitch + shift;
    for (let yy = y * 2 + 6; yy < y * 2 + 26; yy++) {
      px(x0 - 1, yy, mix(1 - edge / 255));
      for (let k = 0; k < stem; k++) px(x0 + k, yy, mix(1));
      px(x0 + stem, yy, mix(1 - edge / 255));
    }
  }
  return img;
}

function addTextLayer(dir) {
  const file = path.join(dir, 'spec.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.spec.children.push({ id: '1:9', name: 'Label', type: 'TEXT', box: { x: 20, y: 60, w: 70, h: 16 }, rel: { x: 20, y: 60 },
    text: { characters: 'Hello world', font: 'Inter', size: 14 } });
  fs.writeFileSync(file, JSON.stringify(j));
}

function textCase(actualOpts) {
  const root = tmp();
  const dir = makeExport(root);
  addTextLayer(dir);
  writePng(path.join(dir, 'screen@2x.png'), drawText(drawScreen()));
  const shot = path.join(root, 'build.png');
  writePng(shot, drawText(drawScreen(), actualOpts));
  return { dir, shot };
}

test('text tolerance is opt-in: strict by default, glyph jitter ignored only with textToleranceUnits', () => {
  // Glyphs 1px off and half a unit heavier with other edge anti-aliasing (ink within 25%). pixelmatch
  // alone flags it (its AA check only covers 1px edge shifts). Synthetic: real fonts behave worse, see README.
  const { dir, shot } = textCase({ shift: 1, stem: 5, edge: 200 });
  const strict = computeDiff({ designDir: dir, actualFile: shot }).stats;
  assert.equal(strict.metric, 'pixel');
  assert.equal(strict.mismatchPct, strict.rawMismatchPct);
  assert.ok(strict.mismatchPct > 0.2, `strict ${strict.mismatchPct}%`);
  assert.equal(strict.text.ignoredNoisePx, 0);
  assert.deepEqual(strict.text.suspects, []);

  const { stats } = computeDiff({ designDir: dir, actualFile: shot, textToleranceUnits: 1 });
  assert.equal(stats.metric, 'text-tolerant-1');
  assert.equal(stats.rawMismatchPct, strict.rawMismatchPct);
  assert.ok(stats.mismatchPct < 0.1, `tolerant ${stats.mismatchPct}%`);
  assert.ok(stats.text.ignoredNoisePx > 0);
  assert.equal(stats.regions.length, 0, JSON.stringify(stats.regions));
});

test('real text differences still count: wrong font metrics, wrong color, moved label', () => {
  for (const [why, opts] of [
    ['wider font', { stem: 6, pitch: 13 }],
    ['wrong color', { ink: [150, 150, 150] }],
    ['moved 10 units', { y: 70 }],
    ['bolder weight, same advance', { stem: 6 }],
  ]) {
    // even with the tolerance on
    const { dir, shot } = textCase(opts);
    const r = compare({ designDir: dir, actualFile: shot, textToleranceUnits: 1 });
    assert.ok(r.mismatchPct > 0.2, `${why}: ${r.mismatchPct}%`);
    assert.ok(r.text.mismatchPct > 3, `${why}: text ${r.text.mismatchPct}%`);
    const named = r.regions.flatMap((g) => g.nodes.map((n) => n.id));
    assert.ok(named.includes('1:9'), `${why}: regions name ${JSON.stringify(named)}`);
  }
  // A heavier weight is reported as a suspect with its ink ratio.
  const { dir, shot } = textCase({ stem: 6 });
  const r = compare({ designDir: dir, actualFile: shot });
  assert.deepEqual(r.text.suspects.map((s) => s.id), ['1:9']);
  assert.ok(r.text.suspects[0].inkRatio > 1.25);
  assert.match(fs.readFileSync(r.reportFile, 'utf8'), /`1:9` "Label" has [\d.]+× the ink \(heavier/);
});

test('previous-run trend only compares runs scored with the same metric', () => {
  const { dir, shot } = textCase({ shift: 1 });
  fs.mkdirSync(path.join(dir, 'compare'), { recursive: true });
  // an entry from before metrics were recorded was a plain pixel score
  fs.writeFileSync(path.join(dir, 'compare', 'history.json'), JSON.stringify([{ at: 'x', mismatchPct: 9.9 }]));
  assert.equal(compare({ designDir: dir, actualFile: shot }).previousMismatchPct, 9.9);
  // switching the tolerance on starts a new trend instead of comparing two metrics
  assert.equal(compare({ designDir: dir, actualFile: shot, textToleranceUnits: 1 }).previousMismatchPct, null);
  const second = compare({ designDir: dir, actualFile: shot, textToleranceUnits: 1 });
  assert.equal(second.previousMismatchPct, second.mismatchPct);
  const history = JSON.parse(fs.readFileSync(path.join(dir, 'compare', 'history.json'), 'utf8'));
  assert.deepEqual(history.map((h) => h.metric), [undefined, 'pixel', 'text-tolerant-1', 'text-tolerant-1']);
});

test('resize keeps solid colors exact', () => {
  const img = blank(10, 10, [10, 20, 30, 255]);
  const out = resize(img, 25, 25);
  assert.deepEqual([...out.data.slice(0, 4)], [10, 20, 30, 255]);
});

test('component map: init, lookup (exact + wildcard), and spec.md annotations', () => {
  const root = tmp();
  const design = path.join(root, 'design');
  const dir = makeExport(design);
  const mapFile = path.join(root, 'figma-lens.map.json');

  const r = initMap({ designRoot: design, mapFile });
  assert.deepEqual(r.added.components.sort(), ['Badge', 'Card', 'Icon/Bell']);
  assert.deepEqual(r.added.tokens, ['color/primary']);

  // Real order: `map` already wrote "Icon/Bell": "" — the user then adds a wildcard and leaves it.
  const raw = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  assert.deepEqual(raw.components['Icon/Bell'], { flutter: '', web: '', props: {} });
  raw.components.Card = { flutter: 'lib/widgets/app_card.dart#AppCard', web: '', props: { Style: 'variant' } };
  raw.components['Icon/*'] = "SvgPicture.asset('assets/icons/<name>.svg')";
  raw.tokens['color/primary'] = { flutter: 'AppColors.primary', web: 'var(--primary)' };
  fs.writeFileSync(mapFile, JSON.stringify(raw));

  // re-running init keeps hand-written values
  initMap({ designRoot: design, mapFile });
  const map = loadMap(mapFile);
  assert.equal(componentTarget(map, 'Card').flutter, 'lib/widgets/app_card.dart#AppCard');
  assert.match(componentTarget(map, 'Icon/Bell'), /SvgPicture/);
  assert.equal(componentTarget(map, 'Badge'), null);
  assert.equal(tokenTarget(map, 'color/primary').flutter, 'AppColors.primary');

  const { meta, spec } = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
  const tokens = JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8'));
  const md = renderMarkdown({ meta, spec, tokens }, summarizeUsage(spec), map);
  assert.match(md, /component Card \{Style=Filled\} ⇒ USE flutter: lib\/widgets\/app_card\.dart#AppCard · props Style→variant/);
  assert.match(md, /component Badge ⇒ \(not in map\)/);
  assert.match(md, /#5B5BD6 \(color\/primary ⇒ flutter: AppColors\.primary · web: var\(--primary\)\)/);
  assert.match(md, /\*\*Not mapped yet:\*\* Badge ×1/);
  // without a map, spec.md says how to create one and has no arrows
  const plain = renderMarkdown({ meta, spec, tokens }, summarizeUsage(spec), null);
  assert.match(plain, /No `figma-lens\.map\.json` found/);
  assert.doesNotMatch(plain, /⇒/);
});

test('demo builds a GIF and a before/after image', () => {
  const root = tmp();
  const dir = makeExport(root);
  const before = path.join(root, 'before.png');
  const after = path.join(root, 'after.png');
  writePng(before, drawScreen({ cardX: 50 }));
  writePng(after, drawScreen());
  const r = makeDemo({ designDir: dir, before, after });
  assert.equal(fs.readFileSync(r.gif).subarray(0, 6).toString(), 'GIF89a');
  assert.ok(r.beforePct > r.afterPct);
  assert.ok(readPng(r.png).height > 0);
});

test('CLI: help, compare --fail-above exit code, render with map', () => {
  const root = tmp();
  const design = path.join(root, 'design');
  const dir = makeExport(design);
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: root });

  const help = run('help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /figma-lens check/);

  const shot = path.join(root, 'shifted.png');
  writePng(shot, drawScreen({ cardX: 40 }));
  const failing = run('compare', '--design', dir, '--actual', shot, '--fail-above', '1');
  assert.equal(failing.status, 1, failing.stderr);
  assert.match(failing.stdout, /Card Screen: [\d.]+% different/);

  assert.equal(run('map', '--design', design).status, 0);
  assert.ok(fs.existsSync(path.join(root, 'figma-lens.map.json')));
  const rendered = run('render', dir);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'spec.md'), 'utf8'), /## Component map/);

  const bad = run('compare', '--design', path.join(root, 'nope'), '--actual', shot);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /not a figma-lens export/);
});

test('verdict: "no improvement" only against a check from the same Claude session', () => {
  const root = tmp();
  const dir = makeExport(root);
  const shot = path.join(root, 'off.png');
  writePng(shot, drawScreen({ cardX: 80 }));
  const a1 = compare({ designDir: dir, actualFile: shot, runId: 'a' });
  assert.ok(a1.mismatchPct > 3, `mismatch ${a1.mismatchPct}%`);
  assert.equal(a1.verdict.stop, false);
  assert.equal(a1.bestMismatchPct, null);
  const a2 = compare({ designDir: dir, actualFile: shot, runId: 'a' });
  assert.equal(a2.verdict.stop, false, 'one flat check is not a plateau yet');
  assert.equal(a2.bestMismatchPct, a1.mismatchPct);
  const a3 = compare({ designDir: dir, actualFile: shot, runId: 'a' });
  assert.deepEqual([a3.verdict.stop, a3.verdict.why], [true, 'plateau'], 'same session, 2 flat checks in a row: stop');
  const md = fs.readFileSync(path.join(dir, 'compare', 'report.md'), 'utf8');
  assert.ok(md.includes(`**Verdict: ${a3.verdict.text}**`), 'report.md shows the same verdict text as the console');
  const b1 = compare({ designDir: dir, actualFile: shot, runId: 'b' });
  assert.equal(b1.verdict.stop, false, "a retry's first check is not judged against the last attempt");
  assert.equal(b1.bestMismatchPct, null, 'history from run "a" is ignored');
  assert.equal(b1.previousMismatchPct, a3.mismatchPct, 'previous score is still shown across runs');
  assert.match(fs.readFileSync(path.join(dir, 'compare', 'report.md'), 'utf8'), /Verdict: CONTINUE/);
  // no run id: no session to judge against, so only the target can stop it
  const saved = process.env.FIGMA_LENS_RUN;
  delete process.env.FIGMA_LENS_RUN;
  try {
    for (let i = 0; i < 7; i++) assert.equal(compare({ designDir: dir, actualFile: shot }).verdict.stop, false);
  } finally {
    if (saved !== undefined) process.env.FIGMA_LENS_RUN = saved;
  }
});

test('CLI: --run groups checks into a session; FIGMA_LENS_RUN wins over it', () => {
  const root = tmp();
  const dir = makeExport(root);
  const shot = path.join(root, 'off.png');
  writePng(shot, drawScreen({ cardX: 80 }));
  const { FIGMA_LENS_RUN, ...base } = process.env;
  const verdict = (env, ...extra) => {
    const r = spawnSync(process.execPath, [CLI, 'compare', '--design', dir, '--actual', shot, '--json', ...extra], { encoding: 'utf8', cwd: root, env: { ...base, ...env } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).verdict;
  };
  // interactive use: no env, the same --run id on every check of the task
  assert.equal(verdict({}, '--run', 'task-1').stop, false);
  assert.equal(verdict({}, '--run', 'task-1').stop, false);
  assert.equal(verdict({}, '--run', 'task-1').why, 'plateau', 'manual checks with an id stop on a plateau');
  assert.equal(verdict({}, '--run', 'task-2').stop, false, 'a new task id starts fresh');
  // auto mode: the per-session env id is used even if Claude passes a reused --run id
  assert.equal(verdict({ FIGMA_LENS_RUN: 'session-x' }, '--run', 'task-1').stop, false);
});

// Values are mismatch % in order; the last one is the current check.
const verdictOf = (seq) => verdictFor(seq[seq.length - 1], seq.slice(0, -1));

test('verdict: target, first, improved, regressed, flat, plateau', () => {
  assert.deepEqual([verdictOf([2.5]).stop, verdictOf([2.5]).why], [true, 'target']);
  assert.equal(verdictOf([3]).why, 'target', 'exactly the target counts');
  assert.deepEqual([verdictOf([5.0]).stop, verdictOf([5.0]).why], [false, null], 'first check');
  assert.match(verdictOf([5.0]).text, /^CONTINUE/);
  assert.deepEqual([verdictOf([5.0, 4.0]).stop, verdictOf([5.0, 4.0]).why], [false, null], 'improved');
  assert.equal(verdictOf([5.0, 4.8]).why, null, 'an improvement of exactly MIN_GAIN counts');

  const worse = verdictOf([4.0, 6.0]);
  assert.deepEqual([worse.stop, worse.why], [false, 'regressed']);
  assert.match(worse.text, /^CONTINUE/);
  assert.match(worse.text, /\b4%/);
  assert.match(worse.text, /\b6%/);
  assert.match(worse.text, /undo/i);

  assert.deepEqual([verdictOf([4.0, 3.9]).stop, verdictOf([4.0, 3.9]).why], [false, null], 'first flat check');
  const plateau = verdictOf([4.0, 3.9, 3.95]);
  assert.deepEqual([plateau.stop, plateau.why], [true, 'plateau'], 'two non-improving in a row');
  assert.match(plateau.text, /report what still differs and why/);
  assert.deepEqual([verdictOf([4.0, 6.0, 4.0]).stop, verdictOf([4.0, 6.0, 4.0]).why], [true, 'plateau'], 'regressed, then flat against best 4.0');
  assert.deepEqual([verdictOf([4.0, 6.0, 3.5]).stop, verdictOf([4.0, 6.0, 3.5]).why], [false, null], 'improved: streak reset');
  assert.equal(verdictOf([4.0, 6.0, 3.5, 3.45]).stop, false, 'after a reset, one flat check is not a plateau');
});

test('verdict: a worse check never stops, except at the check limit', () => {
  for (const seq of [[4.0, 6.0], [4.0, 3.9, 6.0], [4.0, 6.0, 6.5], [4.0, 6.0, 7.0, 8.0, 9.0]]) {
    const v = verdictOf(seq);
    assert.deepEqual([v.stop, v.why], [false, 'regressed'], seq.join(' → '));
  }
});

test('verdict: the sixth check stops, and asks to restore the best version when worse', () => {
  const limit = verdictOf([5, 4.5, 4.0, 3.6, 3.3, 3.1]);
  assert.deepEqual([limit.stop, limit.why], [true, 'limit']);
  assert.doesNotMatch(limit.text, /restore/i);
  const limitWorse = verdictOf([5, 4.5, 4.0, 3.6, 3.3, 4.5]);
  assert.deepEqual([limitWorse.stop, limitWorse.why], [true, 'limit']);
  assert.match(limitWorse.text, /worse than your best result \(3\.3%\)/);
  assert.match(limitWorse.text, /Restore the version that scored 3\.3%/);
  assert.equal(verdictOf([5, 4.5, 4.0, 3.6, 3.3, 2.9]).why, 'target', 'the target still wins on the last check');
});
