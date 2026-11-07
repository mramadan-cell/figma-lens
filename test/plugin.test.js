// Runs the bundled plugin (plugin/dist/code.js, built by `npm test`) against a mocked figma API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, summarizeUsage } from '../bridge/render-md.js';

const BUNDLE = fileURLToPath(new URL('../plugin/dist/code.js', import.meta.url));
const mixed = Symbol('mixed');

function buildScene() {
  let id = 0;
  const exports = [];
  function node(type, props = {}, children) {
    const n = { id: '1:' + ++id, type, visible: true, name: type.toLowerCase(), width: 10, height: 10, rotation: 0, opacity: 1,
      blendMode: 'PASS_THROUGH', fills: [], strokes: [], effects: [], boundVariables: {}, ...props };
    n.absoluteBoundingBox = { x: props.ax || 0, y: props.ay || 0, width: n.width, height: n.height };
    n.absoluteTransform = [[1, 0, n.absoluteBoundingBox.x], [0, 1, n.absoluteBoundingBox.y]];
    if (children) {
      n.children = children;
      children.forEach((c) => (c.parent = n));
    }
    n.exportAsync = async (o) => {
      exports.push({ name: n.name, ...o });
      return o.format === 'SVG' ? new Uint8Array(Buffer.from('<svg>' + n.name + '</svg>')) : new Uint8Array([0x89, 0x50]);
    };
    n.getCSSAsync = async () => ({ width: n.width + 'px' });
    return n;
  }
  const solid = (r, g, b, extra = {}) => ({ type: 'SOLID', visible: true, opacity: 1, blendMode: 'NORMAL', color: { r, g, b }, ...extra });
  const vector = (name) => node('VECTOR', { name, fills: [solid(0, 0, 0)] });

  const text = node('TEXT', { name: 'Title', ax: 16, ay: 24, width: 200, height: 32, characters: 'Hello world',
    textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP', textAutoResize: 'HEIGHT', paragraphSpacing: 0,
    layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG', layoutPositioning: 'AUTO', layoutGrow: 0, fills: mixed,
    getStyledTextSegments: () => [
      { characters: 'Hello ', fontName: { family: 'Inter', style: 'Bold' }, fontWeight: 700, fontSize: 24, lineHeight: { unit: 'PIXELS', value: 32 },
        letterSpacing: { unit: 'PERCENT', value: -2 }, fills: [solid(0.07, 0.09, 0.15)], textDecoration: 'NONE', textCase: 'ORIGINAL', textStyleId: 'S:t1' },
      { characters: 'world', fontName: { family: 'Inter', style: 'Regular' }, fontWeight: 400, fontSize: 24, lineHeight: { unit: 'AUTO' },
        letterSpacing: { unit: 'PIXELS', value: 0 }, fills: [solid(1, 0, 0)], textDecoration: 'UNDERLINE', textCase: 'ORIGINAL', textStyleId: '' },
    ] });

  const main = node('COMPONENT', { name: 'Size=24' });
  node('COMPONENT_SET', { name: 'Icon/Chevron' }, [main]);
  const chevron = (ax) => node('INSTANCE', { name: 'chevron', ax, ay: 92, width: 24, height: 24, layoutPositioning: 'AUTO',
    getMainComponentAsync: async () => main, componentProperties: { Size: { type: 'VARIANT', value: '24' } } }, [vector('path')]);
  // Icon frame with an invisible (0% opacity) fill: must still export as ONE svg.
  const ghostIcon = node('FRAME', { name: 'Icon Bell', ax: 360, ay: 92, width: 24, height: 24, layoutPositioning: 'AUTO',
    fills: [solid(1, 1, 1, { opacity: 0 })] }, [vector('bell-body'), vector('bell-clapper')]);

  const btn = node('INSTANCE', { name: 'Button', ax: 16, ay: 80, width: 358, height: 48, layoutMode: 'HORIZONTAL', itemSpacing: 8,
    paddingTop: 12, paddingRight: 16, paddingBottom: 12, paddingLeft: 16, primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER',
    layoutWrap: 'NO_WRAP', strokesIncludedInLayout: false, clipsContent: false, layoutPositioning: 'AUTO', layoutGrow: 0,
    layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FIXED', cornerRadius: 12, cornerSmoothing: 0,
    fills: [solid(0.36, 0.36, 0.84, { boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V1' } } }),
      { type: 'GRADIENT_LINEAR', visible: true, opacity: 0.5, blendMode: 'NORMAL', gradientTransform: [[1, 0, 0], [0, 1, 0]],
        gradientStops: [{ color: { r: 1, g: 1, b: 1, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 0, a: 0.5 }, position: 1 }] }],
    effects: [{ type: 'DROP_SHADOW', visible: true, offset: { x: 0, y: 4 }, radius: 12, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.1 }, blendMode: 'NORMAL' }],
    strokes: [solid(0.9, 0.9, 0.92)], strokeWeight: 1, strokeAlign: 'INSIDE', dashPattern: [],
    boundVariables: { itemSpacing: { type: 'VARIABLE_ALIAS', id: 'V2' } },
    getMainComponentAsync: async () => null,
    componentProperties: { 'Label#12:3': { type: 'TEXT', value: 'Continue' }, 'Icon#1:2': { type: 'INSTANCE_SWAP', value: '9:9' } },
  }, [chevron(300), chevron(330), ghostIcon]);

  const badge = node('RECTANGLE', { name: 'Badge', ax: 350, ay: 5, width: 30, height: 16, layoutPositioning: 'ABSOLUTE',
    constraints: { horizontal: 'MAX', vertical: 'MIN' }, cornerRadius: mixed, topLeftRadius: 8, topRightRadius: 8, bottomRightRadius: 0, bottomLeftRadius: 8,
    fills: [{ type: 'IMAGE', visible: true, opacity: 1, scaleMode: 'FILL', imageHash: 'abcdef0123456789xyz', blendMode: 'NORMAL' }] });

  const root = node('FRAME', { name: 'Home Screen', width: 390, height: 844, layoutMode: 'VERTICAL', itemSpacing: 16,
    paddingTop: 24, paddingRight: 16, paddingBottom: 24, paddingLeft: 16, primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'CENTER',
    layoutWrap: 'NO_WRAP', clipsContent: true, fills: [solid(1, 1, 1)], cornerRadius: 0, layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
  }, [text, btn, node('FRAME', { name: 'hidden', visible: false }), badge]);
  return { root, exports };
}

async function runExport({ scene = buildScene(), options = { scale: 2, css: true, sections: true } } = {}) {
  const { root, exports } = scene;
  const V = {
    V1: { id: 'V1', name: 'color/primary', resolvedType: 'COLOR', variableCollectionId: 'C1',
      valuesByMode: { m1: { r: 0.36, g: 0.36, b: 0.84, a: 1 }, m2: { type: 'VARIABLE_ALIAS', id: 'V3' } }, codeSyntax: {} },
    V2: { id: 'V2', name: 'space/sm', resolvedType: 'FLOAT', variableCollectionId: 'C1', valuesByMode: { m1: 8, m2: 8 }, codeSyntax: { WEB: '--space-sm' } },
    V3: { id: 'V3', name: 'base/indigo-300', resolvedType: 'COLOR', variableCollectionId: 'C1', valuesByMode: { m1: { r: 0.5, g: 0.5, b: 1, a: 1 } }, codeSyntax: {} },
  };
  const messages = [];
  const figma = {
    mixed, root: { name: 'App File' }, currentPage: { name: 'Screens', selection: [root] },
    ui: { postMessage: (m) => messages.push(m), onmessage: null }, showUI: () => {}, on: () => {},
    variables: {
      getVariableByIdAsync: async (i) => V[i] || null,
      getVariableCollectionByIdAsync: async () => ({ name: 'Tokens', modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }] }),
    },
    getStyleByIdAsync: async (i) => (i === 'S:t1'
      ? { name: 'Heading/H2', type: 'TEXT', fontName: { family: 'Inter', style: 'Bold' }, fontSize: 24, lineHeight: { unit: 'PIXELS', value: 32 },
          letterSpacing: { unit: 'PERCENT', value: -2 }, textCase: 'ORIGINAL', textDecoration: 'NONE' }
      : null),
    getImageByHash: () => ({ getBytesAsync: async () => new Uint8Array([0xff, 0xd8, 0, 0]) }),
    getNodeByIdAsync: async () => ({ name: 'Icon/Arrow' }),
  };
  vm.runInNewContext(fs.readFileSync(BUNDLE, 'utf8'), { figma, __html__: '', console, Uint8Array, setTimeout });
  await figma.ui.onmessage({ type: 'export', options });
  return { messages, exports };
}

