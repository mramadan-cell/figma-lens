// figma-lens browser: the injected page bundle (plugin/dist/page.js, built by `npm test`) against a
// mocked figma API, written through the real writeExport; and the settings / Linux detection logic.
// No real browser is started here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeExport, writeExportFromFiles, stagingDir } from '../bridge/server.js';
import {
  resolveBrowserSettings, browserCandidates, defaultProfile, parseFigmaUrl, readDevToolsPort,
  loadBrowserConfig, initBrowserConfig, displayProblem, kindOf, resolveLink,
  launchArgs, extraArgs, ensureWebgl, webglHelp, remembersSoftwareGl, SOFTWARE_GL,
} from '../tools/browser.js';
import { screenTargets, buildFlows, renderFlowsMd } from '../bridge/flows.js';
import { parity } from '../tools/parity.js';

const BUNDLE = fileURLToPath(new URL('../plugin/dist/page.js', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figma-lens-browser-'));

// ---------- a tiny prototype: Login --(click, push)--> Home; Back; Help link; Filter overlay ----------

function scene() {
  // Flows live on the frame's own page (it may not be the current page when exporting by link).
  const page = { type: 'PAGE', name: 'Mobile', parent: null, flowStartingPoints: [{ nodeId: '1:100', name: 'Onboarding' }] };
  let id = 0;
  const node = (type, props = {}, children) => {
    const n = { id: props.id || '1:' + ++id, type, visible: true, name: type.toLowerCase(), width: 100, height: 40, rotation: 0, opacity: 1,
      blendMode: 'PASS_THROUGH', fills: [], strokes: [], effects: [], boundVariables: {}, reactions: [], ...props };
    n.absoluteBoundingBox = { x: props.ax || 0, y: props.ay || 0, width: n.width, height: n.height };
    n.absoluteTransform = [[1, 0, n.absoluteBoundingBox.x], [0, 1, n.absoluteBoundingBox.y]];
    n.exportAsync = async (o) => (o.format === 'SVG' ? new Uint8Array(Buffer.from('<svg/>')) : new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    n.getCSSAsync = async () => ({});
    if (children) {
      n.children = children;
      children.forEach((c) => (c.parent = n));
    }
    return n;
  };
  const solid = { type: 'SOLID', visible: true, opacity: 1, blendMode: 'NORMAL', color: { r: 0.2, g: 0.4, b: 1 } };
  const push = { type: 'PUSH', direction: 'LEFT', matchLayers: false, easing: { type: 'EASE_OUT' }, duration: 0.3 };
  const button = node('FRAME', { name: 'Sign in button', ax: 16, ay: 300, fills: [solid],
    reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '2:1', navigation: 'NAVIGATE', transition: push }] }] },
  [node('RECTANGLE', { name: 'bg', fills: [solid] })]);
  const back = node('FRAME', { name: 'Back', fills: [solid], reactions: [{ trigger: { type: 'ON_CLICK' }, action: { type: 'BACK' } }] });
  const help = node('FRAME', { name: 'Help', fills: [solid], reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'URL', url: 'https://example.com/help' }] }] });
  const filter = node('FRAME', { name: 'Filter', fills: [solid],
    reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '3:1', navigation: 'OVERLAY', transition: null }] }] });
  const login = node('FRAME', { id: '1:100', name: 'Login', width: 390, height: 844, fills: [solid], overflowDirection: 'VERTICAL', numberOfFixedChildren: 1 },
    [button, back, help, filter]);
  login.parent = page;
  const home = node('FRAME', { id: '2:1', name: 'Home', width: 390, height: 844, overlayPositionType: 'CENTER' });
  home.parent = page;
  const sheet = node('FRAME', { id: '3:1', name: 'Filter sheet', width: 390, height: 400, overlayPositionType: 'BOTTOM_CENTER',
    overlayBackground: { type: 'SOLID_COLOR', color: { r: 0, g: 0, b: 0, a: 0.4 } }, overlayBackgroundInteraction: 'CLOSE_ON_CLICK_OUTSIDE' });
  sheet.parent = page;
  const byId = new Map([[login.id, login], [home.id, home], [sheet.id, sheet], [page.name, page]]);
  const figma = {
    editorType: 'figma',
    root: { name: 'Shop app' },
    currentPage: { name: 'Other page', selection: [login], flowStartingPoints: [{ nodeId: '9:9', name: 'Wrong page flow' }] },
    getNodeByIdAsync: async (i) => byId.get(i) || null,
    getStyleByIdAsync: async () => null,
    getImageByHash: () => null,
    variables: { getVariableByIdAsync: async () => null, getVariableCollectionByIdAsync: async () => null },
  };
  return { figma, login };
}

async function runInPage(figma, ids = null, options = { css: false }) {
  const calls = [];
  const ctx = { figma, console, Uint8Array, setTimeout, btoa: (s) => Buffer.from(s, 'binary').toString('base64') };
  ctx.globalThis = ctx;
  ctx.send = async (kind, exportId, a, b) => {
    calls.push({ kind, exportId, a, b });
    return true;
  };
  vm.runInNewContext(fs.readFileSync(BUNDLE, 'utf8'), ctx);
  const summary = await ctx.__figmaLens.exportNodes(ids, options, 'send');
  return { summary, calls, status: ctx.__figmaLens.status() };
}

