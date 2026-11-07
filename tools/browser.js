// figma-lens browser: export frames from figma.com in your own Chrome/Chromium/Edge, on Linux, macOS
// or Windows, without the Figma desktop app or a plugin.
//
// How: the browser is started as a NORMAL window (not an automated one, so Google sign-in works) with
// its own profile (you sign in once) and a DevTools port on 127.0.0.1 chosen by the browser. figma-lens
// connects to it, injects plugin/dist/page.js into the open Figma file and reads the frames with the
// same code as the desktop plugin. Files come back through a function exposed on the page and are
// written with the bridge's writeExport (same staging, rollback and folder rules).
//
// Settings, highest priority first: command-line flags > environment variables > the "browser"
// section of figma-lens.config.json > auto-detection. `figma-lens browser --doctor` shows the result.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeExportFromFiles, stagingDir, autoHandler } from '../bridge/server.js';
import { screenTargets } from '../bridge/flows.js';
import { CONFIG_FILE } from './auto.js';
import { c } from './colors.js';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PAGE_BUNDLE = path.join(REPO, 'plugin', 'dist', 'page.js');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

export const BROWSER_DEFAULTS = {
  executable: null, // null = auto-detect; a path, a command on PATH, or a list like ["flatpak", "run", "com.google.Chrome"]
  profile: null, // null = auto (see defaultProfile)
  out: null, // null = ./design
  startUrl: 'https://www.figma.com/files/recents-and-sharing',
  scale: 2,
  css: true,
  sections: true,
  maxLayers: 0,
  cssLimit: 3000,
  startTimeoutSeconds: 30,
  flowMax: 30, // --flow stops after this many screens (0 = no limit)
  files: {}, // the project's Figma links by name: { "login": "https://www.figma.com/design/…?node-id=12-34" }
  args: [], // extra browser flags, e.g. ["--ignore-gpu-blocklist"]
};

// Figma needs WebGL. Without a GPU the browser trusts (WSL, virtual machines, remote desktops) Chromium
// has none, and since Chrome 137 it no longer falls back to software on its own. This flag lets it use
// the system's software OpenGL (Mesa llvmpipe). figma-lens adds it by itself when WebGL is off and
// remembers that in the profile (GL_MARK), so the next start needs no restart.
export const SOFTWARE_GL = '--ignore-gpu-blocklist';
const GL_MARK = 'figma-lens-software-gl';
const OWN_FLAGS = ['--user-data-dir', '--remote-debugging-port', '--remote-debugging-pipe']; // figma-lens sets these
const KEYS = Object.keys(BROWSER_DEFAULTS);

export const ENV = {
  executable: 'FIGMA_LENS_BROWSER',
  profile: 'FIGMA_LENS_PROFILE',
  out: 'FIGMA_LENS_OUT',
};

// ---------- configuration ----------

/** Read and validate the "browser" section of figma-lens.config.json (the rest of the file is ignored). */
export function loadBrowserConfig(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
  const b = (raw && raw.browser) || {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new Error(`${file}: "browser" must be an object`);
  for (const k of Object.keys(b)) {
    if (!KEYS.includes(k)) throw new Error(`${file}: unknown setting browser.${k} (known: ${KEYS.join(', ')})`);
  }
  const ex = b.executable;
  if (ex != null && typeof ex !== 'string' && !(Array.isArray(ex) && ex.length && ex.every((s) => typeof s === 'string'))) {
    throw new Error(`${file}: browser.executable must be a path, a command name, or a list like ["flatpak", "run", "com.google.Chrome"]`);
  }
  for (const k of ['profile', 'out', 'startUrl']) {
    if (b[k] != null && typeof b[k] !== 'string') throw new Error(`${file}: browser.${k} must be a string`);
  }
  if (b.args != null) {
    if (!Array.isArray(b.args) || !b.args.every((s) => typeof s === 'string' && s.startsWith('--'))) {
      throw new Error(`${file}: browser.args must be a list of browser flags, like ["--ignore-gpu-blocklist"]`);
    }
    const own = b.args.find((s) => OWN_FLAGS.some((f) => s === f || s.startsWith(f + '=')));
    if (own) throw new Error(`${file}: browser.args: ${own} is set by figma-lens (use "profile" for the profile folder)`);
  }
  if (b.scale != null && ![1, 2, 3, 4].includes(b.scale)) throw new Error(`${file}: browser.scale must be 1, 2, 3 or 4`);
  if (b.files != null) {
    if (typeof b.files !== 'object' || Array.isArray(b.files)) throw new Error(`${file}: browser.files must be an object: { "name": "https://www.figma.com/design/…?node-id=…" }`);
    for (const [name, url] of Object.entries(b.files)) {
      if (!/^[\w.-]+$/.test(name)) throw new Error(`${file}: browser.files: name "${name}" may only use letters, digits, _ . -`);
      try {
        parseFigmaUrl(String(url));
      } catch (e) {
        throw new Error(`${file}: browser.files.${name}: ${e.message}`);
      }
    }
  }
  for (const k of ['maxLayers', 'cssLimit', 'startTimeoutSeconds', 'flowMax']) {
    if (b[k] != null && !(Number.isInteger(b[k]) && b[k] >= 0)) throw new Error(`${file}: browser.${k} must be a whole number, 0 or more`);
  }
  for (const k of ['css', 'sections']) {
    if (b[k] != null && typeof b[k] !== 'boolean') throw new Error(`${file}: browser.${k} must be true or false`);
  }
  // null means "not set": fall through to the environment / auto-detection.
  return Object.fromEntries(Object.entries(b).filter(([, v]) => v !== null));
}

function expandHome(p, home) {
  if (typeof p !== 'string') return p;
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

function onPath(cmd, env) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  for (const d of dirs) for (const e of exts) {
    const f = path.join(d, cmd + e);
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {
      // not here
    }
  }
  return null;
}

function listFlatpaks() {
  const r = spawnSync('flatpak', ['list', '--app', '--columns=application'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? String(r.stdout).split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/** Browsers we look for, in order. Each: { cmd: [...], kind: 'regular'|'snap'|'flatpak', label }. */
export function browserCandidates(platform, env, { exists = fs.existsSync, which = (name) => onPath(name, env), flatpakApps = listFlatpaks } = {}) {
  const out = [];
  const add = (cmd, kind, label) => out.push({ cmd, kind, label });
  if (platform === 'linux') {
    for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'microsoft-edge']) {
      const p = which(name);
      if (!p || out.some((b) => b.cmd[0] === p)) continue;
      const snap = isSnap(p, exists);
      add([p], snap ? 'snap' : 'regular', name + (snap ? ' (snap)' : ''));
    }
    if (exists('/snap/bin/chromium') && !out.some((b) => b.kind === 'snap')) add(['/snap/bin/chromium'], 'snap', 'chromium (snap)');
    for (const id of flatpakApps()) {
      if (['com.google.Chrome', 'org.chromium.Chromium', 'com.microsoft.Edge'].includes(id)) add(['flatpak', 'run', id], 'flatpak', id + ' (flatpak)');
    }
  } else if (platform === 'darwin') {
    for (const app of ['Google Chrome', 'Chromium', 'Microsoft Edge']) {
      const p = `/Applications/${app}.app/Contents/MacOS/${app}`;
      if (exists(p)) add([p], 'regular', app);
    }
  } else if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean);
    for (const r of roots) for (const [rel, label] of [['Google/Chrome/Application/chrome.exe', 'Chrome'], ['Microsoft/Edge/Application/msedge.exe', 'Edge']]) {
      const p = path.join(r, rel);
      if (exists(p)) add([p], 'regular', label);
    }
  }
  return out;
}

