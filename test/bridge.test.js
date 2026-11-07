import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createBridge, folderSlug, originAllowed, swapInto } from '../bridge/server.js';

function pngBase64(w, h) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255; png.data[i + 1] = 255; png.data[i + 2] = 255; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png).toString('base64');
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h24v24H0z"/></svg>').toString('base64');

function payload(overrides = {}) {
  return {
    meta: {
      tool: 'figma-lens', version: '0.1.0', file: 'App', page: 'Screens', nodeId: '1:2', nodeName: 'Login Screen',
      nodeType: 'FRAME', width: 390, height: 844, scale: 2, screen: 'screen@2x.png',
      sections: [
        { id: '1:3', name: 'Header', box: { x: 0, y: 0, w: 390, h: 100 } },
        { id: '1:9', name: 'Form', box: { x: 0, y: 100, w: 390, h: 744 } },
      ],
      nodeCount: 6, truncated: false, warnings: [], exportedAt: '2026-11-03T18:00:00.000Z',
    },
    spec: {
      id: '1:2', name: 'Login Screen', type: 'FRAME', box: { x: 0, y: 0, w: 390, h: 844 },
      layout: { mode: 'column', gap: 16, padding: [24, 16, 24, 16], main: 'MIN', cross: 'CENTER' },
      sizing: { h: 'FIXED', v: 'FIXED' },
      fills: [{ type: 'solid', color: '#FFFFFF', var: 'color/surface' }],
      vars: { itemSpacing: 'space/md' },
      children: [
        {
          id: '1:4', name: 'Title', type: 'TEXT', box: { x: 16, y: 24, w: 358, h: 32 }, rel: { x: 16, y: 24 },
          sizing: { h: 'FILL', v: 'HUG' },
          fills: [{ type: 'solid', color: '#111827' }],
          text: { characters: 'Welcome back', align: 'CENTER', autoResize: 'HEIGHT', font: 'Inter', style: 'Semi Bold',
                  weight: 600, size: 24, lineHeight: 32, letterSpacing: 0, fills: [{ type: 'solid', color: '#111827' }], textStyle: 'Heading/H2' },
        },
        {
          id: '1:5', name: 'Primary', type: 'INSTANCE', box: { x: 16, y: 72, w: 358, h: 48 }, rel: { x: 16, y: 72 },
          sizing: { h: 'FILL', v: 'FIXED' }, radius: 12,
          layout: { mode: 'row', gap: 8, padding: [12, 16, 12, 16], main: 'CENTER', cross: 'CENTER' },
          fills: [{ type: 'gradient-linear', stops: [{ color: '#5B5BD6', pos: 0 }, { color: '#8B5CF6', pos: 1 }], cssAngle: 90 }],
          effects: [{ type: 'drop-shadow', x: 0, y: 4, blur: 12, spread: 0, color: '#0000001A' }],
          component: { name: 'Button', variant: 'Type=Primary, Size=L', props: { Label: 'Continue' } },
          children: [
            { id: '1:6', name: 'arrow-right', type: 'INSTANCE', box: { x: 200, y: 84, w: 24, h: 24 }, rel: { x: 184, y: 12 },
              component: { name: 'Icon/Arrow Right' }, asset: 'assets/icon-arrow-right.svg' },
          ],
        },
        {
          id: '1:7', name: 'Badge', type: 'FRAME', box: { x: 340, y: 10, w: 40, h: 20 }, rel: { x: 340, y: 10 },
          absolute: true, radius: [10, 10, 0, 10], fills: [{ type: 'solid', color: '#EF4444' }],
          constraints: { h: 'MAX', v: 'MIN' },
        },
      ],
    },
    tokens: {
      variables: { Colors: { modes: ['Light', 'Dark'], vars: { 'color/surface': { type: 'COLOR', values: { Light: '#FFFFFF', Dark: '#0B0B0F' } } } } },
      styles: { 'Heading/H2': { type: 'text', font: 'Inter', style: 'Semi Bold', size: 24, lineHeight: 32, letterSpacing: 0 } },
    },
    files: [
      { path: 'screen@2x.png', base64: pngBase64(780, 1688) },
      { path: 'assets/icon-arrow-right.svg', base64: SVG },
    ],
    ...overrides,
  };
}

