#!/usr/bin/env node
// figma-lens bridge: receives exports from the Figma plugin and writes them to disk
// so Claude Code can read them. Zero config:  node bridge/server.js --out ./design
import http from 'node:http';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { renderSpecFiles, summarizeUsage } from './render-md.js';
import { buildFlows, renderFlowsMd } from './flows.js';
import { planSections, cropSections } from './sections.js';
import { findMap, loadMap } from '../tools/map.js';
import { findConfig, loadAutoConfig, createQueue, runJob, CONFIG_FILE } from '../tools/auto.js';
import { nameAssets } from './asset-names.js';
import { c } from '../tools/colors.js';

const VERSION = '0.2.0';
const MARKER = '.figma-lens.json';
const AUTO_DIR = 'auto'; // auto-mode results inside an export folder; survives re-exports
const MAX_BODY = 300 * 1024 * 1024; // JSON bodies (legacy single-shot export, or spec at finish)
const MAX_FILE = 200 * 1024 * 1024; // one streamed file
const UPLOADS_DIR = '.figma-lens-uploads'; // staging inside outRoot, so finishing is a rename on the same disk
const UPLOAD_TTL_MS = 60 * 60 * 1000; // abandoned uploads are removed after an hour without activity
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._@-]*(\/[A-Za-z0-9][A-Za-z0-9._@-]*)*$/;

export function folderSlug(name, fallback) {
  const s = String(name || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return s || String(fallback || 'frame').replace(/[^A-Za-z0-9]+/g, '-');
}

function insideDir(dir, rel) {
  const full = path.resolve(dir, rel);
  return full.startsWith(path.resolve(dir) + path.sep) ? full : null;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Everything derived from spec + frame preview: section crops, spec.json, spec.md (+ per-section
 * spec files for large frames). Shared by the bridge and `figma-lens render`, which re-runs it
 * on an existing export. With the frame preview it replaces the export's sections/ folder (it only holds
 * generated files); without one it cannot re-crop, so it keeps the existing crops and only
 * replaces the section spec files.
 * Mutates meta (warnings, sectionPlan, sectionFiles). Returns the number of files written.
 */
export async function writeDerived(dir, { meta, spec, tokens, usage, map, screenBuf }) {
  // (also matches the older "screenshot" wording, so re-rendering an old export doesn't duplicate warnings)
  const generated = (w) => /^section crops/.test(w) || /^(screenshot|frame preview) is \d+×\d+px but/.test(w) || /^no (screenshot|frame preview): /.test(w);
  meta.warnings = (Array.isArray(meta.warnings) ? meta.warnings : []).filter((w) => !generated(w));
  const plan = planSections(meta, spec);
  const sectionsDir = path.join(dir, 'sections');
  if (!screenBuf) {
    // Nothing to crop from: never delete crops we cannot regenerate.
    const kept = Array.isArray(meta.sectionFiles) ? meta.sectionFiles : [];
    if (kept.length) meta.warnings.push('no frame preview: kept the existing section crops; they may not match the section list');
    const old = await fs.readdir(sectionsDir).catch(() => []);
    for (const f of old.filter((f) => f.endsWith('.md'))) await fs.rm(path.join(sectionsDir, f), { force: true });
    meta.sectionPlan = plan;
    meta.sectionFiles = kept;
    return (await writeSpecs(dir, { meta, spec, tokens, usage, map })) + 1;
  }
  let sectionFiles = [];
  if (plan.length) {
    try {
      const src = PNG.sync.read(screenBuf);
      const scale = meta.scale || 1;
      const ew = Math.round(meta.width * scale);
      const eh = Math.round(meta.height * scale);
      if (!(Math.abs(src.width - ew) <= 1 && Math.abs(src.height - eh) <= 1)) {
        // Never emit shifted crops: a wrong reference image is worse than none.
        meta.warnings.push(
          `frame preview is ${src.width}×${src.height}px but the frame at ${scale}x should be ${ew}×${eh}px — ` +
            'preview pixels do not map to spec coordinates; section crops skipped',
        );
      } else {
        sectionFiles = cropSections(src, plan, scale);
      }
    } catch (e) {
      meta.warnings.push(`section crops failed: ${e.message}`);
      sectionFiles = [];
    }
  }
  await fs.rm(sectionsDir, { recursive: true, force: true });
  for (const s of sectionFiles) {
    const full = insideDir(dir, s.file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, s.buf);
  }
  meta.sectionPlan = plan;
  meta.sectionFiles = sectionFiles.map(({ file, id, name, box, px }) => ({ file, id, name, box, px }));
  return sectionFiles.length + (await writeSpecs(dir, { meta, spec, tokens, usage, map }));
}

// spec.json + spec.md (+ section spec files). Returns the number of files written.
async function writeSpecs(dir, { meta, spec, tokens, usage, map }) {
  await fs.writeFile(path.join(dir, 'spec.json'), JSON.stringify({ meta, spec }, null, 1));
  const mdFiles = renderSpecFiles({ meta, spec, tokens }, usage, map);
  for (const f of mdFiles) {
    const full = insideDir(dir, f.file);
    if (!full) throw new Error(`unsafe spec file path: ${f.file}`);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, f.text);
  }
  return mdFiles.length + 1;
}