// Ubuntu's chromium and chromium-browser commands (/usr/bin/…) are wrappers that start the snap.
function isSnap(p, exists) {
  const s = String(p);
  return s.startsWith('/snap/') || (path.posix.basename(s).startsWith('chromium') && exists('/snap/bin/chromium') && !exists('/usr/lib/chromium/chromium'));
}

/** regular | snap | flatpak, for a browser command set by hand (auto-detection already knows). */
export function kindOf(cmd, platform = process.platform, exists = fs.existsSync) {
  if (path.basename(cmd[0]) === 'flatpak') return 'flatpak';
  return platform === 'linux' && isSnap(cmd[0], exists) ? 'snap' : 'regular';
}

/**
 * Where the browser keeps the figma-lens login. Snap Chromium can't write hidden folders in your home
 * (~/.something), and a Flatpak browser only sees its own folder, so they get a profile inside their
 * own data folder instead.
 */
export function defaultProfile(kind, home, cmd = []) {
  if (kind === 'snap') return path.join(home, 'snap', 'chromium', 'common', 'figma-lens-profile');
  if (kind === 'flatpak') return path.join(home, '.var', 'app', cmd[cmd.length - 1] || 'browser', 'figma-lens-profile');
  return path.join(home, '.figma-lens', 'browser-profile');
}

/**
 * Final settings and where each one came from (flag | env … | config | auto | default).
 * Throws with a fix-it message when no browser can be found.
 */