test('page bundle: status, then every file and the spec go through the delivery function', async () => {
  const { figma } = scene();
  const { summary, calls, status } = await runInPage(figma);
  assert.equal(status.ok, true);
  assert.equal(status.selection[0].name, 'Login');
  assert.equal(summary.ok, true, JSON.stringify(summary));
  assert.deepEqual(calls.map((c) => c.kind).filter((k) => k !== 'progress'), ['begin', 'file', 'payload']);
  const file = calls.find((c) => c.kind === 'file');
  assert.equal(file.a, 'screen@2x.png');
  assert.deepEqual([...Buffer.from(file.b, 'base64')], [0x89, 0x50, 0x4e, 0x47]); // bytes survive base64
});

test('page bundle: prototype links, flows, overlay and scroll settings are exported', async () => {
  const { figma } = scene();
  const { calls } = await runInPage(figma);
  const payload = JSON.parse(calls.find((c) => c.kind === 'payload').a);
  const kids = Object.fromEntries(payload.spec.children.map((k) => [k.name, k]));
  assert.deepEqual(kids['Sign in button'].reactions, [{
    trigger: { type: 'ON_CLICK' },
    actions: [{ type: 'NODE', navigation: 'NAVIGATE', to: '2:1', toName: 'Home', transition: { type: 'PUSH', duration: 0.3, direction: 'LEFT', easing: 'EASE_OUT' } }],
  }]);
  assert.deepEqual(kids.Back.reactions[0].actions, [{ type: 'BACK' }]); // deprecated single `action` still read
  assert.equal(kids.Help.reactions[0].actions[0].url, 'https://example.com/help');
  const p = payload.meta.prototype;
  assert.deepEqual(p.flows, [{ name: 'Onboarding', start: '1:100' }]);
  assert.deepEqual(p.screen, { scrolls: 'VERTICAL', fixedChildren: 1 });
  const sheet = p.destinations.find((d) => d.id === '3:1');
  assert.deepEqual(sheet.overlay, { position: 'BOTTOM_CENTER', background: '#00000066', closeOnOutsideClick: true });
  assert.equal(sheet.page, 'Mobile');
});

test('page bundle: export by node id; unknown ids and pages are reported, not thrown', async () => {
  const { figma } = scene();
  figma.currentPage.selection = [];
  const { summary } = await runInPage(figma, ['1:100', '9:9', 'Mobile']);
  assert.equal(summary.exports.length, 1);
  assert.equal(summary.exports[0].name, 'Login');
  assert.equal(summary.ok, false);
  assert.match(summary.errors.join('\n'), /9:9 not found/);
  assert.match(summary.errors.join('\n'), /is a page, not a frame/);
  const empty = await runInPage(figma, null);
  assert.match(empty.summary.errors[0], /nothing selected/);
});

test('page bundle: no figma object on the page is reported as such', () => {
  const ctx = { console, Uint8Array, setTimeout };
  ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(BUNDLE, 'utf8'), ctx);
  // JSON copy: the object comes from the vm's realm (different Object prototype).
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.__figmaLens.status())), { ok: false, reason: 'no-figma' });
});

test('browser export writes a normal design folder; spec.md shows the prototype links', async () => {
  const { figma } = scene();
  const { calls } = await runInPage(figma);
  const payload = JSON.parse(calls.find((c) => c.kind === 'payload').a);
  const files = calls.filter((c) => c.kind === 'file').map((c) => ({ path: c.a, base64: c.b }));
  const out = tmp();
  const r = await writeExport(out, { ...payload, files });
  const md = fs.readFileSync(path.join(r.dir, 'spec.md'), 'utf8');
  assert.match(md, /→ on click: navigate to "Home" \(`2:1`\), push left 0\.3s ease-out/);
  assert.match(md, /→ on click: back/);
  assert.match(md, /→ on click: open link https:\/\/example\.com\/help/);
  assert.match(md, /→ on click: open overlay "Filter sheet" \(`3:1`\)/);
  assert.ok(fs.existsSync(path.join(out, 'INDEX.md')));
});

// ---------- settings ----------

const noBrowser = () => [];
const fakeChrome = () => [{ cmd: ['/usr/bin/google-chrome'], kind: 'regular', label: 'google-chrome' }];

