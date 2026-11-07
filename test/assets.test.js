import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nameAssets, isMeaninglessStem } from '../bridge/asset-names.js';
import { createBridge } from '../bridge/server.js';
import { c, pct, strip } from '../tools/colors.js';

const CLI = fileURLToPath(new URL('../bin/figma-lens.js', import.meta.url));
const txt = (id, characters) => ({ id, name: characters, type: 'TEXT', box: { x: 0, y: 0, w: 10, h: 10 }, text: { characters } });

// An HTML-import style tree: every layer is "Container"/"SVG"/"Link", images are named by hash.
// (Every real exported layer has a box; added at the end.)
function tree() {
  const t = {
    id: '1', name: 'Html → Body', type: 'FRAME', box: { x: 0, y: 0, w: 100, h: 100 },
    children: [
      { id: '2', name: 'Link', type: 'FRAME', children: [txt('3', 'Schedule Strategic Briefing'), { id: '4', name: 'Container', type: 'FRAME', asset: 'assets/container.svg' }] },
      { id: '5', name: 'Icon/Arrow Right', type: 'INSTANCE', component: { name: 'Icon/Arrow Right' }, asset: 'assets/container-2.svg' },
      { id: '6', name: 'Search', type: 'VECTOR', asset: 'assets/svg.svg' },
      { id: '7', name: 'Case Card', type: 'FRAME', children: [
        { id: '8', name: 'Container', type: 'FRAME', children: [{ id: '9', name: 'ab6axubm6hhxepc2on0opsdbm6vf', type: 'RECTANGLE', fills: [{ type: 'image', asset: 'images/f834a6f809c5006c.jpg' }] }] },
      ] },
      { id: '10', name: 'Logo', type: 'GROUP', asset: 'assets/logo.svg' }, // already meaningful: kept
      // same icon (deduplicated by content) used twice: the best name over both usages wins
      { id: '11', name: 'Container', type: 'FRAME', asset: 'assets/container-3.svg' },
      { id: '12', name: 'Row', type: 'FRAME', children: [txt('13', 'Read the breakdown'), { id: '14', name: 'SVG', type: 'FRAME', asset: 'assets/container-3.svg' }] },
      // two different icons that would get the same name: second gets -2
      { id: '15', name: 'Row', type: 'FRAME', children: [txt('16', 'Read the breakdown'), { id: '17', name: 'SVG', type: 'FRAME', asset: 'assets/container-4.svg' }] },
    ],
  };
  (function box(n) {
    n.box = n.box || { x: 0, y: 0, w: 10, h: 10 };
    (n.children || []).forEach(box);
  })(t);
  return t;
}
const filesOf = (spec) => {
  const out = new Set();
  (function walk(n) {
    if (n.asset) out.add(n.asset);
    for (const p of n.fills || []) if (p.asset) out.add(p.asset);
    for (const ch of n.children || []) walk(ch);
  })(spec);
  return [...out].map((p) => ({ path: p, base64: '' }));
};

test('meaningless names: generic layer words, numbers and machine ids', () => {
  for (const s of ['container', 'container-12', 'svg-3', 'f834a6f809c5006c', 'vector-2', 'group-20', 'background-shadow']) assert.equal(isMeaninglessStem(s), true, s);
  for (const s of ['logo', 'arrow-right', 'mdi-alert-circle-outline', 'search-2', 'hero-photo']) assert.equal(isMeaninglessStem(s), false, s);
});