export function resolveBrowserSettings({ flags = {}, env = process.env, cwd = process.cwd(), platform = process.platform, home = os.homedir(), detect, exists = fs.existsSync } = {}) {
  const configFile = flags.config
    ? path.resolve(cwd, flags.config)
    : [cwd, path.dirname(cwd)].map((d) => path.join(d, CONFIG_FILE)).find((f) => fs.existsSync(f)) || null;
  const conf = configFile ? loadBrowserConfig(configFile) : {};
  const confDir = configFile ? path.dirname(configFile) : cwd;
  const from = {};
  const pick = (key, flagVal, envName) => {
    if (flagVal !== undefined) return (from[key] = 'flag'), flagVal;
    if (envName && env[envName]) return (from[key] = 'env ' + envName), env[envName];
    if (conf[key] !== undefined) return (from[key] = 'config'), conf[key];
    return (from[key] = 'default'), BROWSER_DEFAULTS[key];
  };

  const executable = pick('executable', flags.browser, ENV.executable);
  let cmd;
  let label;
  let kind;
  if (executable) {
    cmd = Array.isArray(executable) ? executable.map((s) => expandHome(s, home)) : [expandHome(executable, home)];
    if (!cmd[0].includes('/') && !cmd[0].includes('\\')) cmd[0] = onPath(cmd[0], env) || cmd[0];
    label = cmd.join(' ');
    kind = kindOf(cmd, platform, exists);
  } else {
    const found = (detect || browserCandidates)(platform, env);
    if (!found.length) {
      const hint = platform === 'linux'
        ? 'Install Google Chrome (https://www.google.com/chrome/) or Chromium, or set "executable" in the "browser" section of figma-lens.config.json, or FIGMA_LENS_BROWSER=/path/to/chrome.'
        : 'Install Google Chrome or Microsoft Edge, or set FIGMA_LENS_BROWSER=/path/to/browser.';
      throw new Error(`no Chrome, Chromium or Edge found. ${hint}`);
    }
    cmd = found[0].cmd;
    label = found[0].label;
    kind = found[0].kind; // detection knows best (e.g. /usr/bin/chromium-browser is a snap wrapper)
    from.executable = 'auto';
  }

  let profile = pick('profile', flags.profile, ENV.profile);
  if (profile) profile = path.resolve(from.profile === 'config' ? confDir : cwd, expandHome(profile, home));
  else {
    from.profile = 'auto';
    profile = defaultProfile(kind, home, cmd);
  }
  let out = pick('out', flags.out, ENV.out);
  out = out ? path.resolve(from.out === 'config' ? confDir : cwd, expandHome(out, home)) : path.resolve(cwd, 'design');

  // Number flags are checked here because a flag skips loadBrowserConfig. A typo or a negative number
  // must stop the run: before, it silently became the default (and a NaN limit never stopped --flow).
  // `true` only comes from callers in code; the CLI already rejects a flag with no value.
  const intFlag = (name, allowed) => {
    const v = flags[name];
    if (v === undefined) return undefined;
    const n = typeof v === 'string' && v.trim() ? Number(v) : NaN;
    if (Number.isInteger(n) && (allowed ? allowed.includes(n) : n >= 0)) return n;
    const want = allowed ? allowed.join(', ') : 'a whole number, 0 or more (0 = no limit)';
    throw new Error(`--${name} must be ${want}; got ${v === true ? 'no value' : JSON.stringify(v)}`);
  };
  const options = {
    scale: pick('scale', intFlag('scale', [1, 2, 3, 4])),
    css: pick('css', flags['no-css'] ? false : undefined),
    sections: pick('sections', undefined),
    maxLayers: pick('maxLayers', intFlag('max-layers')),
    cssLimit: pick('cssLimit', intFlag('css-limit')),
  };
  const flowMax = pick('flowMax', intFlag('flow-max'));
  return {
    configFile,
    cmd,
    label,
    kind,
    profile,
    out,
    startUrl: pick('startUrl', undefined),
    startTimeoutSeconds: pick('startTimeoutSeconds', undefined),
    flowMax,
    args: pick('args', undefined),
    files: conf.files || {},
    mapFile: flags.map ? path.resolve(cwd, flags.map) : undefined,
    options,
    from,
  };
}

// ---------- Figma links ----------

/** https://www.figma.com/design/<key>/<name>?node-id=38-2 → { key, nodeIds: ['38:2'] } */
export function parseFigmaUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a link: ${url}`);
  }
  if (!/(^|\.)figma\.com$/.test(u.hostname)) throw new Error(`not a figma.com link: ${url}`);
  const m = /^\/(design|file|proto)\/([A-Za-z0-9]+)/.exec(u.pathname);
  if (!m) throw new Error(`not a Figma design file link (expected figma.com/design/<key>/…): ${url}`);
  const nodeIds = (u.searchParams.get('node-id') || '')
    .split(',')
    .map((s) => s.trim().replace(/-/g, ':'))
    .filter((s) => /^[A-Za-z0-9]+:[A-Za-z0-9]+(;[A-Za-z0-9]+:[A-Za-z0-9]+)*$/.test(s));
  return { key: m[2], nodeIds };
}

/** A Figma link, or the name of one in the "files" setting. */
export function resolveLink(input, settings) {
  const s = String(input || '').trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return parseFigmaUrl(s) && s;
  if (settings.files && Object.prototype.hasOwnProperty.call(settings.files, s)) return settings.files[s];
  const names = Object.keys(settings.files || {});
  throw new Error(`"${s}" is not a Figma link${names.length ? ` or a name from browser.files (${names.join(', ')})` : ' (add named links to "files" in the "browser" section of figma-lens.config.json)'}`);
}

function fileKeyOf(pageUrl) {
  const m = /figma\.com\/(?:design|file)\/([A-Za-z0-9]+)/.exec(pageUrl || '');
  return m ? m[1] : null;
}

// ---------- the browser process ----------

/** DevToolsActivePort (written by the browser into its profile) holds the port on its first line. */
export function readDevToolsPort(profile) {
  try {
    const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

async function alive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export function displayProblem(platform, env) {
  if (platform !== 'linux') return null;
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return null;
  return 'no graphical display (DISPLAY and WAYLAND_DISPLAY are not set). Run figma-lens browser in a terminal inside your Linux desktop session, not a plain SSH session (or use ssh -X).';
}

/** True when this profile needs software WebGL (figma-lens found WebGL off in it before). */
export function remembersSoftwareGl(profile) {
  return fs.existsSync(path.join(profile, GL_MARK));
}

/** The user's browser.args, plus the software WebGL flag when the profile needs it. */
export function extraArgs(settings) {
  const a = [...(settings.args || [])];
  if (remembersSoftwareGl(settings.profile) && !a.includes(SOFTWARE_GL)) a.push(SOFTWARE_GL);
  return a;
}

/** The browser's command-line arguments (after the executable). debug: false = no DevTools port (--login). */
export function launchArgs(settings, { debug = true, url } = {}) {
  return [
    ...settings.cmd.slice(1),
    `--user-data-dir=${settings.profile}`,
    ...(debug ? ['--remote-debugging-port=0'] : []), // the browser picks a free port on 127.0.0.1 and writes it to DevToolsActivePort
    '--no-first-run',
    '--no-default-browser-check',
    ...extraArgs(settings),
    url || settings.startUrl,
  ];
}

/** The profile is in use while the browser's lock exists (Linux/macOS: a symlink; Windows: a locked file). */
function profileLocked(profile) {
  for (const f of ['SingletonLock', 'lockfile']) {
    try {
      fs.lstatSync(path.join(profile, f)); // lstat: SingletonLock is a symlink to "<host>-<pid>", not a file
      if (f === 'SingletonLock') {
        const pid = Number(/-(\d+)$/.exec(fs.readlinkSync(path.join(profile, f)))?.[1]);
        if (!pid) return true;
        try {
          process.kill(pid, 0); // signal 0: only checks that the process exists
          return true;
        } catch (e) {
          return e.code === 'EPERM'; // ESRCH: a crashed browser left the lock behind
        }
      }
      fs.rmSync(path.join(profile, f)); // Windows: only removable once the browser let it go
    } catch (e) {
      if (f === 'lockfile' && e.code !== 'ENOENT') return true;
    }
  }
  return false;
}

/** Close the whole figma-lens browser (every window of this profile) and wait until it has exited. */
async function closeBrowser(browser, port, profile, timeoutMs = 20000) {
  try {
    const s = await browser.newBrowserCDPSession();
    await s.send('Browser.close').catch(() => undefined); // the connection drops while it answers
  } catch {
    // already closing
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await alive(port)) && !profileLocked(profile)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the browser did not close within ${timeoutMs / 1000}s; close it by hand and run again`);
}