async function readMarker(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

// Folder for this frame: "<slug>", or "<slug>-<nodeId>" when "<slug>" belongs to another frame
// or to something that isn't a figma-lens export. Only ever replaces a folder owned by the same node,
// and keeps using a folder this node already owns (so no stale duplicate is left behind).
async function claimDir(outRoot, slug, nodeId) {
  const idSlug = String(nodeId).replace(/[^A-Za-z0-9]+/g, '-');
  const candidates = [slug, `${slug}-${idSlug}`].map((name) => path.join(outRoot, name));
  for (const dir of candidates) {
    const owner = await readMarker(dir);
    if (owner && owner.nodeId === nodeId) return dir;
  }
  for (const dir of candidates) {
    if (!(await exists(dir))) return dir;
  }
  throw new HttpError(409, `folders "${slug}" and "${slug}-${idSlug}" are taken by other exports or files; rename the frame`);
}

async function writeIndex(outRoot) {
  const rows = [];
  for (const entry of await fs.readdir(outRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = await readMarker(path.join(outRoot, entry.name));
    if (m) rows.push({ dir: entry.name, ...m });
  }
  rows.sort((a, b) => String(b.exportedAt).localeCompare(String(a.exportedAt)));
  const lines = [
    '# Figma exports (figma-lens)',
    '',
    'Read `<folder>/spec.md` first, then look at the frame preview and section crops. How the screens connect: `FLOWS.md`.',
    '',
    '| Folder | Frame | Size | Figma file / page | Exported |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| \`${r.dir}/\` | ${r.nodeName} | ${r.width}×${r.height} | ${r.file} / ${r.page} | ${r.exportedAt} |`),
    '',
  ];
  await fs.writeFile(path.join(outRoot, 'INDEX.md'), lines.join('\n'));
  // The screen map, rebuilt from every export's marker (no spec.json is read).
  const flows = buildFlows([...rows].reverse());
  await fs.writeFile(path.join(outRoot, 'flows.json'), JSON.stringify(flows, null, 1));
  await fs.writeFile(path.join(outRoot, 'FLOWS.md'), renderFlowsMd(flows));
}

// Map is re-read on every export so edits apply without restarting the bridge.
// A broken map must not block exports: warn and continue without it.
function mapFor(outRoot, mapFile, warnings) {
  try {
    return loadMap(mapFile || findMap([outRoot, path.dirname(outRoot)]));
  } catch (e) {
    warnings.push(`component map ignored: ${e.message}`);
    return null;
  }
}

// Every listed path once: a repeat would mean two different files claim one name.
function checkUnique(paths) {
  const seen = new Set();
  for (const p of paths) {
    const key = String(p).toLowerCase(); // one file on Windows and macOS
    if (seen.has(key)) throw new HttpError(400, `file listed twice: ${p}`);
    seen.add(key);
  }
}

function checkFilePath(p) {
  if (typeof p !== 'string') throw new HttpError(400, 'bad file entry');
  if (!SAFE_FILE.test(p) || p.split('/').some((seg) => seg === '..' || seg === '.')) throw new HttpError(400, `unsafe file path: ${p}`);
  if (p === MARKER) throw new HttpError(400, `reserved file name: ${p}`);
  // case-insensitive: Auto/ is the same folder as auto/ on Windows and macOS
  if (p.split('/')[0].toLowerCase() === AUTO_DIR) throw new HttpError(400, `reserved folder: ${AUTO_DIR}/`);
}

// Legacy single request: { meta, spec, tokens, files: [{ path, base64 }] }. Kept for older plugin builds.
export async function writeExport(outRoot, payload, { mapFile } = {}) {
  const { meta, spec, tokens, files } = payload || {};
  if (!meta || !spec || !Array.isArray(files)) throw new HttpError(400, 'payload needs meta, spec and files[]');
  for (const f of files) {
    if (!f || typeof f.base64 !== 'string') throw new HttpError(400, 'bad file entry');
    checkFilePath(f.path);
  }
  checkUnique(files.map((f) => f.path));
  const entries = files.map((f) => ({ path: f.path, place: (full) => fs.writeFile(full, Buffer.from(f.base64, 'base64')) }));
  return commitExport(outRoot, { meta, spec, tokens }, entries, { mapFile });
}

/**
 * Browser export: the files are already on disk (written one by one as they arrived, so a large frame
 * is never held in memory). files: [{ path, file }]; each file is moved into place.
 */
export async function writeExportFromFiles(outRoot, { meta, spec, tokens }, files, { mapFile } = {}) {
  if (!meta || !spec || !Array.isArray(files)) throw new HttpError(400, 'payload needs meta, spec and files[]');
  for (const f of files) checkFilePath(f.path);
  checkUnique(files.map((f) => f.path));
  const entries = files.map((f) => ({ path: f.path, place: (full) => moveFile(f.file, full) }));
  return commitExport(outRoot, { meta, spec, tokens }, entries, { mapFile });
}

/** A fresh staging folder inside outRoot (same disk, so moving files into the export is a rename). */
export async function stagingDir(outRoot) {
  const dir = path.join(outRoot, UPLOADS_DIR, 'browser-' + randomUUID());
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Write one export: replaces the frame's folder (except auto/) with the given files plus everything
 * derived from the spec. files: [{ path, place(fullPath) }]; place() writes or moves the bytes there.
 */
async function commitExport(outRoot, { meta, spec, tokens }, files, { mapFile } = {}) {
  if (meta.tool !== 'figma-lens') throw new HttpError(400, 'not a figma-lens payload');
  // Icons/images named after generic layers (container-12.svg) or hashes get names from their context.
  // nameAssets rewrites path; place() still knows where the bytes are.
  const named = files.map((f) => ({ path: f.path, place: f.place }));
  const { renames } = nameAssets(spec, named);
  if (Object.keys(renames).length) meta.assetRenames = renames;

  const dir = await claimDir(outRoot, folderSlug(meta.nodeName, 'node-' + meta.nodeId), meta.nodeId);
  // Build the complete new export in a work folder first; the frame's folder is only touched once
  // everything is written, so any failure up to here leaves the previous export as it was.
  const work = path.join(outRoot, UPLOADS_DIR, 'build-' + randomUUID());
  await fs.mkdir(work, { recursive: true });
  try {
    let screenBuf = null;
    for (const f of named) {
      const full = insideDir(work, f.path);
      if (!full) throw new HttpError(400, `unsafe file path: ${f.path}`);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await f.place(full);
      if (f.path === meta.screen) screenBuf = await fs.readFile(full);
    }

    meta.warnings = Array.isArray(meta.warnings) ? meta.warnings : [];
    const usage = summarizeUsage(spec);
    const map = mapFor(outRoot, mapFile, meta.warnings);
    await fs.writeFile(path.join(work, 'tokens.json'), JSON.stringify({ ...(tokens || {}), usage }, null, 1));
    const derived = await writeDerived(work, { meta, spec, tokens, usage, map, screenBuf });
    const { warnings, sections, sectionFiles: _sf, sectionPlan: _sp, skipped: _sk, ...markerMeta } = meta;
    await fs.writeFile(path.join(work, MARKER), JSON.stringify(markerMeta, null, 1));

    await swapInto(dir, work);
    await writeIndex(outRoot);
    return { dir, files: files.length + derived + 1 };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/**
 * Replace the contents of `dir` with the contents of `built`, keeping auto/ (an auto-mode run for
 * this frame may still be writing its record there). Old entries are moved aside, not deleted, until
 * every new entry is in; if a move fails, everything is moved back and the error is rethrown.
 * The marker is replaced last (a rename over the old one), so the folder never loses its owner.
 * `rename` is injectable for tests.
 */
export async function swapInto(dir, built, { rename = (a, b) => fs.rename(a, b) } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const aside = built + '-old';
  await fs.mkdir(aside, { recursive: true });
  const movedOut = [];
  const movedIn = [];
  const fresh = (await fs.readdir(built)).filter((e) => e !== AUTO_DIR);
  fresh.sort((a, b) => (a === MARKER) - (b === MARKER)); // marker last: once it is in, nothing else can fail
  let done = false;
  try {
    for (const entry of await fs.readdir(dir)) {
      if (entry === AUTO_DIR || entry === MARKER) continue;
      await rename(path.join(dir, entry), path.join(aside, entry));
      movedOut.push(entry);
    }
    for (const entry of fresh) {
      await rename(path.join(built, entry), path.join(dir, entry));
      movedIn.push(entry);
    }
    done = true;
  } catch (e) {
    for (const entry of movedIn.reverse()) await fs.rm(path.join(dir, entry), { recursive: true, force: true }).catch(() => {});
    for (const entry of movedOut.reverse()) await rename(path.join(aside, entry), path.join(dir, entry)).catch(() => {});
    throw e;
  } finally {
    // On success the old entries go; after a rollback, anything that could not be moved back is kept.
    if (done || (await fs.readdir(aside).catch(() => [])).length === 0) await fs.rm(aside, { recursive: true, force: true });
  }
}

async function moveFile(from, to) {
  try {
    await fs.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

/**
 * Streamed export (plugin 0.2+): no base64 and no giant JSON. Each file is its own raw request,
 * written straight to a staging folder; the frame's folder is only replaced at finish, so a
 * failed or abandoned upload never destroys the previous good export.
 *   POST /exports                      -> { id }
 *   POST /exports/<id>/files?path=...  raw bytes of one file
 *   POST /exports/<id>/finish          { meta, spec, tokens, files: [path, ...] }
 *   POST /exports/<id>/abort
 */
export function createUploads(outRoot, { ttlMs = UPLOAD_TTL_MS, maxFile = MAX_FILE } = {}) {
  const stagingRoot = path.join(outRoot, UPLOADS_DIR);
  const sessions = new Map(); // id -> { dir, files: Map(path -> bytes), touched }

  async function drop(id) {
    const s = sessions.get(id);
    sessions.delete(id);
    if (s) await fs.rm(s.dir, { recursive: true, force: true });
  }

  async function sweep() {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.touched > ttlMs) await drop(id);
    // Leftovers from a bridge that was stopped mid-upload or mid-export. Only old ones: a fresh
    // build-* folder belongs to an export being written right now.
    for (const name of await fs.readdir(stagingRoot).catch(() => [])) {
      if (sessions.has(name)) continue;
      const st = await fs.stat(path.join(stagingRoot, name)).catch(() => null);
      if (st && now - st.mtimeMs > ttlMs) await fs.rm(path.join(stagingRoot, name), { recursive: true, force: true });
    }
  }

  function get(id) {
    const s = sessions.get(id);
    if (!s) throw new HttpError(404, 'unknown or expired upload; export again');
    s.touched = Date.now();
    return s;
  }

  return {
    stagingRoot,
    async start() {
      await sweep();
      const id = randomUUID();
      const dir = path.join(stagingRoot, id);
      await fs.mkdir(dir, { recursive: true });
      sessions.set(id, { dir, files: new Map(), touched: Date.now() });
      return { id, maxFile };
    },
    async receive(id, filePath, req) {
      const s = get(id);
      checkFilePath(filePath);
      const full = insideDir(s.dir, filePath);
      if (!full) throw new HttpError(400, `unsafe file path: ${filePath}`);
      await fs.mkdir(path.dirname(full), { recursive: true });
      try {
        const bytes = await new Promise((resolve, reject) => {
          let size = 0;
          const out = createWriteStream(full);
          const fail = (e) => {
            req.unpipe(out);
            out.destroy();
            reject(e);
          };
          req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxFile) fail(new HttpError(413, `${filePath} is larger than ${Math.round(maxFile / 1048576)} MB`));
          });
          req.on('error', fail);
          req.on('aborted', () => fail(new HttpError(400, `upload of ${filePath} was interrupted`)));
          out.on('error', fail);
          out.on('finish', () => resolve(size));
          req.pipe(out);
        });
        s.files.set(filePath, bytes);
        return { path: filePath, bytes };
      } catch (e) {
        await fs.rm(full, { force: true });
        throw e;
      }
    },
    async finish(id, body, { mapFile } = {}) {
      const s = get(id);
      try {
        const { meta, spec, tokens, files } = body || {};
        if (!meta || !spec || !Array.isArray(files)) throw new HttpError(400, 'finish needs meta, spec and files[]');
        for (const p of files) {
          checkFilePath(p);
          if (!s.files.has(p)) throw new HttpError(400, `file was not uploaded: ${p}`);
        }
        checkUnique(files);
        const entries = files.map((p) => ({ path: p, place: (full) => moveFile(path.join(s.dir, p), full) }));
        return await commitExport(outRoot, { meta, spec, tokens }, entries, { mapFile });
      } finally {
        await drop(id);
      }
    },
    abort: drop,
    active: () => sessions.size,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'export too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// The plugin UI iframe has origin "null"; curl/scripts send no Origin. Any other web page
// open in a browser must not be able to write files through this bridge.
export function originAllowed(origin) {
  if (process.env.FIGMA_LENS_ALLOW_ANY_ORIGIN === '1') return true;
  if (origin === undefined || origin === 'null') return true;
  return /^https:\/\/([a-z0-9-]+\.)*figma\.com$/.test(origin);
}

// onExport(dir) runs after the plugin got its answer (auto mode), so Figma never waits on it.
export function createBridge({ outRoot, mapFile, log = console.log, onExport, uploads } = {}) {
  const root = path.resolve(outRoot || 'design');
  uploads = uploads || createUploads(root);
  const exported = (result, nodeName) => {
    log(`${c.green('✔')} ${c.bold(nodeName)} exported → ${result.dir} ${c.gray(`(${result.files} files)`)}`);
  };
  const afterExport = (result) => {
    if (!onExport) return;
    try {
      onExport(result.dir);
    } catch (e) {
      log(`${c.red('✖ auto:')} ${e.message}`);
    }
  };
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      log(`${c.red('✖')} blocked request from origin ${origin} ${c.gray('(set FIGMA_LENS_ALLOW_ANY_ORIGIN=1 to allow)')}`);
      send(res, 403, { ok: false, error: `origin ${origin} not allowed` });
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      const url = new URL(req.url, 'http://bridge');
      if (req.method === 'GET' && url.pathname === '/health') {
        send(res, 200, { ok: true, tool: 'figma-lens', version: VERSION, outRoot: root, upload: 1 });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/exports') {
        send(res, 200, { ok: true, ...(await uploads.start()) });
        return;
      }
      const m = /^\/exports\/([0-9a-f-]{36})\/(files|finish|abort)$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const [, id, action] = m;
        if (action === 'files') {
          send(res, 200, { ok: true, ...(await uploads.receive(id, url.searchParams.get('path'), req)) });
        } else if (action === 'abort') {
          await uploads.abort(id);
          send(res, 200, { ok: true });
        } else {
          let body;
          try {
            body = JSON.parse(await readBody(req));
          } catch (e) {
            throw e instanceof HttpError ? e : new HttpError(400, 'body is not valid JSON');
          }
          const result = await uploads.finish(id, body, { mapFile });
          exported(result, body.meta.nodeName);
          send(res, 200, { ok: true, ...result });
          afterExport(result);
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/export') {
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          throw new HttpError(400, 'body is not valid JSON');
        }
        const result = await writeExport(root, payload, { mapFile });
        exported(result, payload.meta.nodeName);
        send(res, 200, { ok: true, ...result });
        afterExport(result);
        return;
      }
      send(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) log(`${c.red('✖')} ${e.stack || e.message}`);
      else log(`${c.red('✖')} ${e.message}`);
      if (!res.headersSent) send(res, status, { ok: false, error: e.message });
    }
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (argv[i] === '--map') out.map = argv[++i];
    else if (argv[i] === '--auto') out.auto = true;
  }
  return out;
}

// Auto mode: one queue for the whole bridge. The config is re-read for every export, so edits
// (or turning auto.enabled off) apply without restarting the bridge.
export function autoHandler(outRoot, log = console.log) {
  const queue = createQueue(async (dir) => {
    const configFile = findConfig([outRoot, path.dirname(outRoot)]);
    if (!configFile) return log(`${c.yellow('⚠ auto:')} no ${CONFIG_FILE} next to ${outRoot} — run ${c.bold('figma-lens auto --init')} in your project`);
    if (!loadAutoConfig(configFile).enabled) return log(`${c.yellow('⚠ auto:')} auto.enabled is false in ${configFile}`);
    await runJob({ frameDir: dir, configFile, log });
  });
  const handle = (dir) => {
    if (!queue.enqueue(dir)) log(c.gray(`… auto: ${path.basename(dir)} is already waiting; it will use this export`));
  };
  handle.idle = queue.idle; // for tests: resolves when the queue is empty
  return handle;
}

export function startBridge({ port, out, map, auto } = {}) {
  port = port || Number(process.env.FIGMA_LENS_PORT) || 4141;
  const outRoot = path.resolve(out || process.env.FIGMA_LENS_OUT || 'design');
  const mapFile = map ? path.resolve(map) : undefined;
  const onExport = auto ? autoHandler(outRoot) : undefined;
  const uploads = createUploads(outRoot);
  // Loopback only (never the LAN). Figma may resolve "localhost" to IPv4 or IPv6, so bind both.
  createBridge({ outRoot, mapFile, onExport, uploads })
    .on('error', (e) => {
      console.error(`cannot listen on 127.0.0.1:${port}: ${e.message}`);
      process.exit(1);
    })
    .listen(port, '127.0.0.1', () => {
      console.log(`${c.cyan(c.bold('figma-lens bridge'))} ${c.gray(VERSION)} on ${c.cyan(`http://localhost:${port}`)}`);
      console.log(`${c.gray('writing exports to')} ${outRoot}`);
      console.log(`${c.gray('component map:')} ${mapFile || findMap([outRoot, path.dirname(outRoot)]) || c.yellow('(none yet — run figma-lens map)')}`);
      if (auto) {
        const cfg = findConfig([outRoot, path.dirname(outRoot)]);
        console.log(`${c.green(c.bold('auto mode: ON'))} — each export is implemented by Claude Code on a figma/<frame> branch ${c.gray(`(${cfg || `no ${CONFIG_FILE} yet — run figma-lens auto --init`})`)}`);
      }
    });
  createBridge({ outRoot, mapFile, onExport, uploads })
    .on('error', () => {
      // IPv6 loopback unavailable; IPv4 is enough
    })
    .listen(port, '::1');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBridge(parseArgs(process.argv.slice(2)));
}