test('bundled plugin exports a correct payload from a mocked scene', async () => {
  const { messages, exports } = await runExport();
  assert.deepEqual(messages.filter((m) => m.type === 'error'), []);
  // Objects built inside the vm have foreign prototypes; JSON round-trip them into this realm
  // (file bytes are dropped, only paths are compared).
  const msg = messages.find((m) => m.type === 'payload');
  const p = JSON.parse(JSON.stringify(msg.payload));
  // Files are streamed one message each, before the payload, with the same export id; the payload only lists them.
  const fileMsgs = messages.filter((m) => m.type === 'file');
  assert.ok(fileMsgs.every((m) => m.exportId === msg.exportId && m.bytes.length > 0));
  assert.deepEqual(fileMsgs.map((m) => m.path).sort(), p.files.map((f) => f.path).sort());
  assert.ok(messages.indexOf(msg) > messages.indexOf(fileMsgs[fileMsgs.length - 1]));
  assert.deepEqual(p.files.map((f) => f.size), fileMsgs.map((m) => m.bytes.length));
  const byName = (n, name) => (n.name === name ? n : (n.children || []).map((c) => byName(c, name)).find(Boolean));

  // screenshot covers exactly the frame box (so crops line up with spec coordinates)
  const shot = exports.find((e) => e.format === 'PNG' && e.name === 'Home Screen');
  assert.equal(shot.useAbsoluteBounds, true);
  assert.equal(p.meta.screen, 'screen@2x.png');

  // icons: identical chevrons deduped; 0%-opacity-fill frame stays ONE svg, children not exported separately
  const paths = p.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['assets/icon-bell.svg', 'assets/icon-chevron-24.svg', 'images/abcdef0123456789.jpg', 'screen@2x.png']);
  const bell = byName(p.spec, 'Icon Bell');
  assert.equal(bell.asset, 'assets/icon-bell.svg');
  assert.equal(bell.children, undefined);

  // hidden layers skipped; variables + alias chains recorded; styles resolved
  assert.equal(byName(p.spec, 'hidden'), undefined);
  assert.deepEqual(p.tokens.variables.Tokens.vars['color/primary'].values, { Light: '#5C5CD6', Dark: { alias: 'base/indigo-300' } });
  assert.ok(p.tokens.variables.Tokens.vars['base/indigo-300']);
  assert.equal(p.tokens.styles['Heading/H2'].size, 24);

  // layout, components, gradient math
  const button = byName(p.spec, 'Button');
  assert.deepEqual(button.layout.padding, [12, 16, 12, 16]);
  assert.deepEqual(button.component.props, { Label: 'Continue', Icon: 'Icon/Arrow' });
  assert.equal(button.fills[1].cssAngle, 90);
  assert.equal(button.vars.itemSpacing, 'space/sm');

  // rendered markdown
  const md = renderMarkdown(p, summarizeUsage(p.spec));
  assert.match(md, /run "world": Inter Regular \(400\) 24\/auto #FF0000 decoration UNDERLINE/);
  assert.match(md, /"Badge" 30×16 · @350,5 · absolute · pin MAX\/MIN/);
  assert.match(md, /radius 8,8,0,8/);
  // per-corner radii (8,8,0,8) counted once per node — assert on the data, not a regex over the whole md
  assert.deepEqual(summarizeUsage(p.spec).radii.find((r) => r.value === 8), { value: 8, count: 1, names: [] });
});