/** Does this browser draw WebGL? (Figma shows "WebGL isn't supported" without it.) Checked in a blank tab. */
async function webglWorks(browser) {
  const page = await browser.contexts()[0].newPage();
  try {
    return await page.evaluate(() => {
      const cv = document.createElement('canvas');
      return !!(cv.getContext('webgl2') || cv.getContext('webgl'));
    });
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** What to do when WebGL is off. triedSoftware: the software flag was already on. */
export function webglHelp(triedSoftware) {
  return triedSoftware
    ? `WebGL is off even with ${SOFTWARE_GL}, so Figma can't open files. Add "--enable-unsafe-swiftshader" to "args" in the ` +
        '"browser" section of figma-lens.config.json (another software renderer), or use Google Chrome. Then close every window of ' +
        'this browser and run figma-lens browser again.'
    : 'WebGL is off in the open figma-lens browser window, so Figma can\'t open files ("WebGL isn\'t supported"). ' +
        'Close every window of this browser (Linux: pkill chromium, or pkill chrome) and run figma-lens browser again: ' +
        `figma-lens then restarts it with software graphics (${SOFTWARE_GL}) by itself.`;
}

/**
 * Make sure Figma can draw in the browser. When figma-lens started it and WebGL is off, it restarts it
 * once with SOFTWARE_GL and remembers that for the profile. Returns the browser to use (and its port).
 */
export async function ensureWebgl(browser, { port, started, settings, log, connect, start = ensureBrowser, works = webglWorks, close = closeBrowser }) {
  if (await works(browser)) return { browser, port };
  const tried = launchArgs(settings).includes(SOFTWARE_GL); // also when it's in an "executable" list
  if (!started || tried) throw new Error(webglHelp(tried));
  log(c.yellow(`WebGL is off in this browser (usual in WSL, virtual machines and remote desktops without a GPU), so Figma can't open files. Restarting it with software graphics (${SOFTWARE_GL}); remembered for this profile.`));
  await close(browser, port, settings.profile);
  fs.writeFileSync(path.join(settings.profile, GL_MARK), `${SOFTWARE_GL}\nWritten by figma-lens: WebGL was off in this browser. Delete this file to start without the flag.\n`);
  const again = await start(settings, { log });
  const b = await connect(again.port);
  if (!(await works(b))) {
    await disconnect(b);
    throw new Error(webglHelp(true));
  }
  log(`${c.green('✔')} WebGL works now (software graphics)`);
  return { browser: b, port: again.port };
}

/**
 * --login: open the browser with the figma-lens profile but WITHOUT the DevTools port, at the Figma
 * login page, and wait until it is closed. For sign-ins (Google) that refuse a browser with a DevTools
 * port open; the login is kept in the profile, so figma-lens browser opens signed in afterwards.
 */
export async function login(settings, { log = console.log, env = process.env, platform = process.platform } = {}) {
  const known = readDevToolsPort(settings.profile);
  if (known && (await alive(known))) throw new Error('the figma-lens browser window is open: close every window of it first, then run figma-lens browser --login again');
  const problem = displayProblem(platform, env);
  if (problem) throw new Error(problem);
  fs.mkdirSync(settings.profile, { recursive: true });
  log(c.gray(`starting ${settings.label} with profile ${settings.profile} (no DevTools port)`));
  log(`Sign in to Figma in the window, check that your files show, then ${c.bold('close the window')}.`);
  const t0 = Date.now();
  const child = spawn(settings.cmd[0], launchArgs(settings, { debug: false, url: 'https://www.figma.com/login' }), { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`could not start ${settings.label}: ${e.message}`)));
    child.on('exit', resolve);
  });
  // Some launchers hand the window to another process and return at once: then wait for the profile lock.
  if (Date.now() - t0 < 5000) log(c.gray('waiting for the browser window to close…'));
  while (profileLocked(settings.profile)) await new Promise((r) => setTimeout(r, 500));
  log(`${c.green('✔')} browser closed. Now run ${c.bold('figma-lens browser')}: it opens signed in.`);
}