test('settings: flag beats env beats config beats auto-detection', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'figma-lens.config.json'), JSON.stringify({ auto: { enabled: true }, browser: { executable: '/opt/cfg/chrome', out: 'ui/design', scale: 3, profile: '~/fl-profile' } }));
  const home = '/home/dev';
  const base = { cwd: dir, platform: 'linux', home, detect: fakeChrome };

  const fromConfig = resolveBrowserSettings({ ...base, env: {} });
  assert.deepEqual(fromConfig.cmd, ['/opt/cfg/chrome']);
  assert.equal(fromConfig.from.executable, 'config');
  assert.equal(fromConfig.out, path.resolve(dir, 'ui/design')); // relative to the config file
  assert.equal(fromConfig.profile, path.resolve(dir, path.join(home, 'fl-profile')));
  assert.equal(fromConfig.options.scale, 3);

  const fromEnv = resolveBrowserSettings({ ...base, env: { FIGMA_LENS_BROWSER: '/opt/env/chromium', FIGMA_LENS_OUT: '/tmp/x' } });
  assert.deepEqual(fromEnv.cmd, ['/opt/env/chromium']);
  assert.equal(fromEnv.from.executable, 'env FIGMA_LENS_BROWSER');
  assert.equal(fromEnv.out, path.resolve('/tmp/x'));

  const fromFlag = resolveBrowserSettings({ ...base, env: { FIGMA_LENS_BROWSER: '/opt/env/chromium' }, flags: { browser: '/opt/flag/chrome', scale: '1' } });
  assert.deepEqual(fromFlag.cmd, ['/opt/flag/chrome']);
  assert.equal(fromFlag.options.scale, 1);
});

test('settings: no config → auto-detected browser, profile in ~/.figma-lens, out ./design', () => {
  const dir = tmp();
  const s = resolveBrowserSettings({ cwd: dir, env: {}, platform: 'linux', home: '/home/dev', detect: fakeChrome });
  assert.deepEqual(s.cmd, ['/usr/bin/google-chrome']);
  assert.equal(s.from.executable, 'auto');
  assert.equal(s.profile, path.join('/home/dev', '.figma-lens', 'browser-profile'));
  assert.equal(s.out, path.resolve(dir, 'design'));
  assert.deepEqual(s.options, { scale: 2, css: true, sections: true, maxLayers: 0, cssLimit: 3000 });
});

test('settings: "executable": null in the config still auto-detects; Flatpak list form works', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'figma-lens.config.json'), JSON.stringify({ browser: { executable: null, profile: null } }));
  assert.equal(resolveBrowserSettings({ cwd: dir, env: {}, platform: 'linux', home: '/h', detect: fakeChrome }).from.executable, 'auto');
  fs.writeFileSync(path.join(dir, 'figma-lens.config.json'), JSON.stringify({ browser: { executable: ['flatpak', 'run', 'com.google.Chrome'] } }));
  const s = resolveBrowserSettings({ cwd: dir, env: { PATH: '' }, platform: 'linux', home: '/h', detect: fakeChrome });
  assert.equal(s.kind, 'flatpak');
  assert.equal(s.profile, path.join('/h', '.var', 'app', 'com.google.Chrome', 'figma-lens-profile'));
});

test('settings: no browser anywhere gives a Linux install hint', () => {
  assert.throws(() => resolveBrowserSettings({ cwd: tmp(), env: {}, platform: 'linux', home: '/h', detect: noBrowser }), /Install Google Chrome .* Chromium.*FIGMA_LENS_BROWSER/s);
});

test('config: unknown keys and bad values are rejected with the setting name', () => {
  const dir = tmp();
  const f = path.join(dir, 'figma-lens.config.json');
  fs.writeFileSync(f, JSON.stringify({ browser: { exe: '/x' } }));
  assert.throws(() => loadBrowserConfig(f), /unknown setting browser\.exe/);
  fs.writeFileSync(f, JSON.stringify({ browser: { scale: 5 } }));
  assert.throws(() => loadBrowserConfig(f), /browser\.scale must be 1, 2, 3 or 4/);
  fs.writeFileSync(f, JSON.stringify({ browser: { executable: 42 } }));
  assert.throws(() => loadBrowserConfig(f), /browser\.executable must be/);
  fs.writeFileSync(f, '{ broken');
  assert.throws(() => loadBrowserConfig(f), /figma-lens\.config\.json/);
});

test('--init adds a browser section and keeps the auto section', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'figma-lens.config.json'), JSON.stringify({ auto: { enabled: true } }));
  assert.equal(initBrowserConfig(dir).created, true);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'figma-lens.config.json'), 'utf8'));
  assert.deepEqual(raw.auto, { enabled: true });
  assert.equal(raw.browser.out, 'design');
  assert.equal(initBrowserConfig(dir).created, false); // never overwrites
});

// ---------- Linux detection ----------

test('linux: Chrome from PATH, Ubuntu chromium wrapper counted as snap, Flatpak apps', () => {
  const which = (n) => ({ 'google-chrome-stable': '/usr/bin/google-chrome-stable', 'chromium-browser': '/usr/bin/chromium-browser' })[n] || null;
  const exists = (p) => p === '/snap/bin/chromium';
  const list = browserCandidates('linux', {}, { which, exists, flatpakApps: () => ['org.chromium.Chromium', 'org.gimp.GIMP'] });
  assert.deepEqual(list.map((b) => [b.cmd.join(' '), b.kind]), [
    ['/usr/bin/google-chrome-stable', 'regular'],
    ['/usr/bin/chromium-browser', 'snap'],
    ['flatpak run org.chromium.Chromium', 'flatpak'],
  ]);
});

