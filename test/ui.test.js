// Runs the plugin UI script (plugin/ui.html) against a real bridge: plugin messages in, files on disk out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { createBridge } from '../bridge/server.js';

const UI = fileURLToPath(new URL('../plugin/ui.html', import.meta.url));

function el() {
  return { textContent: '', className: '', title: '', value: '', checked: true, disabled: false, innerHTML: '', children: [],
    prepend(c) { this.children.unshift(c); }, appendChild(c) { this.children.push(c); } };
}

function loadUi(bridgeUrl, fetchImpl = fetch) {
  const els = {};
  const document = {
    getElementById: (id) => (els[id] = els[id] || el()),
    createElement: () => el(),
  };
  const ctx = { document, fetch: (...a) => fetchImpl(...a), setTimeout, setInterval: () => 0, btoa, console, Promise, Error, JSON, Map,
    encodeURIComponent, parent: { postMessage: () => {} } };
  ctx.window = ctx;
  document.getElementById('url').value = bridgeUrl;
  const html = fs.readFileSync(UI, 'utf8');
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  vm.runInNewContext(script, ctx);
  const log = () => document.getElementById('log').children.map((c) => c.textContent);
  const send = (m) => ctx.onmessage({ data: { pluginMessage: m } });
  return { send, log };
}

async function until(fn, ms = 5000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function png(w, h) {
  const p = new PNG({ width: w, height: h });
  p.data.fill(255);
  return new Uint8Array(PNG.sync.write(p));
}

// What the plugin posts for one frame: begin, one message per file, then the payload listing them.
function pluginMessages(exportId) {
  const files = [
    { path: 'assets/icon-star.svg', bytes: new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')) },
    { path: 'screen@1x.png', bytes: png(100, 50) },
  ];
  const meta = { tool: 'figma-lens', version: '0.2.0', file: 'f', page: 'p', nodeId: '5:1', nodeName: 'Tiny', nodeType: 'FRAME',
    width: 100, height: 50, scale: 1, screen: 'screen@1x.png', sections: [], nodeCount: 2, truncated: false, warnings: [], exportedAt: '2026-11-05T00:00:00.000Z' };
  const spec = { id: '5:1', name: 'Tiny', type: 'FRAME', box: { x: 0, y: 0, w: 100, h: 50 },
    children: [{ id: '5:2', name: 'Star', type: 'INSTANCE', box: { x: 4, y: 4, w: 16, h: 16 }, asset: 'assets/icon-star.svg', component: { name: 'Icon/Star' } }] };
  return [
    { type: 'begin', exportId, name: 'Tiny' },
    ...files.map((f) => ({ type: 'file', exportId, ...f })),
    { type: 'payload', exportId, payload: { meta, spec, tokens: { variables: {}, styles: {} }, files: files.map((f) => ({ path: f.path, size: f.bytes.length })) } },
    { type: 'done-reading', count: 1 },
  ];
}

async function withBridge(fn, handler) {
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'figma-lens-ui-'));
  const outRoot = path.join(project, 'design');
  await fsp.mkdir(outRoot);
  const server = handler ? http.createServer(handler(outRoot)) : createBridge({ outRoot, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn({ url: `http://127.0.0.1:${server.address().port}`, outRoot });
  } finally {
    server.close();
    await fsp.rm(project, { recursive: true, force: true });
  }
}

test('plugin UI streams each file as raw bytes and finishes with the spec (no base64 body)', async () => {
  const seen = [];
  const spy = (url, opts = {}) => {
    seen.push({ url: String(url), type: opts.headers && opts.headers['Content-Type'], body: opts.body });
    return fetch(url, opts);
  };
  await withBridge(async ({ url, outRoot }) => {
    const ui = loadUi(url, spy);
    for (const m of pluginMessages('5:1@1')) ui.send(m);
    await until(() => ui.log().some((l) => l.startsWith('✔') || l.startsWith('✖')));
    assert.ok(ui.log().some((l) => /^✔ Tiny → /.test(l)), ui.log().join('\n'));
    const dir = path.join(outRoot, 'tiny');
    // the bridge may rename assets; follow the spec's reference
    const asset = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8')).spec.children[0].asset;
    assert.equal(fs.readFileSync(path.join(dir, asset), 'utf8'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.ok(fs.existsSync(path.join(dir, 'spec.md')));
    const uploads = seen.filter((s) => /\/files\?path=/.test(s.url));
    assert.equal(uploads.length, 2);
    assert.ok(uploads.every((u) => u.type === 'application/octet-stream' && u.body instanceof Uint8Array));
    assert.ok(!seen.some((s) => s.url.endsWith('/export')), 'legacy endpoint not used');
    const fin = seen.find((s) => s.url.endsWith('/finish'));
    assert.doesNotMatch(fin.body, /base64/);
  });
});

test('plugin UI falls back to the single request for an older bridge (no /exports)', async () => {
  await withBridge(async ({ url, outRoot }) => {
    const ui = loadUi(url);
    for (const m of pluginMessages('5:1@2')) ui.send(m);
    await until(() => ui.log().some((l) => l.startsWith('✔') || l.startsWith('✖')));
    assert.ok(ui.log().some((l) => /older bridge/.test(l)), ui.log().join('\n'));
    assert.ok(ui.log().some((l) => /^✔ Tiny → /.test(l)), ui.log().join('\n'));
    const asset = JSON.parse(fs.readFileSync(path.join(outRoot, 'tiny', 'spec.json'), 'utf8')).spec.children[0].asset;
    assert.ok(fs.existsSync(path.join(outRoot, 'tiny', asset)));
  }, (outRoot) => {
    // An old bridge: only /export exists.
    const real = createBridge({ outRoot, log: () => {} });
    return (req, res) => {
      if (req.url.startsWith('/exports')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"not found"}');
      } else real.emit('request', req, res);
    };
  });
});

test('a plugin error mid-export aborts the staged upload', async () => {
  await withBridge(async ({ url, outRoot }) => {
    const ui = loadUi(url);
    const msgs = pluginMessages('5:1@3');
    ui.send(msgs[0]);
    ui.send(msgs[1]);
    ui.send({ type: 'error', exportId: '5:1@3', message: 'Tiny: boom' });
    const staging = path.join(outRoot, '.figma-lens-uploads');
    await until(() => fs.existsSync(staging) && fs.readdirSync(staging).length === 0 && ui.log().some((l) => /boom/.test(l)));
    assert.ok(!fs.existsSync(path.join(outRoot, 'tiny')));
  });
});