/** Use the figma-lens browser window if it is already open, otherwise start it. Returns the DevTools port. */
export async function ensureBrowser(settings, { log = console.log, env = process.env, platform = process.platform } = {}) {
  const known = readDevToolsPort(settings.profile);
  if (known && (await alive(known))) return { port: known, started: false };

  const problem = displayProblem(platform, env);
  if (problem) throw new Error(problem);
  fs.mkdirSync(settings.profile, { recursive: true });
  fs.rmSync(path.join(settings.profile, 'DevToolsActivePort'), { force: true }); // left by a closed window
  const args = launchArgs(settings);
  const extra = extraArgs(settings);
  log(c.gray(`starting ${settings.label} with profile ${settings.profile}${extra.length ? ` and ${extra.join(' ')}` : ''}`));
  const child = spawn(settings.cmd[0], args, { detached: true, stdio: 'ignore' });
  let spawnError = null;
  child.on('error', (e) => (spawnError = e));
  child.unref(); // the window stays open after figma-lens exits, so you stay signed in and keep working

  const deadline = Date.now() + settings.startTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`could not start ${settings.label}: ${spawnError.message}`);
    const port = readDevToolsPort(settings.profile);
    if (port && (await alive(port))) return { port, started: true };
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `${settings.label} did not open its DevTools port within ${settings.startTimeoutSeconds}s. ` +
      'If a window that uses this profile is already open (started without figma-lens), close it and run again. ' +
      'Run figma-lens browser --doctor to check the setup.',
  );
}

// ---------- exporting ----------

function figmaTabs(browser) {
  return browser.contexts().flatMap((ctx) => ctx.pages()).filter((p) => fileKeyOf(p.url()));
}

/** Inject page.js (once per page load) and wait until Figma's page API is there. */
async function prepare(page, timeoutMs) {
  if (!fs.existsSync(PAGE_BUNDLE)) throw new Error(`missing ${PAGE_BUNDLE}: run npm run build in the figma-lens folder`);
  const deadline = Date.now() + timeoutMs;
  let st = null;
  do {
    const has = await page.evaluate(() => (window.__figmaLens ? window.__figmaLens.version : null)).catch(() => null);
    if (has !== VERSION) await page.evaluate(fs.readFileSync(PAGE_BUNDLE, 'utf8')).catch(() => null);
    st = await page.evaluate(() => (window.__figmaLens ? window.__figmaLens.status() : null)).catch(() => null);
    if (st && st.ok) return st;
    await new Promise((r) => setTimeout(r, 500)); // the file is still loading
  } while (Date.now() < deadline);
  if (st && st.reason === 'no-figma') {
    throw new Error(
      "Figma's page API (window.figma) is not available in this tab. figma.com doesn't document it and may have changed it. " +
        'Use the Figma desktop plugin instead (see README).',
    );
  }
  throw new Error(`the Figma file did not finish loading in ${Math.round(timeoutMs / 1000)}s${st && st.message ? ': ' + st.message : ''}`);
}

const exposed = new WeakMap(); // page → delivery

const secs = (ms) => (ms / 1000).toFixed(1) + 's';

/**
 * One exposed function per page. The page awaits every call, so:
 * - each file is written to a staging folder the moment it arrives (a huge frame is never held in
 *   memory as a whole, and the page can't run ahead of the disk);
 * - the export is written (writeExportFromFiles) as soon as its spec arrives, so the terminal shows
 *   each screen as done while the next one is being read.
 * d.ctx (set per run) holds the output settings, the log and the results.
 */
async function deliveryFor(page) {
  let d = exposed.get(page);
  if (d) return d;
  d = { name: '__figmaLensSend_' + randomUUID().replace(/-/g, ''), jobs: new Map(), ctx: null };
  const handle = async (kind, exportId, a, b) => {
    const ctx = d.ctx;
    if (!ctx) return false;
    let job = d.jobs.get(exportId);
    if (!job) d.jobs.set(exportId, (job = { info: { name: '?' }, t0: Date.now(), dir: null, files: [], error: null, result: null }));
    if (kind === 'begin') {
      job.info = JSON.parse(a);
      job.t0 = Date.now();
      ctx.count++;
      const i = job.info;
      ctx.log(`${c.cyan('▶')} ${c.bold(`[${ctx.count}] ${i.name}`)} ${c.gray(`${i.type} ${i.id} · ${i.w}×${i.h} · page "${i.page}"`)}`);
    } else if (kind === 'progress') {
      ctx.log(`  ${c.gray(secs(Date.now() - job.t0).padStart(6))}  ${a}`);
    } else if (kind === 'file') {
      job.dir = job.dir || stagingDir(ctx.settings.out); // a promise: files arrive in parallel
      const file = path.join(await job.dir, 'f' + job.files.length + '-' + randomUUID().slice(0, 8));
      job.files.push({ path: a, file });
      await fs.promises.writeFile(file, Buffer.from(b, 'base64'));
    } else if (kind === 'payload') {
      await finish(ctx, job, JSON.parse(a));
    } else if (kind === 'error') {
      job.error = a;
      ctx.log(`${c.red('✖')} ${a}`);
      await cleanup(job);
    }
    return true;
  };
  await page.exposeFunction(d.name, handle);
  exposed.set(page, d);
  return d;
}

async function cleanup(job) {
  if (job.dir) await fs.promises.rm(await job.dir, { recursive: true, force: true }).catch(() => undefined);
}