test('icons and images get names from component, own name, nearby text or parent; references follow', () => {
  const spec = tree();
  const files = filesOf(spec);
  const { renames } = nameAssets(spec, files);
  assert.deepEqual(renames, {
    'assets/container.svg': 'assets/schedule-strategic-briefing-icon.svg', // nearby text label
    'assets/container-2.svg': 'assets/arrow-right.svg', // component name
    'assets/svg.svg': 'assets/search.svg', // own layer name
    'images/f834a6f809c5006c.jpg': 'images/case-card-image.jpg', // machine-id layer name → parent name
    'assets/container-3.svg': 'assets/read-breakdown-icon.svg', // best of two usages
    'assets/container-4.svg': 'assets/read-breakdown-icon-2.svg', // unique
  });
  // every reference and file entry is rewritten; meaningful names untouched
  assert.deepEqual(files.map((f) => f.path).sort(), [...Object.values(renames), 'assets/logo.svg'].sort());
  assert.equal(spec.children[0].children[1].asset, 'assets/schedule-strategic-briefing-icon.svg');
  assert.equal(spec.children[3].children[0].children[0].fills[0].asset, 'images/case-card-image.jpg');
  // both usages of the deduplicated icon point to its one new name
  assert.equal(spec.children[5].asset, 'assets/read-breakdown-icon.svg');
  assert.equal(spec.children[6].children[1].asset, 'assets/read-breakdown-icon.svg');
  assert.equal(spec.children[7].children[1].asset, 'assets/read-breakdown-icon-2.svg');
});

test('a text is only an icon label inside that icon\'s own control (not one shared with another icon)', () => {
  // Toolbar holds a "Save changes" text and two different icons: the text labels neither of them.
  const spec = {
    id: '1', name: 'Page', type: 'FRAME', box: { x: 0, y: 0, w: 10, h: 10 },
    children: [{
      id: '2', name: 'Toolbar', type: 'FRAME', box: { x: 0, y: 0, w: 10, h: 10 },
      children: [
        txt('3', 'Save changes'),
        { id: '4', name: 'Container', type: 'FRAME', box: { x: 0, y: 0, w: 1, h: 1 }, asset: 'assets/container.svg' },
        { id: '5', name: 'Container', type: 'FRAME', box: { x: 0, y: 0, w: 1, h: 1 }, asset: 'assets/container-2.svg' },
      ],
    }],
  };
  const { renames } = nameAssets(spec, filesOf(spec));
  assert.deepEqual(renames, { 'assets/container.svg': 'assets/toolbar-icon.svg', 'assets/container-2.svg': 'assets/toolbar-icon-2.svg' });
});

test('a paragraph next to an icon is content, not its label (star ratings next to a quote)', () => {
  const spec = {
    id: '1', name: 'Page', type: 'FRAME', box: { x: 0, y: 0, w: 10, h: 10 },
    children: [{
      id: '2', name: 'Testimonial Card', type: 'FRAME', box: { x: 0, y: 0, w: 10, h: 10 },
      children: [
        { id: '3', name: 'Container', type: 'FRAME', box: { x: 0, y: 0, w: 1, h: 1 }, asset: 'assets/container-13.svg' },
        txt('4', 'NOVA completely re-engineered our distributed architecture in eight weeks with craft.'),
        txt('5', 'ER'), // avatar initials: not a label either
      ],
    }],
  };
  assert.deepEqual(nameAssets(spec, filesOf(spec)).renames, { 'assets/container-13.svg': 'assets/testimonial-card-icon.svg' });
});

test('render with an asset missing on disk: renames the others, leaves the folder consistent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-lens-missing-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'container.svg'), 'x'); // container-2.svg is referenced but missing
  const spec = { id: '1', name: 'R', type: 'FRAME', box: { x: 0, y: 0, w: 10, h: 10 }, children: [
    { id: '2', name: 'Search', type: 'VECTOR', box: { x: 0, y: 0, w: 1, h: 1 }, asset: 'assets/container.svg' },
    { id: '3', name: 'Close', type: 'VECTOR', box: { x: 0, y: 0, w: 1, h: 1 }, asset: 'assets/container-2.svg' },
  ] };
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ meta: { nodeName: 'O', nodeId: '1', width: 10, height: 10, scale: 1, screen: 's.png', warnings: [] }, spec }));
  fs.writeFileSync(path.join(dir, 'tokens.json'), '{}');
  const r = spawnSync(process.execPath, [CLI, 'render', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'assets')), ['search.svg']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8')).spec;
  assert.equal(saved.children[0].asset, 'assets/search.svg'); // spec follows the file on disk
  assert.equal(saved.children[1].asset, 'assets/container-2.svg'); // missing one left as it was
});