// Each test gets its own project folder: <tmp>/project/design is the out dir, so a
// figma-lens.map.json in <tmp>/project is isolated from other tests.
async function withBridge(fn) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-lens-'));
  const outRoot = path.join(project, 'design');
  await fs.mkdir(outRoot);
  const server = createBridge({ outRoot, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, outRoot, project });
  } finally {
    server.close();
    await fs.rm(project, { recursive: true, force: true });
  }
}

const post = (base, body, headers = {}) =>
  fetch(base + '/export', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('export writes spec, tokens, markdown, files, section crops and index', async () => {
  await withBridge(async ({ base, outRoot }) => {
    const r = await post(base, payload(), { Origin: 'null' });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(r.headers.get('access-control-allow-origin'), 'null');
    const dir = path.join(outRoot, 'login-screen');
    assert.equal(j.dir, dir);

    for (const f of ['spec.json', 'tokens.json', 'spec.md', '.figma-lens.json', 'screen@2x.png', 'assets/icon-arrow-right.svg', 'sections/01-header.png', 'sections/02-form.png']) {
      await fs.access(path.join(dir, f));
    }
    const crop = PNG.sync.read(await fs.readFile(path.join(dir, 'sections/01-header.png')));
    assert.deepEqual([crop.width, crop.height], [780, 200]); // 390x100 at 2x

    const md = await fs.readFile(path.join(dir, 'spec.md'), 'utf8');
    assert.match(md, /column gap 16 pad 24,16,24,16 main:MIN cross:CENTER/);
    assert.match(md, /"Welcome back" · Inter Semi Bold \(600\) 24\/32 #111827 \[style Heading\/H2\] · align CENTER/);
    assert.match(md, /component Button \{Type=Primary, Size=L\} props\{Label="Continue"\}/);
    assert.match(md, /→ assets\/icon-arrow-right\.svg/);
    assert.match(md, /gradient-linear 90deg \[#5B5BD6 0%, #8B5CF6 100%\]/);
    assert.match(md, /drop-shadow 0,4 blur 12 spread 0 #0000001A/);
    assert.match(md, /`1:7` FRAME "Badge" 40×20 · @340,10 · absolute · pin MAX\/MIN/);
    assert.match(md, /radius 10,10,0,10/);
    assert.match(md, /`color\/surface` COLOR: Light "#FFFFFF" · Dark "#0B0B0F"/);
    // children of auto layout get no @x,y (position comes from the layout)
    assert.doesNotMatch(md, /"Title" 358×32 · @/);

    const tokens = JSON.parse(await fs.readFile(path.join(dir, 'tokens.json'), 'utf8'));
    assert.deepEqual(tokens.usage.colors.find((c) => c.value === '#FFFFFF').names, ['color/surface']);
    assert.ok(tokens.usage.spacing.find((s) => s.value === 16).count >= 3);

    const index = await fs.readFile(path.join(outRoot, 'INDEX.md'), 'utf8');
    assert.match(index, /`login-screen\/` \| Login Screen \| 390×844/);
  });
});

test('re-export of the same frame replaces its own folder', async () => {
  await withBridge(async ({ base, outRoot }) => {
    assert.equal((await post(base, payload())).status, 200);
    await fs.writeFile(path.join(outRoot, 'login-screen', 'stale.txt'), 'old');
    assert.equal((await post(base, payload())).status, 200);
    await assert.rejects(fs.access(path.join(outRoot, 'login-screen', 'stale.txt')));
  });
});

test('two frames with the same name both survive (second gets <slug>-<id>)', async () => {
  await withBridge(async ({ base, outRoot }) => {
    const other = payload();
    other.meta.nodeId = '1:99';
    assert.equal((await post(base, payload())).status, 200);
    const r = await (await post(base, other)).json();
    assert.equal(r.dir, path.join(outRoot, 'login-screen-1-99'));
    // re-exporting the second frame updates its own folder, not the first one
    assert.equal((await (await post(base, other)).json()).dir, path.join(outRoot, 'login-screen-1-99'));
    const first = JSON.parse(await fs.readFile(path.join(outRoot, 'login-screen', '.figma-lens.json'), 'utf8'));
    assert.equal(first.nodeId, '1:2');
    const index = await fs.readFile(path.join(outRoot, 'INDEX.md'), 'utf8');
    assert.match(index, /`login-screen\/`/);
    assert.match(index, /`login-screen-1-99\/`/);

    // first frame's folder disappears → second frame keeps its own folder (no stale duplicate)
    await fs.rm(path.join(outRoot, 'login-screen'), { recursive: true });
    assert.equal((await (await post(base, other)).json()).dir, path.join(outRoot, 'login-screen-1-99'));
    await assert.rejects(fs.access(path.join(outRoot, 'login-screen')));
  });
});

test('never touches a folder figma-lens did not create', async () => {
  await withBridge(async ({ base, outRoot }) => {
    await fs.mkdir(path.join(outRoot, 'login-screen'));
    await fs.writeFile(path.join(outRoot, 'login-screen', 'mine.txt'), 'keep');
    const r = await (await post(base, payload())).json();
    assert.equal(r.dir, path.join(outRoot, 'login-screen-1-2'));
    assert.equal(await fs.readFile(path.join(outRoot, 'login-screen', 'mine.txt'), 'utf8'), 'keep');

    await fs.rm(path.join(outRoot, 'login-screen-1-2'), { recursive: true });
    await fs.mkdir(path.join(outRoot, 'login-screen-1-2'));
    assert.equal((await post(base, payload())).status, 409);
  });
});

test('screenshot that does not match frame size: warn and skip crops instead of shifting them', async () => {
  await withBridge(async ({ base, outRoot }) => {
    const p = payload();
    p.files[0].base64 = pngBase64(800, 1700); // frame is 390×844 @2x = 780×1688
    assert.equal((await post(base, p)).status, 200);
    const dir = path.join(outRoot, 'login-screen');
    await assert.rejects(fs.access(path.join(dir, 'sections')));
    const md = await fs.readFile(path.join(dir, 'spec.md'), 'utf8');
    assert.match(md, /frame preview is 800×1700px but the frame at 2x should be 780×1688px/);
  });
});

test('bridge applies the component map from the project folder; a broken map only warns', async () => {
  await withBridge(async ({ base, outRoot, project }) => {
    const mapFile = path.join(project, 'figma-lens.map.json');
    await fs.writeFile(mapFile, JSON.stringify({ components: { Button: { flutter: 'lib/widgets/app_button.dart#AppButton' } } }));
    assert.equal((await post(base, payload())).status, 200);
    let md = await fs.readFile(path.join(outRoot, 'login-screen', 'spec.md'), 'utf8');
    assert.match(md, /component Button \{Type=Primary, Size=L\} props\{Label="Continue"\} ⇒ USE flutter: lib\/widgets\/app_button\.dart#AppButton/);

    await fs.writeFile(mapFile, '{ broken');
    assert.equal((await post(base, payload())).status, 200);
    md = await fs.readFile(path.join(outRoot, 'login-screen', 'spec.md'), 'utf8');
    assert.match(md, /component map ignored: .*not valid JSON/);
  });
});

test('rejects path traversal and reserved names', async () => {
  await withBridge(async ({ base, outRoot }) => {
    for (const bad of ['../evil.txt', 'assets/../../evil.txt', '/abs.txt', 'C:/x.txt', '.figma-lens.json']) {
      const p = payload();
      p.files = [...p.files, { path: bad, base64: SVG }];
      const r = await post(base, p);
      assert.equal(r.status, 400, bad);
    }
    await assert.rejects(fs.access(path.join(outRoot, '..', 'evil.txt')));
  });
});

test('blocks foreign web origins, allows plugin and CLI', async () => {
  assert.equal(originAllowed(undefined), true);
  assert.equal(originAllowed('null'), true);
  assert.equal(originAllowed('https://www.figma.com'), true);
  assert.equal(originAllowed('https://evil.example'), false);
  assert.equal(originAllowed('https://figma.com.evil.example'), false);
  await withBridge(async ({ base }) => {
    const r = await post(base, payload(), { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    const pre = await fetch(base + '/export', { method: 'OPTIONS', headers: { Origin: 'null' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-headers'), 'Content-Type');
  });
});

test('health and bad input', async () => {
  await withBridge(async ({ base, outRoot }) => {
    const h = await (await fetch(base + '/health')).json();
    assert.equal(h.ok, true);
    assert.equal(h.outRoot, path.resolve(outRoot));
    const r = await fetch(base + '/export', { method: 'POST', body: '{nope' });
    assert.equal(r.status, 400);
    assert.equal((await post(base, { meta: { tool: 'other' }, spec: {}, files: [] })).status, 400);
  });
});

test('folder slug keeps Arabic names and falls back for empty ones', () => {
  assert.equal(folderSlug('الصفحة الرئيسية'), 'الصفحة-الرئيسية');
  assert.equal(folderSlug('Home / Screen 1'), 'home-screen-1');
  assert.equal(folderSlug('***', 'node-1:2'), 'node-1-2');
});

// ---------- streamed export (plugin 0.2+): one raw request per file, no base64 ----------

async function streamExport(base, p, { skipFinish = false, headers = { Origin: 'null' } } = {}) {
  const start = await (await fetch(base + '/exports', { method: 'POST', headers })).json();
  assert.equal(start.ok, true);
  for (const f of p.files) {
    const r = await fetch(`${base}/exports/${start.id}/files?path=${encodeURIComponent(f.path)}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: Buffer.from(f.base64, 'base64'),
    });
    assert.equal(r.status, 200, await r.text());
  }
  if (skipFinish) return { id: start.id };
  const { files, ...rest } = p;
  const r = await fetch(`${base}/exports/${start.id}/finish`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...rest, files: files.map((f) => f.path) }),
  });
  return { id: start.id, r, j: await r.json() };
}

test('streamed export writes the same folder as the single-request export, byte for byte', async () => {
  await withBridge(async ({ base, outRoot }) => {
    const h = await (await fetch(base + '/health')).json();
    assert.equal(h.upload, 1); // the plugin uses this to pick the streamed protocol
    const p = payload();
    const { r, j } = await streamExport(base, p);
    assert.equal(r.status, 200, JSON.stringify(j));
    const dir = path.join(outRoot, 'login-screen');
    assert.equal(j.dir, dir);
    for (const f of ['spec.json', 'spec.md', 'tokens.json', 'sections/01-header.png']) await fs.access(path.join(dir, f));
    for (const f of p.files) assert.deepEqual(await fs.readFile(path.join(dir, f.path)), Buffer.from(f.base64, 'base64'));
    // staging is cleaned up and never shows up as an export
    assert.deepEqual(await fs.readdir(path.join(outRoot, '.figma-lens-uploads')), []);
    assert.doesNotMatch(await fs.readFile(path.join(outRoot, 'INDEX.md'), 'utf8'), /figma-lens-uploads/);
  });
});

test('a failed or abandoned streamed export never touches the previous good export', async () => {
  await withBridge(async ({ base, outRoot }) => {
    assert.equal((await streamExport(base, payload())).r.status, 200);
    const dir = path.join(outRoot, 'login-screen');
    const before = await fs.readFile(path.join(dir, 'spec.md'), 'utf8');

    // finish lists a file that never arrived -> rejected, old export intact
    const p = payload();
    const { id } = await streamExport(base, { ...p, files: p.files.slice(0, 1) }, { skipFinish: true });
    const { files, ...rest } = p;
    const bad = await fetch(`${base}/exports/${id}/finish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...rest, files: files.map((f) => f.path) }),
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /not uploaded: assets\/icon-arrow-right\.svg/);
    assert.equal(await fs.readFile(path.join(dir, 'spec.md'), 'utf8'), before);
    // the session is gone after a failed finish
    assert.equal((await fetch(`${base}/exports/${id}/finish`, { method: 'POST', body: '{}' })).status, 404);

    // abort removes the staged files
    const ab = await streamExport(base, payload(), { skipFinish: true });
    assert.equal((await fetch(`${base}/exports/${ab.id}/abort`, { method: 'POST' })).status, 200);
    assert.deepEqual(await fs.readdir(path.join(outRoot, '.figma-lens-uploads')), []);
    assert.equal(await fs.readFile(path.join(dir, 'spec.md'), 'utf8'), before);
  });
});

test('streamed uploads reject unsafe paths, reserved names and foreign origins', async () => {
  await withBridge(async ({ base, outRoot }) => {
    const { id } = await (await fetch(base + '/exports', { method: 'POST' })).json();
    for (const bad of ['../evil.txt', 'a/../../evil.txt', '/abs.txt', '.figma-lens.json', 'auto/run.json', 'Auto/x', '']) {
      const r = await fetch(`${base}/exports/${id}/files?path=${encodeURIComponent(bad)}`, { method: 'POST', body: 'x' });
      assert.equal(r.status, 400, bad);
    }
    await assert.rejects(fs.access(path.join(outRoot, '..', 'evil.txt')));
    const evil = await fetch(base + '/exports', { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal((await fetch(`${base}/exports/00000000-0000-0000-0000-000000000000/files?path=a.png`, { method: 'POST', body: 'x' })).status, 404);
  });
});

// ---------- the previous export survives every failure ----------

async function snapshot(dir) {
  const out = {};
  async function walk(rel) {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else out[r] = (await fs.readFile(path.join(dir, r))).toString('base64');
    }
  }
  await walk('');
  return out;
}

test('a file listed twice is rejected before anything is written (streamed and single request)', async () => {
  await withBridge(async ({ base, outRoot }) => {
    assert.equal((await streamExport(base, payload())).r.status, 200);
    const dir = path.join(outRoot, 'login-screen');
    const before = await snapshot(dir);

    const p = payload();
    const { id } = await streamExport(base, p, { skipFinish: true });
    const { files, ...rest } = p;
    const dup = await fetch(`${base}/exports/${id}/finish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...rest, files: [...files.map((f) => f.path), 'screen@2x.png'] }),
    });
    assert.equal(dup.status, 400);
    assert.match((await dup.json()).error, /listed twice: screen@2x\.png/);

    const legacy = payload();
    legacy.files = [...legacy.files, { ...legacy.files[1], path: 'ASSETS/icon-arrow-right.svg' }]; // same file on Windows/macOS
    const r = await post(base, legacy);
    assert.equal(r.status, 400);
    assert.deepEqual(await snapshot(dir), before);
  });
});

test('a failure while building the new export leaves the previous export byte for byte', async () => {
  await withBridge(async ({ base, outRoot }) => {
    assert.equal((await streamExport(base, payload())).r.status, 200);
    const dir = path.join(outRoot, 'login-screen');
    await fs.mkdir(path.join(dir, 'auto'));
    await fs.writeFile(path.join(dir, 'auto', 'run.json'), '{"status":"running"}');
    const before = await snapshot(dir);

    // the staged screenshot disappears before finish: placing it fails after validation passed
    const p = payload();
    const { id } = await streamExport(base, p, { skipFinish: true });
    const staging = path.join(outRoot, '.figma-lens-uploads', id);
    await fs.rm(path.join(staging, 'screen@2x.png'));
    const { files, ...rest } = p;
    const r = await fetch(`${base}/exports/${id}/finish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...rest, files: files.map((f) => f.path) }),
    });
    assert.equal(r.status, 500);
    assert.deepEqual(await snapshot(dir), before);
    assert.deepEqual(await fs.readdir(path.join(outRoot, '.figma-lens-uploads')), []); // work folders cleaned up
    // and the frame still owns its folder: the next export goes to the same place
    const again = await streamExport(base, payload());
    assert.equal(again.j.dir, dir);
  });
});

test('swapInto: a failed move mid-swap puts the old export back; auto/ and the marker are never moved out', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-lens-swap-'));
  try {
    const dir = path.join(root, 'frame');
    const built = path.join(root, 'build');
    for (const [f, text] of [['.figma-lens.json', 'old marker'], ['spec.md', 'old spec'], ['assets/a.svg', 'old a'], ['auto/run.json', 'run']]) {
      await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await fs.writeFile(path.join(dir, f), text);
    }
    for (const [f, text] of [['.figma-lens.json', 'new marker'], ['spec.md', 'new spec'], ['assets/b.svg', 'new b'], ['tokens.json', 'new tokens']]) {
      await fs.mkdir(path.dirname(path.join(built, f)), { recursive: true });
      await fs.writeFile(path.join(built, f), text);
    }
    const before = await snapshot(dir);
    let moves = 0;
    const flaky = async (a, b) => {
      if (++moves === 4) throw Object.assign(new Error('EBUSY: file is open'), { code: 'EBUSY' }); // 2 out, then fail on the 2nd in
      await fs.rename(a, b);
    };
    await assert.rejects(swapInto(dir, built, { rename: flaky }), /EBUSY/);
    assert.deepEqual(await snapshot(dir), before);
    await assert.rejects(fs.access(built + '-old'));

    // and without the failure: new contents, auto/ kept, marker replaced
    const fresh = path.join(root, 'build2');
    await fs.mkdir(fresh);
    await fs.writeFile(path.join(fresh, '.figma-lens.json'), 'new marker');
    await fs.writeFile(path.join(fresh, 'spec.md'), 'new spec');
    await swapInto(dir, fresh);
    const after = await snapshot(dir);
    assert.deepEqual(Object.keys(after).sort(), ['.figma-lens.json', 'auto/run.json', 'spec.md']);
    assert.equal(Buffer.from(after['.figma-lens.json'], 'base64').toString(), 'new marker');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