async function finish(ctx, job, payload) {
  const { meta, spec, tokens } = payload;
  if (!meta.fileKey && ctx.fileKey) meta.fileKey = ctx.fileKey; // for links to screens not exported yet
  try {
    const r = await writeExportFromFiles(ctx.settings.out, { meta, spec, tokens }, job.files, { mapFile: ctx.settings.mapFile });
    job.result = { name: meta.nodeName, nodeId: meta.nodeId, dir: r.dir, files: r.files, warnings: meta.warnings || [], truncated: meta.truncated, prototype: meta.prototype };
    const rel = path.relative(process.cwd(), r.dir);
    const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : r.dir; // outside this folder: the full path
    ctx.log(`${c.green('✔')} ${c.bold(meta.nodeName)} → ${shown} ${c.gray(`(${meta.nodeCount} layers, ${r.files} files, ${secs(Date.now() - job.t0)})`)}`);
    if (job.result.warnings.length) ctx.log(c.gray(`  ${job.result.warnings.length} warning(s), listed in spec.md`));
    if (meta.truncated) ctx.log(c.yellow('  layer limit reached: some layers were left out (listed in spec.md)'));
    if (ctx.onExported) ctx.onExported(r.dir);
  } catch (e) {
    job.error = `${meta.nodeName}: ${e.message}`;
    ctx.log(`${c.red('✖')} ${job.error}`);
  } finally {
    await cleanup(job);
  }
}

/** The Figma tab to export from, opening the link's file if it isn't open yet. */
async function openTarget(browser, url, log) {
  const tabs = figmaTabs(browser);
  if (url) {
    const link = parseFigmaUrl(url);
    let target = tabs.find((p) => fileKeyOf(p.url()) === link.key) || null;
    if (!target) {
      log(c.gray(`opening ${url}`));
      target = await browser.contexts()[0].newPage();
      await target.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      log(c.gray('waiting for the Figma file to load…'));
    }
    return { target, ids: link.nodeIds.length ? link.nodeIds : null, timeout: 90000 };
  }
  if (!tabs.length) throw new Error('no Figma design file is open in the figma-lens browser window. Open one (sign in first if asked), select frames, then try again.');
  if (tabs.length > 1) {
    for (const p of tabs) {
      const st = await prepare(p, 3000).catch(() => null);
      if (st && st.selection.length) return { target: p, ids: null, timeout: 30000 }; // the tab where something is selected
    }
  }
  return { target: tabs[0], ids: null, timeout: 30000 };
}

/**
 * Export frames from the open Figma file. With `url`: that file (opened if needed) and its ?node-id
 * frames (the selection if the link has none). Otherwise the current selection in the Figma tab.
 * With `flow`: then every screen those frames link to (navigate / replace / overlay), and so on,
 * up to settings.flowMax screens. Returns [{ name, nodeId, dir, files, prototype } | { name?, error }].
 * nodeIds: export exactly these frames instead (figma-lens project: "all screens on the page").
 */
export async function exportFromBrowser(browser, settings, { url, nodeIds, flow = false, log = console.log, onExported } = {}) {
  const t0 = Date.now();
  const opened = await openTarget(browser, url, log);
  const { target, timeout } = opened;
  const ids = nodeIds && nodeIds.length ? nodeIds : opened.ids;
  const st = await prepare(target, timeout);
  if (st.editorType !== 'figma' && st.editorType !== 'dev') throw new Error(`this is a ${st.editorType} file; figma-lens exports Figma Design files`);
  const d = await deliveryFor(target);
  const ctx = { settings, log, onExported, fileKey: fileKeyOf(target.url()), count: 0 };
  d.ctx = ctx;
  d.jobs.clear();
  fs.mkdirSync(settings.out, { recursive: true });

  const what = ids ? `${ids.length} frame(s) from the link` : `${st.selection.length} selected: ${st.selection.map((n) => `"${n.name}"`).join(', ')}`;
  log(`${c.cyan('Figma')} ${c.bold(st.file)} · ${what}${flow ? c.gray(` · following prototype links (${settings.flowMax ? `max ${settings.flowMax} screens` : 'no screen limit'})`) : ''}`);

  const results = [];
  const tried = new Set(ids || st.selection.map((n) => n.id));
  let batch = ids;
  try {
    for (;;) {
      d.jobs.clear();
      const summary = await target.evaluate(([nodeIds, options, name]) => window.__figmaLens.exportNodes(nodeIds, options, name), [batch, settings.options, d.name]);
      for (const e of summary.errors || []) {
        log(`${c.red('✖')} ${e}`);
        results.push({ error: e });
      }
      const now = [];
      for (const e of summary.exports || []) {
        const job = d.jobs.get(e.exportId);
        if (job && job.result) now.push(job.result);
        else {
          const error = (job && job.error) || e.error || 'no data received';
          if (!job || !job.error) log(`${c.red('✖')} ${e.name}: ${error}`);
          results.push({ name: e.name, error });
          if (job) await cleanup(job);
        }
      }
      results.push(...now);
      if (!flow) break;

      const next = [];
      for (const r of now) for (const t of screenTargets(r.prototype)) {
        if (!tried.has(t.id) && !next.some((n) => n.id === t.id)) next.push(t);
      }
      if (!next.length) break;
      const room = settings.flowMax ? settings.flowMax - tried.size : next.length; // 0 = no limit (tried stops cycles)
      if (room <= 0) {
        log(c.yellow(`flow limit reached (${settings.flowMax} screens; raise it with --flow-max): not exported: ${next.map((n) => `"${n.name}"`).join(', ')}. FLOWS.md lists them.`));
        break;
      }
      const take = next.slice(0, room);
      if (!take.length) break; // never send an empty batch: the page would export the selection instead
      log(c.cyan(`↪ following links to ${take.length} more screen(s): ${take.map((n) => `"${n.name}"${n.overlay ? ' (overlay)' : ''}`).join(', ')}`));
      for (const t of take) tried.add(t.id);
      batch = take.map((t) => t.id);
    }
  } finally {
    d.ctx = null;
  }

  const ok = results.filter((r) => !r.error).length;
  const failed = results.length - ok;
  log(`${failed ? c.yellow('■') : c.green('■')} ${ok} screen(s) exported${failed ? `, ${failed} failed` : ''} in ${secs(Date.now() - t0)} → ${settings.out}`);
  if (ok) log(c.gray(`  ${flowsSummary(settings.out)}`));
  return results;
}