test('linux: snap Chromium gets a profile it is allowed to write', () => {
  assert.equal(defaultProfile('snap', '/home/dev'), path.join('/home/dev', 'snap', 'chromium', 'common', 'figma-lens-profile'));
  assert.equal(defaultProfile('regular', '/home/dev'), path.join('/home/dev', '.figma-lens', 'browser-profile'));
});

test('linux: a missing display is explained; Windows/macOS never need one', () => {
  assert.match(displayProblem('linux', {}), /no graphical display/);
  assert.equal(displayProblem('linux', { WAYLAND_DISPLAY: 'wayland-0' }), null);
  assert.equal(displayProblem('linux', { DISPLAY: ':0' }), null);
  assert.equal(displayProblem('darwin', {}), null);
});

// ---------- links and the port file ----------

test('Figma links: file key and node ids (38-2 → 38:2, several)', () => {
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/nsXOoy1BB1e34Xgro725Sd/Untitled?node-id=38-2&t=abc'), { key: 'nsXOoy1BB1e34Xgro725Sd', nodeIds: ['38:2'] });
  assert.deepEqual(parseFigmaUrl('https://figma.com/file/AbC123/x?node-id=1-2,3-4').nodeIds, ['1:2', '3:4']);
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/AbC123/x').nodeIds, []);
  assert.throws(() => parseFigmaUrl('https://evil.example/design/AbC/x'), /not a figma\.com link/);
  assert.throws(() => parseFigmaUrl('https://www.figma.com/board/AbC/x'), /not a Figma design file link/);
});

test('DevToolsActivePort: first line is the port; junk or a missing file gives null', () => {
  const dir = tmp();
  assert.equal(readDevToolsPort(dir), null);
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '45123\r\n/devtools/browser/abc\r\n');
  assert.equal(readDevToolsPort(dir), 45123);
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), 'nope');
  assert.equal(readDevToolsPort(dir), null);
});

// ---------- bug fixes: page, overlay noise, Snap kind ----------

async function exportScene(mutate) {
  const { figma, login } = scene();
  if (mutate) mutate(figma, login);
  const { calls } = await runInPage(figma);
  const payload = JSON.parse(calls.find((c) => c.kind === 'payload').a);
  const files = calls.filter((c) => c.kind === 'file').map((c) => ({ path: c.a, base64: c.b }));
  return { payload, files, calls };
}

test('meta.page is the page of the frame, not the page open in the editor', async () => {
  const { payload, calls } = await exportScene();
  assert.equal(payload.meta.page, 'Mobile'); // currentPage is "Other page"
  assert.equal(JSON.parse(calls.find((c) => c.kind === 'begin').a).page, 'Mobile');
});

test('overlay settings only for frames a link opens as an overlay', async () => {
  const { payload } = await exportScene((figma, login) => (login.overlayPositionType = 'CENTER'));
  const p = payload.meta.prototype;
  assert.equal(p.screen.overlay, undefined, 'the exported screen itself is not a modal');
  assert.equal(p.destinations.find((d) => d.id === '2:1').overlay, undefined, 'navigate target with default CENTER');
  assert.equal(p.destinations.find((d) => d.id === '3:1').overlay.position, 'BOTTOM_CENTER');
});

test('meta.prototype.links: one entry per action, with the layer that triggers it', async () => {
  const { payload, calls } = await exportScene();
  const links = payload.meta.prototype.links;
  assert.deepEqual(links.map((l) => [l.layerName, l.trigger, l.type, l.navigation || null, l.to || null]), [
    ['Sign in button', 'ON_CLICK', 'NODE', 'NAVIGATE', '2:1'],
    ['Back', 'ON_CLICK', 'BACK', null, null],
    ['Help', 'ON_CLICK', 'URL', null, null],
    ['Filter', 'ON_CLICK', 'NODE', 'OVERLAY', '3:1'],
  ]);
  assert.equal(links[0].toName, 'Home');
  assert.ok(calls.some((c) => c.kind === 'progress' && /Prototype: 4 link\(s\) → "Home"/.test(c.a)), 'progress line for the terminal');
  assert.deepEqual(screenTargets(payload.meta.prototype), [{ id: '2:1', name: 'Home', overlay: false }, { id: '3:1', name: 'Filter sheet', overlay: true }]);
});