// A flat frame with `count` styled rectangles (each one gets CSS).
function bigScene(count) {
  const exports = [];
  const kids = [];
  for (let i = 0; i < count; i++) {
    kids.push({ id: '2:' + i, type: 'RECTANGLE', visible: true, name: 'cell ' + i, width: 10, height: 10, rotation: 0, opacity: 1,
      blendMode: 'PASS_THROUGH', fills: [{ type: 'SOLID', visible: true, opacity: 1, blendMode: 'NORMAL', color: { r: 1, g: 0, b: 0 } }],
      strokes: [], effects: [], boundVariables: {}, cornerRadius: 0, absoluteBoundingBox: { x: (i % 100) * 10, y: Math.floor(i / 100) * 10, width: 10, height: 10 },
      absoluteTransform: [[1, 0, 0], [0, 1, 0]], getCSSAsync: async () => ({ background: 'red' }), exportAsync: async () => new Uint8Array([0x89, 0x50]) });
  }
  const root = { id: '2:root', type: 'FRAME', visible: true, name: 'Big Grid', width: 1000, height: Math.ceil(count / 100) * 10, rotation: 0, opacity: 1,
    blendMode: 'PASS_THROUGH', fills: [], strokes: [], effects: [], boundVariables: {}, layoutMode: 'NONE', clipsContent: false, cornerRadius: 0,
    absoluteBoundingBox: { x: 0, y: 0, width: 1000, height: Math.ceil(count / 100) * 10 }, absoluteTransform: [[1, 0, 0], [0, 1, 0]], children: kids,
    exportAsync: async (o) => { exports.push(o); return new Uint8Array([0x89, 0x50]); } };
  kids.forEach((k) => (k.parent = root));
  return { root, exports };
}