/** One line about the screen map written next to INDEX.md. */
function flowsSummary(out) {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(out, 'flows.json'), 'utf8'));
    const n = f.links.filter((l) => l.to).length;
    const missing = f.missing.length ? `, ${f.missing.length} linked screen(s) not exported yet (add --flow, or see the list)` : '';
    return `screen map: ${path.join(out, 'FLOWS.md')} (${f.screens.length} screen(s), ${n} link(s) between screens${missing})`;
  } catch {
    return `screen map: ${path.join(out, 'FLOWS.md')}`;
  }
}

function report(results) {
  return results.length > 0 && results.every((r) => !r.error);
}

// ---------- commands ----------

/** Print every setting, where it came from, and what is wrong. Returns true when ready. */
export async function doctor(settings, { log = console.log, env = process.env, platform = process.platform } = {}) {
  let ok = true;
  const line = (good, label, value, fix) => {
    if (!good) ok = false;
    log(`${good ? c.green('✔') : c.red('✖')} ${label.padEnd(8)} ${value}${!good && fix ? '\n           ' + c.yellow(fix) : ''}`);
  };
  log(c.bold('figma-lens browser: setup check'));
  line(true, 'system', `${platform} ${os.release()}`);
  line(true, 'config', settings.configFile || `none (looked for ${CONFIG_FILE} here and in the parent folder; defaults are used)`);
  const exe = settings.cmd[0];
  const exeOk = settings.kind === 'flatpak'
    ? spawnSync('flatpak', ['info', settings.cmd[settings.cmd.length - 1]], { stdio: 'ignore' }).status === 0
    : fs.existsSync(exe);
  let version = '';
  if (exeOk && settings.kind !== 'flatpak' && platform !== 'win32') {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 10000 });
    version = r.status === 0 ? ' · ' + String(r.stdout).trim() : '';
  }
  line(exeOk, 'browser', `${settings.cmd.join(' ')} [${settings.kind}] (from ${settings.from.executable})${version}`, 'set "executable" in the "browser" section of figma-lens.config.json, or FIGMA_LENS_BROWSER');
  let writable = true;
  try {
    fs.mkdirSync(settings.profile, { recursive: true });
    fs.accessSync(settings.profile, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  line(writable, 'profile', `${settings.profile} (from ${settings.from.profile})`,
    settings.kind === 'snap' ? 'Snap Chromium can only write some folders; keep the default under ~/snap/chromium/common' : 'pick a folder you can write to');
  const extra = extraArgs(settings);
  line(true, 'args', extra.length ? extra.join(' ') + (remembersSoftwareGl(settings.profile) ? ` (${SOFTWARE_GL}: WebGL was off in this browser, remembered in the profile)` : '') : 'none');
  line(true, 'out', `${settings.out} (from ${settings.from.out})`);
  const names = Object.keys(settings.files || {});
  line(true, 'files', names.length ? `${names.length} named link(s): ${names.join(', ')}` : 'none (optional: name the project\'s Figma links in browser.files)');
  const dp = displayProblem(platform, env);
  line(!dp, 'display', dp ? 'none' : platform !== 'linux' ? 'ok' : env.WAYLAND_DISPLAY ? `Wayland ${env.WAYLAND_DISPLAY}` : `X11 ${env.DISPLAY}`, dp);
  line(fs.existsSync(PAGE_BUNDLE), 'bundle', PAGE_BUNDLE, 'run npm run build in the figma-lens folder');
  const port = readDevToolsPort(settings.profile);
  const running = port ? await alive(port) : false;
  line(true, 'window', running ? `open (DevTools port ${port} on 127.0.0.1)` : 'not open (figma-lens browser starts it)');
  log(ok ? c.green('\nReady. Run: figma-lens browser') : c.red('\nFix the ✖ lines above, then run figma-lens browser --doctor again.'));
  return ok;
}

// Figma's login cookie. Checked, not guessed: a signed-in profile has it, a signed-out one doesn't
// (and https://www.figma.com/files sends it to /login). Reading cookies opens no tab and loads nothing.
const AUTH_COOKIE = '__Host-figma.authn';

/** Is this browser signed in to Figma? */
export async function signedIn(browser) {
  const cookies = await browser.contexts()[0].cookies('https://www.figma.com');
  return cookies.some((k) => k.name === AUTH_COOKIE);
}

/**
 * Not signed in: close the figma-lens window and open the sign-in window WITHOUT the DevTools port
 * (Google refuses to sign in while it is open, in Chrome and Chromium), wait until it is closed, then
 * start the figma-lens window again, signed in. Nothing to type: the developer only signs in.
 */
export async function ensureSignedIn(browser, { port, settings, log, connect, isSignedIn = signedIn, close = closeBrowser, signIn = login, start = ensureBrowser, webgl = ensureWebgl }) {
  if (await isSignedIn(browser)) return { browser, port };
  log(c.yellow('Not signed in to Figma in this browser profile yet. Opening the sign-in window (without the DevTools port, so Google accepts it).'));
  await close(browser, port, settings.profile);
  await signIn(settings, { log });
  const again = await start(settings, { log });
  let b = await connect(again.port);
  try {
    ({ browser: b, port } = await webgl(b, { port: again.port, started: again.started, settings, log, connect }));
    if (!(await isSignedIn(b))) throw new Error('still not signed in to Figma. Run the same command again and sign in in the window that opens (then close it).');
  } catch (e) {
    await disconnect(b);
    throw e;
  }
  log(`${c.green('✔')} signed in to Figma`);
  return { browser: b, port };
}

/**
 * The figma-lens browser, ready to export: started (or reused), WebGL working, signed in to Figma.
 * Returns { browser, connect } (connect() reconnects to the same window).
 */
export async function openReady(settings, { log = console.log } = {}) {
  const pw = await import('playwright-core');
  const opened = await ensureBrowser(settings, { log });
  let port = opened.port;
  const connectTo = (p) => pw.chromium.connectOverCDP(`http://127.0.0.1:${p}`);
  let browser = await connectTo(port);
  try {
    ({ browser, port } = await ensureWebgl(browser, { port, started: opened.started, settings, log, connect: connectTo }));
    ({ browser, port } = await ensureSignedIn(browser, { port, settings, log, connect: connectTo }));
  } catch (e) {
    await disconnect(browser); // an open DevTools connection would keep figma-lens from exiting
    throw e;
  }
  log(opened.started ? `${c.green('✔')} browser window open` : c.gray(`using the open figma-lens browser window (DevTools port ${port})`));
  return { browser, connect: () => connectTo(port) };
}

/**
 * The Figma file a link points to (opened if needed): its name and key, the link's frames, the page's
 * prototype start points (flows) and every top-level frame on the page (frames), for figma-lens project.
 */
export async function fileStatus(browser, url, { log = console.log } = {}) {
  const { target, ids, timeout } = await openTarget(browser, url, log);
  const st = await prepare(target, timeout);
  if (st.editorType !== 'figma' && st.editorType !== 'dev') throw new Error(`this is a ${st.editorType} file; figma-lens builds from Figma Design files`);
  return { ...st, fileKey: fileKeyOf(target.url()), ids, flows: st.flows || [], frames: st.frames || [] };
}

/** Start or reuse the window, then export on Enter (or once, with --once or a link). */
export async function runBrowser(settings, { url, once = false, flow = false, auto = false, log = console.log } = {}) {
  const first = resolveLink(url, settings); // a bad link or name fails before the browser starts
  const ready = await openReady(settings, { log });
  let browser = ready.browser;
  const connect = ready.connect;
  // --auto: every exported screen goes to Claude Code, one at a time (same queue and config as bridge --auto).
  const onExported = auto ? autoHandler(settings.out, log) : undefined;
  if (auto) log(`${c.green(c.bold('auto mode: ON'))} — each exported screen is implemented by Claude Code on a figma/<frame> branch`);
  const waitForAuto = async () => {
    if (!onExported) return;
    log(c.gray('auto: waiting for the Claude Code job(s) to finish (Ctrl+C stops waiting)…'));
    await onExported.idle();
  };

  const exportOnce = async (link, asFlow) => {
    if (!browser.isConnected()) browser = await connect();
    return report(await exportFromBrowser(browser, settings, { url: link, flow: asFlow, log, onExported }));
  };

  if (once || first) {
    try {
      const ok = await exportOnce(first, flow);
      await waitForAuto();
      return ok;
    } finally {
      await disconnect(browser);
    }
  }

  const names = Object.keys(settings.files);
  log(`\n${c.bold('Export:')} select frames in Figma, then press ${c.bold('Enter')} here. Or paste a Figma link${names.length ? ' or a name' : ''} and press Enter.`);
  log(`Put ${c.bold('flow')} in front (${c.bold('flow')} + Enter, or ${c.bold('flow <link>')}) to also export every screen it links to. ${c.bold('q')} + Enter quits (the window stays open).`);
  if (names.length) log(c.gray(`Project links (browser.files): ${names.join(', ')}`));
  log(c.gray(`Writing to ${settings.out}`));
  const rl = readline.createInterface({ input: process.stdin });
  for await (const raw of rl) {
    let line = raw.trim();
    if (line === 'q' || line === 'quit' || line === 'exit') break;
    let asFlow = flow;
    if (line === 'flow' || line.startsWith('flow ')) {
      asFlow = true;
      line = line.slice(4).trim();
    }
    try {
      await exportOnce(resolveLink(line, settings), asFlow);
    } catch (e) {
      log(`${c.red('✖')} ${e.message}`);
    }
    log(c.gray(`\nReady: select frames + Enter, a link${names.length ? ' or name' : ''} + Enter, flow …, or q.`));
  }
  rl.close();
  await disconnect(browser);
  await waitForAuto();
  return true;
}

// For a browser we connected to (connectOverCDP), close() only disconnects (Playwright docs);
// the user's window and its tabs stay open.
async function disconnect(browser) {
  try {
    await browser.close();
  } catch {
    // already gone
  }
}

/** The "browser" section `figma-lens browser --init` writes (null = auto-detect). */
export const BROWSER_CONFIG_TEMPLATE = {
  executable: null,
  profile: null,
  out: 'design',
  scale: 2,
  cssLimit: 3000,
  maxLayers: 0,
  flowMax: 30,
  files: {},
  args: [],
};

/** Add a "browser" section to figma-lens.config.json in dir (created if missing); keeps everything else. */
export function initBrowserConfig(dir) {
  const file = path.join(dir, CONFIG_FILE);
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${file}: ${e.message} (fix it by hand; nothing was written)`);
    }
    if (raw.browser) return { file, created: false };
  }
  raw.browser = { ...BROWSER_CONFIG_TEMPLATE };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  return { file, created: true };
}