test('linux: a snap Chromium keeps its snap profile (auto-detected and set by hand)', () => {
  const snapDetect = () => [{ cmd: ['/usr/bin/chromium-browser'], kind: 'snap', label: 'chromium-browser (snap)' }];
  const auto = resolveBrowserSettings({ cwd: tmp(), env: {}, platform: 'linux', home: '/home/dev', detect: snapDetect });
  assert.equal(auto.kind, 'snap');
  assert.equal(auto.profile, path.join('/home/dev', 'snap', 'chromium', 'common', 'figma-lens-profile'));
  const exists = (p) => p === '/snap/bin/chromium';
  const byHand = resolveBrowserSettings({ cwd: tmp(), env: {}, flags: { browser: '/usr/bin/chromium-browser' }, platform: 'linux', home: '/home/dev', exists });
  assert.equal(byHand.kind, 'snap');
  assert.equal(kindOf(['/usr/bin/chromium'], 'linux', () => true), 'regular'); // deb chromium (/usr/lib/chromium exists)
  assert.equal(kindOf(['/usr/bin/chromium-browser'], 'win32', exists), 'regular');
  assert.equal(kindOf(['flatpak', 'run', 'org.chromium.Chromium'], 'linux', exists), 'flatpak');
});

// ---------- the screen map ----------

