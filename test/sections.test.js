import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { planSections, cropSections, MAX_EDGE } from '../bridge/sections.js';
import { renderSpecFiles, summarizeUsage, SPLIT_LINES } from '../bridge/render-md.js';
import { blank, writePng } from '../tools/image.js';

const CLI = fileURLToPath(new URL('../bin/figma-lens.js', import.meta.url));

// A tall HTML-import style page: Header + one "Main" that covers almost everything,
// Main → Container (single child) → 3 real sections, each with many text layers.
function bigPage({ textsPerSection = 160 } = {}) {
  const W = 1000, H = 4000;
  const section = (i) => ({
    id: `9:${i}`, name: `Section ${i}`, type: 'FRAME', box: { x: 0, y: 200 + i * 1200, w: W, h: 1200 },
    children: Array.from({ length: textsPerSection }, (_, k) => ({
      id: `9:${i}-${k}`, name: 'Text', type: 'TEXT', box: { x: 10, y: 200 + i * 1200 + k, w: 100, h: 10 },
      text: { characters: `line ${k}` },
    })),
  });
  const spec = {
    id: '9:page', name: 'Page', type: 'FRAME', box: { x: 0, y: 0, w: W, h: H },
    children: [
      { id: '9:hdr', name: 'Header', type: 'FRAME', box: { x: 0, y: 0, w: W, h: 200 } },
      {
        id: '9:main', name: 'Main', type: 'FRAME', box: { x: 0, y: 200, w: W, h: 3800 },
        children: [{
          id: '9:cont', name: 'Container', type: 'FRAME', box: { x: 0, y: 200, w: W, h: 3800 },
          children: [section(0), section(1), section(2), { id: '9:dot', name: 'Dot', type: 'FRAME', box: { x: 0, y: 3900, w: 10, h: 10 } }],
        }],
      },
    ],
  };
  const meta = {
    tool: 'figma-lens', nodeName: 'Page', nodeId: '9:page', file: 'f', page: 'p', nodeType: 'FRAME', version: '0.2.0',
    width: W, height: H, scale: 1, screen: 'screen@1x.png', exportedAt: '2026-11-04T00:00:00.000Z', warnings: [],
    sections: [
      { id: '9:hdr', name: 'Header', box: spec.children[0].box },
      { id: '9:main', name: 'Main', box: spec.children[1].box },
    ],
  };
  return { meta, spec };
}

test('a dominant, huge block is split into its real children (single-child chain skipped, tiny layers dropped)', () => {
  const { meta, spec } = bigPage();
  const plan = planSections(meta, spec);
  assert.deepEqual(plan.map((s) => s.id), ['9:hdr', '9:0', '9:1', '9:2']);
  assert.deepEqual(plan.map((s) => s.stem), ['sections/01-header', 'sections/02-section-0', 'sections/03-section-1', 'sections/04-section-2']);
});

test('a dominant block that is not oversized is NOT split', () => {
  const { meta, spec } = bigPage();
  meta.scale = 0.5; // Main is 1900px long at this scale: below the split threshold
  assert.deepEqual(planSections(meta, spec).map((s) => s.id), ['9:hdr', '9:main']);
});

test('crops: long edge capped at MAX_EDGE, very tall crops cut into pieces with correct boxes', () => {
  const src = blank(3200, 2400);
  const plan = [
    { id: 'a', name: 'Wide', box: { x: 0, y: 0, w: 1600, h: 400 }, stem: 'sections/01-wide' },
    { id: 'b', name: 'Tall', box: { x: 0, y: 400, w: 200, h: 800 }, stem: 'sections/02-tall' },
  ];
  const out = cropSections(src, plan, 2);
  const size = (f) => { const p = PNG.sync.read(f.buf); return [p.width, p.height]; };

  assert.equal(out[0].file, 'sections/01-wide.png');
  assert.deepEqual(size(out[0]), [MAX_EDGE, 392]); // 3200×800 px → 1568×392
  assert.equal(out[0].px, 0.98);

  // 400×1600 px is 4:1 → 2 pieces of 400×800
  assert.deepEqual(out.slice(1).map((f) => f.file), ['sections/02-tall-1.png', 'sections/02-tall-2.png']);
  assert.deepEqual(out.slice(1).map(size), [[400, 800], [400, 800]]);
  assert.deepEqual(out.slice(1).map((f) => f.box), [{ x: 0, y: 400, w: 200, h: 400 }, { x: 0, y: 800, w: 200, h: 400 }]);
  assert.equal(out[2].name, 'Tall (2/2)');
});