test('the bridge writes exports with the new names (spec.md points to them)', async () => {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-lens-names-'));
  const server = createBridge({ outRoot, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const spec = tree();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
    const files = filesOf(spec).map((f) => ({ ...f, base64: svg }));
    const r = await fetch(`http://127.0.0.1:${server.address().port}/export`, {
      method: 'POST',
      body: JSON.stringify({ meta: { tool: 'figma-lens', nodeId: '1', nodeName: 'Page', width: 100, height: 100, scale: 1, screen: 'screen@1x.png', warnings: [] }, spec, tokens: {}, files }),
    });
    assert.equal(r.status, 200);
  } finally {
    server.close();
  }
  const dir = path.join(outRoot, 'page');
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'schedule-strategic-briefing-icon.svg')));
  assert.ok(!fs.existsSync(path.join(dir, 'assets', 'container.svg')));
  assert.ok(fs.existsSync(path.join(dir, 'images', 'case-card-image.jpg')));
  const md = fs.readFileSync(path.join(dir, 'spec.md'), 'utf8');
  assert.match(md, /→ assets\/arrow-right\.svg/);
  assert.doesNotMatch(md, /container-2\.svg/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8')).meta;
  assert.equal(saved.assetRenames['assets/container.svg'], 'assets/schedule-strategic-briefing-icon.svg');
});

test('render renames the assets of an older export on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-lens-oldnames-'));
  const spec = tree();
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.mkdirSync(path.join(dir, 'images'));
  for (const f of filesOf(spec)) fs.writeFileSync(path.join(dir, f.path), 'x');
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ meta: { nodeName: 'Old', nodeId: '1', width: 100, height: 100, scale: 1, screen: 'screen@1x.png', warnings: [] }, spec }));
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ variables: {}, styles: {} }));
  const r = spawnSync(process.execPath, [CLI, 'render', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /6 asset\(s\) renamed/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'assets')).sort(), ['arrow-right.svg', 'logo.svg', 'read-breakdown-icon-2.svg', 'read-breakdown-icon.svg', 'schedule-strategic-briefing-icon.svg', 'search.svg']);
  assert.match(fs.readFileSync(path.join(dir, 'spec.md'), 'utf8'), /→ assets\/search\.svg/);
  // running render again changes nothing more
  assert.equal(spawnSync(process.execPath, [CLI, 'render', dir], { encoding: 'utf8' }).status, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'assets')).length, 6);
});

test('shrinking a diff image for the side-by-side preview keeps 1-pixel marks visible', async () => {
  const { blank, shrinkMax } = await import('../tools/image.js');
  const img = blank(40, 40, [230, 230, 230, 255]);
  img.data.set([255, 0, 64, 255], (17 * 40 + 23) * 4); // one red diff pixel
  const small = shrinkMax(img, 4); // 10×10
  assert.deepEqual([small.width, small.height], [10, 10]);
  const at = (x, y) => [...small.data.slice((y * 10 + x) * 4, (y * 10 + x) * 4 + 4)];
  assert.deepEqual(at(5, 4), [255, 0, 64, 255]); // the block holding the mark is still red
  assert.deepEqual(at(0, 0), [230, 230, 230, 255]);
});

test('colors: only in a terminal or with FORCE_COLOR, never with NO_COLOR', () => {
  const keep = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
  try {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    assert.equal(c.green('ok'), '\x1b[32mok\x1b[39m');
    assert.equal(strip(pct(2)), '2%');
    assert.match(pct(2), /\x1b\[32m/); // ≤3%: green
    assert.match(pct(7), /\x1b\[33m/); // ≤10%: yellow
    assert.match(pct(25), /\x1b\[31m/); // else red
    process.env.NO_COLOR = '1';
    assert.equal(c.green('ok'), 'ok');
  } finally {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