test('FLOWS.md and flows.json: screens, links, start screens and the screens not exported yet', async () => {
  const { payload, files } = await exportScene((figma) => (figma.fileKey = 'AbC123'));
  const out = tmp();
  const r = await writeExport(out, { ...payload, files });
  const flows = JSON.parse(fs.readFileSync(path.join(out, 'flows.json'), 'utf8'));
  assert.deepEqual(flows.screens.map((s) => [s.name, s.page, s.scrolls]), [['Login', 'Mobile', 'VERTICAL']]);
  assert.equal(flows.links.length, 4);
  assert.deepEqual(flows.missing.map((m) => [m.name, m.overlay, m.from, m.link]), [
    ['Home', false, ['Login'], 'https://www.figma.com/design/AbC123/?node-id=2-1'],
    ['Filter sheet', true, ['Login'], 'https://www.figma.com/design/AbC123/?node-id=3-1'],
  ]);
  assert.deepEqual(flows.starts.map((s) => [s.flow, s.exported]), [['Onboarding', true]]);
  const md = fs.readFileSync(path.join(out, 'FLOWS.md'), 'utf8');
  assert.match(md, /Flow "Onboarding" starts at "Login"/);
  assert.match(md, /## Not exported yet/);
  assert.match(md, /figma-lens browser "https:\/\/www\.figma\.com\/design\/AbC123\/\?node-id=2-1" --once/);
  assert.match(md, /```mermaid[\s\S]*-\.->\|Filter\|[\s\S]*```/); // overlay = dotted arrow
  const spec = fs.readFileSync(path.join(r.dir, 'spec.md'), 'utf8');
  assert.match(spec, /## Prototype \(how this screen connects\)/);
  assert.match(spec, /FLOWS\.md/);
});

test('screen map: once the target is exported, the link points at its folder and it leaves "not exported"', () => {
  const proto = (links, dest) => ({ links, destinations: dest });
  const rows = [
    { dir: 'login', nodeId: '1:100', nodeName: 'Login', file: 'Shop', fileKey: 'K', page: 'Mobile', width: 390, height: 844,
      prototype: proto([{ layer: '1:1', layerName: 'Go', trigger: 'ON_CLICK', type: 'NODE', navigation: 'NAVIGATE', to: '2:1', toName: 'Home' },
        { layer: '1:2', layerName: 'Jump', trigger: 'ON_CLICK', type: 'NODE', navigation: 'SCROLL_TO', to: '1:50' }],
      [{ id: '2:1', name: 'Home', page: 'Mobile' }, { id: '1:50', name: 'Footer', inside: true }]) },
    { dir: 'home', nodeId: '2:1', nodeName: 'Home', file: 'Shop', fileKey: 'K', page: 'Mobile', width: 390, height: 844 },
  ];
  const f = buildFlows(rows);
  assert.equal(f.missing.length, 0);
  assert.equal(f.links.find((l) => l.layerName === 'Go').to, 'K#2:1');
  assert.equal(f.links.find((l) => l.layerName === 'Jump').to, null, 'scroll-to stays inside the screen');
  // the same node id in another Figma file is another screen
  rows[1].fileKey = 'OTHER';
  assert.equal(buildFlows(rows).missing.length, 1);
});

test('screen map: no prototype links gives a short note, not empty tables', async () => {
  const out = tmp();
  const { payload, files } = await exportScene((figma, login) => {
    for (const c of login.children) c.reactions = [];
    login.parent.flowStartingPoints = [];
  });
  await writeExport(out, { ...payload, files });
  assert.match(fs.readFileSync(path.join(out, 'FLOWS.md'), 'utf8'), /No prototype links in the exported screens/);
});

// ---------- named links ----------

test('browser.files: names resolve to links; bad names and links are rejected', () => {
  const settings = { files: { login: 'https://www.figma.com/design/AbC/x?node-id=1-2' } };
  assert.equal(resolveLink('login', settings), settings.files.login);
  assert.equal(resolveLink('https://www.figma.com/design/AbC/x?node-id=3-4', settings), 'https://www.figma.com/design/AbC/x?node-id=3-4');
  assert.equal(resolveLink('', settings), undefined);
  assert.throws(() => resolveLink('signup', settings), /"signup" is not a Figma link or a name from browser\.files \(login\)/);
  assert.throws(() => resolveLink('https://evil.example/design/AbC/x', settings), /not a figma\.com link/);
  assert.throws(() => resolveLink('toString', {}), /add named links/); // no prototype lookups

  const dir = tmp();
  const f = path.join(dir, 'figma-lens.config.json');
  fs.writeFileSync(f, JSON.stringify({ browser: { files: { 'bad name': 'https://www.figma.com/design/AbC/x' } } }));
  assert.throws(() => loadBrowserConfig(f), /name "bad name" may only use/);
  fs.writeFileSync(f, JSON.stringify({ browser: { files: { home: 'https://example.com/x' } } }));
  assert.throws(() => loadBrowserConfig(f), /browser\.files\.home: not a figma\.com link/);
  fs.writeFileSync(f, JSON.stringify({ browser: { files: settings.files, flowMax: 5 } }));
  const s = resolveBrowserSettings({ cwd: dir, env: {}, platform: 'linux', home: '/h', detect: fakeChrome });
  assert.deepEqual(s.files, settings.files);
  assert.equal(s.flowMax, 5);
  assert.equal(resolveBrowserSettings({ cwd: dir, env: {}, platform: 'linux', home: '/h', detect: fakeChrome, flags: { 'flow-max': '2' } }).flowMax, 2);
});

// ---------- streamed files ----------

test('writeExportFromFiles moves staged files into the export and rejects unsafe paths', async () => {
  const { payload, files } = await exportScene();
  const out = tmp();
  const stage = await stagingDir(out);
  const staged = files.map((f, i) => {
    const file = path.join(stage, 'f' + i);
    fs.writeFileSync(file, Buffer.from(f.base64, 'base64'));
    return { path: f.path, file };
  });
  const r = await writeExportFromFiles(out, structuredClone(payload), staged);
  assert.deepEqual([...fs.readFileSync(path.join(r.dir, 'screen@2x.png'))], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(!fs.existsSync(staged[0].file), 'moved, not copied');
  await assert.rejects(writeExportFromFiles(out, structuredClone(payload), [{ path: '../evil.svg', file: staged[0].file }]), /unsafe file path/);
});

// ---------- parity ----------

test('parity: the same frame exported twice is SAME; a changed fill is reported', async () => {
  const { payload, files } = await exportScene();
  const a = await writeExport(tmp(), structuredClone({ ...payload, files }));
  const b = await writeExport(tmp(), structuredClone({ ...payload, files }));
  const same = parity(a.dir, b.dir);
  assert.equal(same.same, true, JSON.stringify(same, null, 1));
  assert.equal(same.layers.a, same.layers.b);

  const specFile = path.join(b.dir, 'spec.json');
  const doc = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  doc.spec.children[0].fills = [{ type: 'SOLID', color: '#FF0000' }];
  fs.writeFileSync(specFile, JSON.stringify(doc));
  const diff = parity(a.dir, b.dir);
  assert.equal(diff.same, false);
  assert.deepEqual(diff.fields.map((f) => [f.key, f.count]), [['fills', 1]]);
  assert.throws(() => parity(tmp(), b.dir), /not a figma-lens export/);
});

// ---------- review fixes ----------

test('flowMax: a non-number --flow-max is rejected; 0 (no limit) is accepted', () => {
  const dir = tmp();
  const base = { cwd: dir, env: {}, platform: 'linux', home: '/h', detect: fakeChrome };
  assert.throws(() => resolveBrowserSettings({ ...base, flags: { 'flow-max': 'abc' } }), /--flow-max must be a whole number/);
  assert.throws(() => resolveBrowserSettings({ ...base, flags: { 'flow-max': '-1' } }), /--flow-max must be a whole number/);
  assert.throws(() => resolveBrowserSettings({ ...base, flags: { 'flow-max': '2.5' } }), /--flow-max must be a whole number/);
  assert.throws(() => resolveBrowserSettings({ ...base, flags: { 'flow-max': true } }), /--flow-max must be a whole number/); // bare flag
  assert.throws(() => resolveBrowserSettings({ ...base, flags: { 'flow-max': '' } }), /--flow-max must be a whole number/);
  // the other number flags: a bare flag or a typo stops the run instead of becoming 1 or the default
  for (const f of ['max-layers', 'css-limit']) {
    for (const v of [true, 'abc', '-3']) assert.throws(() => resolveBrowserSettings({ ...base, flags: { [f]: v } }), new RegExp(`--${f} must be a whole number`));
  }
  assert.throws(() => resolveBrowserSettings({ ...base, flags: { 'max-layers': true } }), /got no value/);
  for (const v of [true, '5', 'x']) assert.throws(() => resolveBrowserSettings({ ...base, flags: { scale: v } }), /--scale must be 1, 2, 3, 4/);
  const ok = resolveBrowserSettings({ ...base, flags: { scale: '3', 'max-layers': '0', 'css-limit': '500' } }).options;
  assert.deepEqual([ok.scale, ok.maxLayers, ok.cssLimit], [3, 0, 500]);
  assert.equal(resolveBrowserSettings({ ...base, flags: { 'flow-max': '0' } }).flowMax, 0);
  assert.equal(resolveBrowserSettings(base).flowMax, 30);
  fs.writeFileSync(path.join(dir, 'figma-lens.config.json'), JSON.stringify({ browser: { flowMax: 0 } }));
  assert.equal(resolveBrowserSettings(base).flowMax, 0);
});

test('page bundle: an empty id list is an error, never the selection', async () => {
  const { figma } = scene(); // Login is selected
  const { summary, calls } = await runInPage(figma, []);
  assert.equal(summary.exports.length, 0);
  assert.match(summary.errors.join('\n'), /no frame ids given/);
  assert.equal(calls.length, 0, 'nothing is sent to the CLI');
});

test('screen map: a desktop export (no file key) and a browser export of the same file are one file', () => {
  const rows = [
    { dir: 'login', nodeId: '1:100', nodeName: 'Login', file: 'Shop', fileKey: 'K', page: 'Mobile', width: 390, height: 844,
      prototype: { links: [{ layer: '1:1', layerName: 'Go', trigger: 'ON_CLICK', type: 'NODE', navigation: 'NAVIGATE', to: '2:1' }],
        destinations: [{ id: '2:1', name: 'Home', page: 'Mobile' }] } },
    { dir: 'home', nodeId: '2:1', nodeName: 'Home', file: 'Shop', page: 'Mobile', width: 390, height: 844 }, // desktop: no key
  ];
  const f = buildFlows(rows);
  assert.equal(f.missing.length, 0);
  assert.equal(f.links[0].to, 'K#2:1');
  assert.equal(f.screens[1].key, 'K#2:1');
  // two different files called "Shop": don't guess which one the key-less export came from
  const two = [...rows, { dir: 'x', nodeId: '5:5', nodeName: 'X', file: 'Shop', fileKey: 'OTHER', page: 'P', width: 1, height: 1 }];
  const g = buildFlows(two);
  assert.equal(g.screens[1].key, 'Shop#2:1');
  assert.equal(g.missing.length, 1);
});

test('FLOWS.md: a | in a designer name does not break the tables', () => {
  const rows = [
    { dir: 'a-b', nodeId: '1:1', nodeName: 'A | B', file: 'F', fileKey: 'K', page: 'P', width: 1, height: 1,
      prototype: { links: [{ layer: '1:2', layerName: 'Yes | No', trigger: 'ON_CLICK', type: 'NODE', navigation: 'NAVIGATE', to: '2:2' }],
        destinations: [{ id: '2:2', name: 'C | D', page: 'P' }] } },
  ];
  const md = renderFlowsMd(buildFlows(rows));
  const rowsOf = (title) => md.split('## ' + title)[1].split('\n\n')[0].split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Screen') && !l.startsWith('| From'));
  for (const t of ['Screens', 'Links']) {
    for (const line of rowsOf(t)) {
      const cells = line.split('\\|').join('').split('|').length - 2;
      assert.equal(cells, t === 'Screens' ? 6 : 4, `${t}: ${line}`);
    }
  }
  assert.ok(md.includes('A \\| B'), 'screen name escaped');
  assert.ok(md.includes('"Yes \\| No"'), 'layer name escaped');
});

// ---------- browser flags, WebGL and --login ----------

test('browser.args: extra flags are passed to the browser; bad lists and figma-lens\'s own flags are rejected', () => {
  const dir = tmp();
  const f = path.join(dir, 'figma-lens.config.json');
  const base = { cwd: dir, env: {}, platform: 'linux', home: '/h', detect: fakeChrome };
  fs.writeFileSync(f, JSON.stringify({ browser: { args: '--ignore-gpu-blocklist' } }));
  assert.throws(() => loadBrowserConfig(f), /browser\.args must be a list of browser flags/);
  fs.writeFileSync(f, JSON.stringify({ browser: { args: ['ignore-gpu-blocklist'] } }));
  assert.throws(() => loadBrowserConfig(f), /browser\.args must be a list/);
  fs.writeFileSync(f, JSON.stringify({ browser: { args: ['--remote-debugging-port=9222'] } }));
  assert.throws(() => loadBrowserConfig(f), /--remote-debugging-port=9222 is set by figma-lens/);
  fs.writeFileSync(f, JSON.stringify({ browser: { args: ['--user-data-dir=/x'] } }));
  assert.throws(() => loadBrowserConfig(f), /is set by figma-lens/);

  fs.writeFileSync(f, JSON.stringify({ browser: { args: ['--lang=en'], profile: path.join(dir, 'p') } }));
  const s = resolveBrowserSettings(base);
  assert.deepEqual(s.args, ['--lang=en']);
  const a = launchArgs(s);
  assert.deepEqual(a.slice(-2), ['--lang=en', s.startUrl]);
  assert.ok(a.includes('--remote-debugging-port=0'));
  assert.ok(a.includes(`--user-data-dir=${s.profile}`));
  const plain = launchArgs(s, { debug: false, url: 'https://www.figma.com/login' });
  assert.ok(!plain.some((x) => x.startsWith('--remote-debugging')), '--login opens no DevTools port');
  assert.equal(plain.at(-1), 'https://www.figma.com/login');
  assert.deepEqual(resolveBrowserSettings({ ...base, cwd: tmp() }).args, []);
});

/** A fake connected browser: works() answers from `gl`. */
const fakeBrowser = (gl) => ({ gl, closed: false });

test('WebGL off in a window figma-lens just started: restart once with software graphics, remembered in the profile', async () => {
  const profile = tmp();
  const settings = { profile, args: [], cmd: ['/usr/bin/chromium'], startUrl: 'https://www.figma.com/' };
  const calls = [];
  const logs = [];
  const r = await ensureWebgl(fakeBrowser(false), {
    port: 1111, started: true, settings, log: (s) => logs.push(s),
    works: async (b) => b.gl,
    close: async (b, port, prof) => calls.push(['close', port, prof]),
    start: async (s2) => (calls.push(['start', launchArgs(s2).includes(SOFTWARE_GL)]), { port: 2222, started: true }),
    connect: async (port) => (calls.push(['connect', port]), fakeBrowser(true)),
  });
  assert.deepEqual(calls, [['close', 1111, profile], ['start', true], ['connect', 2222]]);
  assert.equal(r.port, 2222);
  assert.equal(r.browser.gl, true);
  assert.equal(remembersSoftwareGl(profile), true);
  assert.deepEqual(extraArgs(settings), [SOFTWARE_GL]);
  assert.match(logs.join('\n'), /WebGL is off[\s\S]*WebGL works now/);
  // next start: the flag is there from the beginning, nothing to restart
  const ok = await ensureWebgl(fakeBrowser(true), { port: 3, started: true, settings, log: () => {}, works: async (b) => b.gl, connect: assert.fail, close: assert.fail, start: assert.fail });
  assert.equal(ok.port, 3);
});

test('WebGL off: a window that was already open is not restarted; still off with the flag gives the next step', async () => {
  const settings = { profile: tmp(), args: [], cmd: ['/usr/bin/chromium'] };
  const never = { works: async () => false, close: assert.fail, start: assert.fail, connect: assert.fail, log: () => {} };
  await assert.rejects(ensureWebgl({}, { ...never, port: 1, started: false, settings }), /Close every window of this browser \(Linux: pkill chromium[\s\S]*restarts it with software graphics/);
  // the flag set by hand and still no WebGL: no restart loop, point to SwiftShader / Chrome
  const withFlag = { ...settings, args: [SOFTWARE_GL] };
  await assert.rejects(ensureWebgl({}, { ...never, port: 1, started: true, settings: withFlag }), /even with --ignore-gpu-blocklist[\s\S]*--enable-unsafe-swiftshader/);
  const inExecutable = { ...settings, cmd: ['/usr/bin/chromium', SOFTWARE_GL] };
  await assert.rejects(ensureWebgl({}, { ...never, port: 1, started: true, settings: inExecutable }), /even with --ignore-gpu-blocklist/);
  // restarted, still off: the connection is dropped (figma-lens must be able to exit) and the next step shown
  let dropped = false;
  const b2 = { close: async () => (dropped = true) };
  await assert.rejects(ensureWebgl({}, {
    port: 1, started: true, settings: { ...settings, profile: tmp() }, log: () => {},
    works: async () => false, close: async () => {}, start: async () => ({ port: 2 }), connect: async () => b2,
  }), /--enable-unsafe-swiftshader/);
  assert.equal(dropped, true);
  assert.match(webglHelp(false), /WebGL isn't supported/);
});

test('page bundle status: the page\'s prototype starts and its screens, also inside Sections (absolute positions)', async () => {
  const frame = (id, x, y, abs) => ({ type: 'FRAME', id, name: `F${id}`, x, y, width: 390, height: 844, ...(abs ? { absoluteBoundingBox: { x: abs[0], y: abs[1], width: 390, height: 844 } } : {}) });
  const figma = {
    editorType: 'figma',
    root: { name: 'Shop' },
    currentPage: {
      name: 'Mobile',
      selection: [],
      flowStartingPoints: [{ nodeId: '1:1', name: 'Onboarding' }],
      children: [
        frame('1:1', 0, 0),
        { type: 'SECTION', id: '9:1', name: 'Checkout', children: [frame('2:1', 10, 20, [1000, 20])] }, // x/y relative to the section
        { type: 'COMPONENT', id: '5:1', name: 'Button', x: 0, y: 2000, width: 100, height: 40 },
      ],
    },
  };
  const status = JSON.parse(JSON.stringify((await runInPage(figma, [])).status)); // plain objects (made in the page's vm realm)
  assert.equal(status.ok, true);
  assert.deepEqual(status.flows, [{ id: '1:1', name: 'Onboarding' }]);
  assert.deepEqual(status.frames.map((f) => [f.id, f.x, f.y]), [['1:1', 0, 0], ['2:1', 1000, 20]], 'section frames at their absolute position; components are not screens');
});