test('large trees get an overview spec.md plus one spec file per section; small trees stay one file', () => {
  const { meta, spec } = bigPage();
  meta.sectionPlan = planSections(meta, spec);
  const files = renderSpecFiles({ meta, spec, tokens: {} }, summarizeUsage(spec));
  assert.deepEqual(files.map((f) => f.file), ['spec.md', 'sections/01-header.md', 'sections/02-section-0.md', 'sections/03-section-1.md', 'sections/04-section-2.md']);
  const [overview, , s0] = files.map((f) => f.text);
  assert.match(overview, /Large frame: the layer tree is split per section/);
  assert.match(overview, /`9:0` FRAME "Section 0"[^\n]*\n\s+- … 160 layers inside: see `sections\/02-section-0\.md`/);
  assert.doesNotMatch(overview, /"line 5"/); // section content is not repeated in the overview
  assert.ok(overview.split('\n').length < SPLIT_LINES);
  assert.match(s0, /^# Page › Section 0/);
  assert.match(s0, /"line 159"/);
  assert.doesNotMatch(s0, /"Section 1"/);

  const small = bigPage({ textsPerSection: 5 });
  small.meta.sectionPlan = planSections(small.meta, small.spec);
  assert.deepEqual(renderSpecFiles({ ...small, tokens: {} }, summarizeUsage(small.spec)).map((f) => f.file), ['spec.md']);
});

test('render upgrades an old export: re-crops sections, writes section specs, removes stale crops', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-lens-sec-'));
  const { meta, spec } = bigPage();
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ meta, spec }));
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ variables: {}, styles: {} }));
  writePng(path.join(dir, 'screen@1x.png'), blank(1000, 4000));
  fs.mkdirSync(path.join(dir, 'sections'));
  fs.writeFileSync(path.join(dir, 'sections', '02-main.png'), 'stale whole-page crop');

  const r = spawnSync(process.execPath, [CLI, 'render', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const listed = fs.readdirSync(path.join(dir, 'sections')).sort();
  assert.ok(!listed.includes('02-main.png'));
  assert.ok(listed.includes('02-section-0.png') && listed.includes('02-section-0.md'));
  const first = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8')).meta;
  assert.equal(first.sectionFiles.length, 4);

  // no screenshot: crops cannot be regenerated, so the existing ones are kept (not deleted)
  const shot = path.join(dir, 'screen@1x.png');
  fs.renameSync(shot, shot + '.hold');
  for (let i = 0; i < 2; i++) assert.equal(spawnSync(process.execPath, [CLI, 'render', dir], { encoding: 'utf8' }).status, 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sections')).sort(), listed);
  const noShot = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8')).meta;
  assert.equal(noShot.sectionFiles.length, 4);
  assert.equal(noShot.warnings.filter((w) => /^no frame preview/.test(w)).length, 1);
  fs.renameSync(shot + '.hold', shot);

  // a wrong-size screenshot: crops are skipped with ONE warning, also after re-running
  writePng(path.join(dir, 'screen@1x.png'), blank(1000, 3000));
  for (let i = 0; i < 2; i++) assert.equal(spawnSync(process.execPath, [CLI, 'render', dir], { encoding: 'utf8' }).status, 0);
  const again = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8')).meta;
  assert.equal(again.warnings.filter((w) => /frame preview is 1000×3000px/.test(w)).length, 1);
  assert.equal(again.sectionFiles.length, 0);
  assert.ok(fs.readdirSync(path.join(dir, 'sections')).every((f) => f.endsWith('.md')));
});