test('large frames are read completely by default (no 5,000-layer or 800-CSS cap)', async () => {
  const { messages } = await runExport({ scene: bigScene(6000) });
  const p = messages.find((m) => m.type === 'payload').payload;
  assert.equal(p.meta.truncated, false);
  assert.equal(p.meta.nodeCount, 6001);
  assert.equal(p.spec.children.length, 6000);
  assert.equal(p.meta.css.added, 3000); // default CSS limit, spent only on styled layers
  assert.equal(p.meta.css.candidates, 6000);
  assert.equal(p.spec.children[2999].css.background, 'red');
  assert.equal(p.spec.children[3000].css, undefined);
  // progress was reported while reading (the walk yields to Figma)
  assert.ok(messages.some((m) => m.type === 'progress' && /Read 6000 layers/.test(m.text)));
});

test('layer and CSS limits come from the UI; skipped layers are listed, not silently dropped', async () => {
  const { messages } = await runExport({ scene: bigScene(250), options: { scale: 1, css: true, sections: false, maxLayers: 101, cssLimit: 0 } });
  const p = JSON.parse(JSON.stringify(messages.find((m) => m.type === 'payload').payload));
  assert.equal(p.meta.truncated, true);
  assert.equal(p.meta.nodeCount, 101);
  assert.equal(p.meta.skippedCount, 150);
  assert.deepEqual(p.meta.skipped[0], { id: '2:100', name: 'cell 100', type: 'RECTANGLE', box: { x: 0, y: 10, w: 10, h: 10 } });
  assert.equal(p.meta.css.added, 100); // cssLimit 0 = all
  const md = renderMarkdown(p, summarizeUsage(p.spec));
  assert.match(md, /Layer limit \(101\) reached — 150 layer subtree\(s\) are missing/);
  assert.match(md, /`2:100` RECTANGLE "cell 100" at 0,10 10×10/);
  assert.match(md, /… and 110 more/);
  // nonsense limits fall back to the defaults
  const bad = await runExport({ scene: bigScene(5), options: { scale: 1, css: true, maxLayers: -3, cssLimit: 'x' } });
  const meta = bad.messages.find((m) => m.type === 'payload').payload.meta;
  assert.equal(meta.maxLayers, 0);
  assert.equal(meta.css.limit, 3000);
});
