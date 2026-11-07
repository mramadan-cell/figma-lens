// figma-lens project: build a whole app from Figma, screen by screen, unattended.
//
//   figma-lens project "<link to the first screen>"
//
// 1. The browser opens signed in (sign-in happens in a window without the DevTools port, by itself).
// 2. The screens: the link's screen and every screen its prototype links lead to (FLOWS.md). If the
//    screen has no prototype links, the developer chooses: this screen only, every screen on the page
//    (canvas order), or stop.
// 3. One git worktree on ONE branch, figma/app-<file>: screens are built one after another, so later
//    screens reuse the components, icons and tokens the earlier ones added.
// 4. Each screen is a normal auto-mode Claude Code run (same safety: Claude can't commit, push, switch
//    branches or delete). When it finishes and auto.verify passes, figma-lens commits it on that branch
//    with trailers (Figma-Node, Figma-Spec). Failed: retried with the error; still failing: the attempt
//    is saved as a .patch, the worktree is reset to the last good screen, the screen is "needs review",
//    and the next screen is built.
// 5. The trailers are the memory: run the same command again and it knows what is built, what changed in
//    Figma since, and what is next. design/PROJECT.md shows it after every step. Never touches main,
//    never pushes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { loadAutoConfig, findConfig, planWorktree, createWorktree, runJob, CONFIG_FILE } from './auto.js';
import { openReady, fileStatus, exportFromBrowser, resolveLink } from './browser.js';
import { screenTargets } from '../bridge/flows.js';
import { c } from './colors.js';

export const NODE_TRAILER = 'Figma-Node';
export const SPEC_TRAILER = 'Figma-Spec';
const STATE_FILE = 'project.json';
const REPORT_FILE = 'PROJECT.md';
// Problems another attempt can't fix: stop the whole run (the next run continues where it stopped).
const FATAL = /usage limit|limit was reached|not logged in|could not start|claude program was not found/i;

// ---------- pure helpers (tested) ----------

/** "Shop App (v2)" → "shop-app-v2" */
export function slug(s) {
  const out = String(s || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return out || 'app';
}

/** The same Figma screen across exports and runs: file + node id. */
export const screenKey = (fileKey, file, nodeId) => `${fileKey || file || '?'}#${nodeId}`;

/** What a screen looks like (spec + tokens), not when it was exported: same design → same hash. */
export function specHash(dir) {
  const { spec } = JSON.parse(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'));
  let tokens = '';
  try {
    tokens = fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8');
  } catch {
    tokens = '';
  }
  return crypto.createHash('sha1').update(JSON.stringify(spec)).update('\n').update(tokens).digest('hex').slice(0, 12);
}

/**
 * Screens already built, from commit messages: "Figma-Node: <key>" and "Figma-Spec: <hash>".
 * log: `git log --format=%H%x1f%B%x1e` output. Newest first, so the first one seen per screen wins.
 * Every pair in a commit counts, indented or not: a squash merge puts all the screens' messages,
 * indented, into one commit ("Squashed commit of the following: …"), newest first.
 */
export function builtFromLog(log) {
  const built = new Map();
  const nodeRe = new RegExp(`^[ \\t>*-]*${NODE_TRAILER}: (\\S+)[ \\t]*$`, 'gm');
  const specRe = new RegExp(`^[ \\t>*-]*${SPEC_TRAILER}: (\\S+)`, 'm');
  for (const rec of String(log || '').split('\x1e')) {
    const [hash, body] = rec.replace(/^\s+/, '').split('\x1f');
    if (!hash || !body) continue;
    const nodes = [...body.matchAll(nodeRe)];
    nodes.forEach((m, i) => {
      if (built.has(m[1])) return;
      // This screen's spec line: after its node line, before the next screen's node line.
      const end = i + 1 < nodes.length ? nodes[i + 1].index : body.length;
      const spec = specRe.exec(body.slice(m.index, end));
      built.set(m[1], { commit: hash.trim().slice(0, 9), spec: spec ? spec[1] : null });
    });
  }
  return built;
}

/**
 * Status of every screen, in build order:
 * done (built, same design) · changed (built, the design changed in Figma since) ·
 * needs-review (failed last time; tried again) · todo.
 */
export function planScreens(screens, built, previous) {
  const prev = new Map(((previous && previous.screens) || []).map((s) => [s.key, s]));
  return screens.map((s) => {
    const b = built.get(s.key);
    const p = prev.get(s.key) || {};
    const status = b ? (b.spec === s.spec ? 'done' : 'changed') : p.status === 'needs-review' ? 'needs-review' : 'todo';
    return { ...s, status, commit: b ? b.commit : null, attempts: p.attempts || 0, ...(status === 'needs-review' ? { reason: p.reason, patch: p.patch } : {}) };
  });
}

/** Screens on a page in reading order: rows top to bottom, each row left to right. */
export function canvasOrder(frames) {
  const byY = [...frames].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const f of byY) {
    const row = rows[rows.length - 1];
    // Same row: starts within half the height of the row's first frame (designers rarely align exactly).
    if (row && f.y - row[0].y < Math.max(1, Math.min(row[0].h, f.h) / 2)) row.push(f);
    else rows.push([f]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
}

/** What Claude is told on top of the normal auto prompt: the app around this screen. */
export function projectPrompt({ screen, index, total, built, next, flowsFile, branch, verify, kitFile }) {
  const kit = built.length && kitFile
    ? `  ${kitFile} lists the files each built screen added: read it first instead of exploring the codebase (\`git show <commit>\` for details).`
    : '  `git log` and `git show` show what each screen added.';
  return [
    `THIS SCREEN IS PART OF AN APP that figma-lens builds screen by screen, unattended, on branch ${branch}.`,
    `- Screen ${index} of ${total}: ${JSON.stringify(screen.name)}.`,
    `- Already built on this branch (committed): ${built.length ? built.map((n) => JSON.stringify(n)).join(', ') : 'none yet: this is the first screen, so set up shared parts (tokens, kit components, layout) cleanly; the next screens reuse them'}.`,
    '  Reuse what they added (UI components, icons, tokens, layout); never make a second copy of something that exists.',
    kit,
    `- Still to build after this one: ${next.length ? next.map((n) => JSON.stringify(n)).join(', ') : 'none (this is the last screen)'}. Don't build them now.`,
    `- Navigation: ${flowsFile} lists the prototype links between the screens (spec.md shows them under each layer, lines starting with →). Wire this screen's links: to a screen already built, use its route; to a screen not built yet, use the route it will get (its name in kebab-case), it is built later in this run.`,
    "- Open only this screen's export images, never another screen's.",
    `- figma-lens commits this screen for you when you are done${verify ? ` and \`${verify}\` passes in this checkout; run it yourself before you finish` : ''}. Do not commit.`,
    "- Don't change the project's checks (package.json scripts, lint, tsconfig or analysis options) to make them pass. If a change there is really needed, explain it in your report: figma-lens flags such changes for review.",
  ].join('\n');
}

const statusText = { done: '✔ built', changed: '◐ changed in Figma', 'needs-review': '✖ needs review', todo: '· to build', building: '▶ building' };

/** design/PROJECT.md */
export function renderProjectMd(state) {
  const s = state.screens;
  const count = (st) => s.filter((x) => x.status === st).length;
  const next = s.find((x) => x.status === 'todo' || x.status === 'needs-review' || x.status === 'building');
  const out = [
    `# App build: ${state.file} (figma-lens project)`,
    '',
    `Branch \`${state.branch}\` · worktree \`${state.worktree}\` · updated ${state.updatedAt}`,
    '',
    `**${count('done')} of ${s.length} screens built**${count('needs-review') ? ` · ${count('needs-review')} need review` : ''}${count('changed') ? ` · ${count('changed')} changed in Figma since they were built` : ''}.`,
    `**Next:** ${next ? `${JSON.stringify(next.name)}` : 'nothing: every screen is built'}. Run the same command again to continue: \`${state.command}\``,
    '',
    '| # | Screen | Status | Commit | Notes |',
    '|---|---|---|---|---|',
    ...s.map((x, i) => `| ${i + 1} | ${String(x.name).replace(/\|/g, '\\|')} | ${statusText[x.status] || x.status} | ${x.commit ? `\`${x.commit}\`` : '—'} | ${String(x.reason || (x.status === 'changed' ? 'design changed after it was built: rebuild it by hand, or ask Claude to update it' : '') || (x.verifyChanged && x.verifyChanged.length ? `⚠ changed the project's checks (${x.verifyChanged.join(', ')}): review that` : '')).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200)}${x.patch ? ` (attempt saved: \`${x.patch}\`)` : ''} |`),
    '',
    '## Review and keep',
    '```',
    `cd "${state.worktree}"`,
    `git log --oneline ${state.base}..HEAD     # one commit per screen`,
    'npm run dev                               # (or your dev command) look at the screens',
    '```',
    `Keep it: in your project (\`${state.top}\`), \`git merge ${state.branch}\`. figma-lens never merges, never pushes, never touches ${state.base}.`,
    '',
  ];
  if (count('needs-review')) {
    out.push('## Needs review', 'figma-lens tried these screens several times; the last attempt is saved as a patch and the worktree went back to the last good screen.', 'Fix the cause (see Notes), then run the same command again: these screens are tried again. Or apply the patch to see how far it got: `git apply <patch>` in the worktree.', '');
  }
  return out.join('\n');
}

// ---------- git (only ever in the figma worktree) ----------

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git is not available (${r.error.message})`);
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${String(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

const same = (a, b) => {
  const n = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** Refuse to run a destructive command anywhere but the figma worktree (never the user's checkout). */
export function assertWorktree(worktree, top) {
  if (!worktree || same(worktree, top)) throw new Error(`refusing to change ${worktree}: it is your project checkout, not the figma worktree`);
  const root = git(['rev-parse', '--show-toplevel'], worktree).trim();
  if (!same(root, worktree)) throw new Error(`refusing to change ${worktree}: it is not the root of a git worktree`);
}

const KEEP_OUT = [':!node_modules', ':!**/node_modules']; // never commit installed packages, even without a .gitignore

function readLog(cwd) {
  try {
    return git(['log', '--format=%H%x1f%B%x1e', 'HEAD'], cwd);
  } catch {
    return '';
  }
}

/** Commit the finished screen in the worktree. Returns the short hash. */
export function commitScreen({ worktree, top, screen }) {
  assertWorktree(worktree, top);
  git(['add', '-A', '--', '.', ...KEEP_OUT], worktree);
  // A teammate without a git identity must not lose a finished screen at the last step.
  let id = [];
  try {
    if (!git(['config', 'user.email'], worktree).trim()) throw new Error('none');
  } catch {
    id = ['-c', 'user.name=figma-lens', '-c', 'user.email=figma-lens@localhost'];
  }
  git([...id, 'commit', '-q',
    '-m', `figma: ${screen.name}`,
    '-m', `Built by figma-lens project from the Figma screen ${JSON.stringify(screen.name)} (export: ${path.basename(screen.dir)}).`,
    '-m', `${NODE_TRAILER}: ${screen.key}\n${SPEC_TRAILER}: ${screen.spec}${screen.verifyChanged && screen.verifyChanged.length ? `\n${VERIFY_CHANGED_TRAILER}: ${screen.verifyChanged.join(', ')}` : ''}`], worktree);
  return git(['rev-parse', '--short=9', 'HEAD'], worktree).trim();
}

/** Save the failed attempt as a patch, then put the worktree back to the last commit (the last good screen). */
export function shelveAttempt({ worktree, top, patchFile }) {
  assertWorktree(worktree, top);
  git(['add', '-A', '--', '.', ...KEEP_OUT], worktree);
  const diff = git(['diff', '--cached', '--binary', 'HEAD'], worktree);
  fs.mkdirSync(path.dirname(patchFile), { recursive: true });
  fs.writeFileSync(patchFile, diff);
  git(['reset', '-q', '--hard', 'HEAD'], worktree);
  git(['clean', '-q', '-fd', '-e', 'node_modules'], worktree);
}

function dirty(worktree) {
  try {
    return git(['status', '--porcelain'], worktree).trim().length > 0;
  } catch {
    return false;
  }
}

/** Run auto.verify in the worktree. */
export function runVerify(command, cwd) {
  if (!command) return { ok: true, output: '' };
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1', CI: '1' } });
  const output = `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/).slice(-80).join('\n');
  return { ok: r.status === 0, output: r.error ? `${r.error.message}\n${output}` : output };
}

/**
 * The part of a failed verify that a retry needs: the error lines (file:line, "error", "failed"),
 * at most `max` of them; without any recognisable error line, the last `max` lines.
 */
export function errorLines(output, max = 40) {
  const lines = String(output || '').split(/\r?\n/).filter((l) => l.trim());
  const hits = lines.filter((l) => /\berror\b|ERR!|✖|✗|\bfail(ed|ing|ure)?\b|:\d+:\d+/i.test(l));
  return (hits.length ? hits : lines).slice(-max).join('\n');
}

// Files that decide what auto.verify checks. Claude may edit them in the worktree, so a change is
// flagged on the commit (trailer) and in PROJECT.md instead of being trusted silently.
const CHECK_FILES = [
  'package.json', 'tsconfig.json', 'tsconfig.app.json', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs',
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'analysis_options.yaml', 'pubspec.yaml',
];
export const VERIFY_CHANGED_TRAILER = 'Figma-Verify-Changed';

/**
 * { file: fingerprint|null } for the check files in dir. package.json counts only its "scripts".
 * read(file) can read another version (e.g. the last commit) instead of the files on disk.
 */
export function checksFingerprint(dir, read = (f) => fs.readFileSync(path.join(dir, f), 'utf8')) {
  const out = {};
  for (const f of CHECK_FILES) {
    let text = null;
    try {
      text = read(f);
    } catch {
      text = null;
    }
    if (text !== null && f === 'package.json') {
      try {
        text = JSON.stringify(JSON.parse(text).scripts || {});
      } catch {
        // unparsable package.json: compare the raw text
      }
    }
    out[f] = text === null ? null : crypto.createHash('sha1').update(text).digest('hex');
  }
  return out;
}

export function changedChecks(before, after) {
  return Object.keys({ ...before, ...after }).filter((f) => (before[f] || null) !== (after[f] || null));
}

// ---------- the app's kit (what each built screen added) ----------

export const KIT_FILE = 'KIT.md';

/** design/KIT.md: per built screen, the files its commit added or changed, so later screens reuse them. */
export function kitMarkdown(entries) {
  const out = ['# What each built screen added (figma-lens project)', '', 'Reuse these; never make a second copy. `git show <commit>` shows the details.', ''];
  for (const e of entries) {
    out.push(`## ${e.name} (\`${e.commit}\`)`);
    const files = e.files.slice(0, 60);
    out.push(...(files.length ? files.map((f) => `- ${f.status === 'A' ? 'added' : 'changed'} \`${f.path}\``) : ['- (no file list)']));
    if (e.files.length > files.length) out.push(`- … and ${e.files.length - files.length} more`);
    out.push('');
  }
  return out.join('\n');
}

function writeKit(out, worktree, screens) {
  const entries = screens.filter((s) => s.commit && (s.status === 'done' || s.status === 'changed')).map((s) => {
    let files = [];
    try {
      files = git(['show', '--name-status', '--format=', s.commit], worktree)
        .split('\n').map((l) => l.split('\t')).filter((p) => p.length >= 2 && /^[AM]/.test(p[0]))
        .map((p) => ({ status: p[0][0], path: p[p.length - 1] }));
    } catch {
      files = []; // e.g. a squash-merged commit that is not in this repository's history
    }
    return { name: s.name, commit: s.commit, files };
  });
  const file = path.join(out, KIT_FILE);
  fs.writeFileSync(file, kitMarkdown(entries));
  return file;
}

// ---------- one run per app at a time ----------

export const LOCK_FILE = '.figma-lens-project.lock';
const SAME_HOST_MAX_MS = 6 * 60 * 60 * 1000; // far longer than any synchronous step (auto.verify stops at 30 min)

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists, owned by someone else
  }
};

/**
 * Take the project lock in `out` (the design folder), or throw. A lock is stale, and taken over, when
 * its process is gone (same machine) or it has not been refreshed for staleMs (any machine).
 * Returns release(). The lock is refreshed every minute while held.
 */
export function acquireLock(out, { staleMs = 25 * 60 * 1000, now = Date.now, alive = pidAlive } = {}) {
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, LOCK_FILE);
  const mine = { pid: process.pid, host: os.hostname(), startedAt: new Date(now()).toISOString() };
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.writeFileSync(file, JSON.stringify(mine), { flag: 'wx' });
      const beat = setInterval(() => {
        try {
          const t = new Date();
          fs.utimesSync(file, t, t);
        } catch {
          // lock file removed by hand: nothing to refresh
        }
      }, 60 * 1000);
      beat.unref();
      return () => {
        clearInterval(beat);
        try {
          const held = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (held.pid === mine.pid && held.host === mine.host) fs.rmSync(file, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let held = null;
    let age = 0;
    try {
      held = JSON.parse(fs.readFileSync(file, 'utf8'));
      age = now() - fs.statSync(file).mtimeMs;
    } catch {
      held = null; // unreadable or vanished: treat as stale
    }
    // Same machine: the process tells the truth (a long synchronous verify pauses the heartbeat while
    // the run is alive); only a lock untouched for far longer than any verify (pid reused) is stale.
    // Another machine: the heartbeat is all there is.
    const stale = !held || (held.host === mine.host ? !alive(held.pid) || age > SAME_HOST_MAX_MS : age > staleMs);
    if (!stale) {
      throw new Error(`another figma-lens project run is working on this app (pid ${held.pid} on ${held.host}, since ${held.startedAt}). Wait for it to finish, or stop it. If it is not running, delete ${file}.`);
    }
    fs.rmSync(file, { force: true });
  }
  throw new Error(`could not take the project lock ${file}`);
}

// ---------- state ----------

function readState(out, branch) {
  try {
    return JSON.parse(fs.readFileSync(path.join(out, STATE_FILE), 'utf8'))[branch] || null;
  } catch {
    return null;
  }
}

function writeState(out, state) {
  const file = path.join(out, STATE_FILE);
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    all = {};
  }
  state.updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16);
  all[state.branch] = state;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 1));
  fs.writeFileSync(path.join(out, REPORT_FILE), renderProjectMd(state));
}

// ---------- choosing the screens ----------

async function askChoice(question, choices, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) return null;
  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const a = (await new Promise((r) => rl.question(question, r))).trim().toLowerCase();
      if (choices.includes(a)) return a;
      output.write(`Type ${choices.join(', ')}.\n`);
    }
  } finally {
    rl.close();
  }
}

/** The app's screens, in build order: [{ name, nodeId, dir }]. */
export async function collectScreens({ browser, settings, url, st, ifNoLinks, log, ask, exportFn = exportFromBrowser }) {
  const starts = st.ids || (st.selection.length ? st.selection.map((n) => n.id) : st.flows.map((f) => f.id));
  let results = [];
  if (starts.length) {
    log(c.cyan(`Following the prototype from ${starts.length} start screen(s)…`));
    results = await exportFn(browser, settings, { url, nodeIds: starts, flow: true, log });
    const ok = results.filter((r) => !r.error);
    if (!ok.length) throw new Error('the start screen(s) could not be exported (see the errors above)');
    const linked = ok.length > starts.length || ok.some((r) => screenTargets(r.prototype).length);
    if (linked) return ok;
  }

  const frames = canvasOrder(st.frames);
  const names = results.filter((r) => !r.error).map((r) => r.name);
  log('');
  log(c.yellow(c.bold(starts.length ? `"${names.join('", "')}" has no prototype links to other screens,` : `No start screen: the link has no ?node-id=, nothing is selected and page "${st.page}" has no prototype flow,`)));
  log(c.yellow("so figma-lens can't tell from Figma which screens belong to the app. Choose:"));
  const options = [];
  if (starts.length) options.push(['this', `build only this screen (${names.length === 1 ? `"${names[0]}"` : `${names.length} screens`})`]);
  options.push(['page', `build every screen on page "${st.page}" (${frames.length}), in canvas order: top to bottom, left to right  [recommended when the designer didn't wire the prototype]`]);
  options.push(['stop', "stop (ask the designer to link the screens in Figma's Prototype tab, then run this again)"]);
  options.forEach(([, text], i) => log(`  ${c.bold(String(i + 1))}) ${text}`));

  let choice = ifNoLinks || null;
  if (!choice) {
    const a = await ask(`Choose 1-${options.length}: `, options.map((_, i) => String(i + 1)));
    if (!a) throw new Error('no prototype links and no terminal to ask in: run it in a terminal, or add --if-no-links this|page|stop');
    choice = options[Number(a) - 1][0];
  }
  if (!options.some(([k]) => k === choice)) throw new Error(`--if-no-links ${choice} is not possible here (choose ${options.map(([k]) => k).join(', ')})`);
  log(c.gray(`→ ${choice}`));
  if (choice === 'stop') return [];
  if (choice === 'this') return results.filter((r) => !r.error);
  if (!frames.length) throw new Error(`page "${st.page}" has no frames`);
  const done = new Map(results.filter((r) => !r.error).map((r) => [r.nodeId, r]));
  const rest = frames.filter((f) => !done.has(f.id)).map((f) => f.id);
  const more = rest.length ? await exportFn(browser, settings, { url, nodeIds: rest, log }) : [];
  for (const r of more) if (!r.error) done.set(r.nodeId, r);
  return frames.map((f) => done.get(f.id)).filter(Boolean);
}

// ---------- the run ----------

/**
 * Project mode follows the whole prototype: --flow's default limit (30 screens) would cut a bigger app
 * short while the summary still said "30 of 30 built". A limit the user set (flag or config) still applies.
 */
export function projectSettings(settings) {
  const set = settings.from && settings.from.flowMax && settings.from.flowMax !== 'default';
  return set ? settings : { ...settings, flowMax: 0 };
}

/** figma-lens project. settings: browser settings. Returns true when every screen is built. */
export async function runProject(settings, { url, ifNoLinks, log = console.log, ask = askChoice, cwd = process.cwd() } = {}) {
  settings = projectSettings(settings);
  const link = resolveLink(url, settings);
  const configFile = findConfig([cwd, path.dirname(cwd)]);
  if (!configFile) throw new Error(`no ${CONFIG_FILE} here: run figma-lens auto --init (and describe your project's structure) first`);
  const cfg = loadAutoConfig(configFile);
  const command = `figma-lens project${link ? ` "${link}"` : ''}`;

  // One run per app from the very start: two runs exporting into the same design folder collide too.
  const release = acquireLock(settings.out, { staleMs: lockStaleMs(cfg) });
  try {
    return await exportAndBuild({ settings, link, cfg, configFile, command, ifNoLinks, log, ask });
  } finally {
    release();
  }
}

const lockStaleMs = (cfg) => ((Number(cfg && cfg.idleMinutes) || 20) + 5) * 60 * 1000;

async function exportAndBuild({ settings, link, cfg, configFile, command, ifNoLinks, log, ask }) {
  // 1. Export the app's screens (the browser is only needed for this part).
  const ready = await openReady(settings, { log });
  let screens;
  let st;
  try {
    st = await fileStatus(ready.browser, link, { log });
    screens = await collectScreens({ browser: ready.browser, settings, url: link, st, ifNoLinks, log, ask });
  } finally {
    await ready.browser.close().catch(() => undefined); // disconnects; the window stays open
  }
  if (!screens.length) {
    log(c.gray('Nothing to build.'));
    return false;
  }
  const seen = new Set();
  screens = screens.filter((r) => !seen.has(r.nodeId) && seen.add(r.nodeId)).map((r) => ({
    name: r.name,
    nodeId: r.nodeId,
    dir: r.dir,
    key: screenKey(st.fileKey, st.file, r.nodeId),
    spec: specHash(r.dir),
  }));
  const r = await buildAppLocked({ screens, file: st.file, fileKey: st.fileKey, cfg, configFile, out: settings.out, command, log });
  return r.ok;
}

/**
 * Build the screens on one branch (step 2+ of runProject; separate so it can be tested without a browser).
 * runScreen / verify are injectable for tests.
 */
export async function buildApp(opts) {
  // One run per app: a second run would build in the same worktree and commit over the first one.
  const release = acquireLock(opts.out, { staleMs: lockStaleMs(opts.cfg) });
  try {
    return await buildAppLocked(opts);
  } finally {
    release();
  }
}

async function buildAppLocked({ screens, file, fileKey, cfg, configFile, out, command, log = console.log, runScreen = runJob, verify = runVerify }) {
  // One worktree, one branch for the whole app.
  const key = `app-${slug(file)}`;
  const plan = planWorktree({ projectDir: cfg.projectDir, key, worktreeRoot: cfg.worktreeRoot });
  const fresh = !fs.existsSync(plan.worktree);
  createWorktree(plan);
  const base = git(['rev-parse', '--abbrev-ref', 'HEAD'], plan.top).trim();
  const previous = readState(out, plan.branch);
  const built = new Map([...builtFromLog(readLog(plan.top)), ...builtFromLog(readLog(plan.worktree))]);
  const state = {
    file, fileKey, branch: plan.branch, worktree: plan.worktree, top: plan.top,
    base: (previous && previous.base) || base, command, current: null,
    screens: planScreens(screens, built, previous),
  };

  // Work left in the worktree: only continue it when figma-lens knows it is a screen it was building.
  let resumeKey = null;
  if (!fresh && dirty(plan.worktree)) {
    const cur = previous && previous.current;
    if (!cur || !state.screens.some((s) => s.key === cur && s.status !== 'done')) {
      throw new Error(`${plan.worktree} has changes that are not committed and not from an unfinished figma-lens screen (yours?). Commit them on ${plan.branch} or discard them, then run again.`);
    }
    resumeKey = cur;
  }
  const order = [
    ...state.screens.filter((s) => s.key === resumeKey),
    ...state.screens.filter((s) => s.key !== resumeKey && (s.status === 'todo' || s.status === 'needs-review')),
  ];
  writeState(out, state);

  const count = (x) => state.screens.filter((s) => s.status === x).length;
  log('');
  log(`${c.bold(`App "${file}"`)} → branch ${c.cyan(plan.branch)} ${c.gray(`(${plan.worktree})`)}`);
  log(`${state.screens.length} screen(s): ${c.green(`${count('done')} built`)}, ${order.length} to build${count('changed') ? `, ${c.yellow(`${count('changed')} changed in Figma since built (listed, not rebuilt)`)}` : ''}${count('needs-review') ? ` (incl. ${count('needs-review')} that failed before)` : ''}.`);
  if (order.length) log(c.gray('Each screen is a full Claude Code run (often 10–60 min). Safe to leave running. Ctrl+C stops; run the same command again to continue.'));
  log(c.gray(`Progress: ${path.join(out, REPORT_FILE)}`));

  const flowsFile = path.join(out, 'FLOWS.md');
  let kitFile = writeKit(out, plan.worktree, state.screens);
  let stopped = null;
  for (let i = 0; i < order.length && !stopped; i++) {
    const s = order[i];
    const builtNames = state.screens.filter((x) => x.status === 'done' || x.status === 'changed').map((x) => x.name);
    const context = projectPrompt({ screen: s, index: builtNames.length + 1, total: state.screens.length, built: builtNames, next: order.slice(i + 1).map((x) => x.name), flowsFile, branch: plan.branch, verify: cfg.verify, kitFile });
    // The checks as of the last good screen (HEAD), so partial work left from a previous run counts too.
    const checksBefore = checksFingerprint(plan.workDir, (f) => git(['show', `HEAD:./${f}`], plan.workDir));
    log('');
    log(c.bold(c.cyan(`[${i + 1}/${order.length}] ${s.name}`)) + c.gray(` (screen ${builtNames.length + 1} of ${state.screens.length} in the app)`));
    s.status = 'building';
    state.current = s.key;
    writeState(out, state);

    let note = '';
    let done = false;
    let reason = '';
    for (let attempt = 0; attempt <= cfg.fixRetries && !done; attempt++) {
      if (attempt) log(c.yellow(`↻ ${s.name}: try ${attempt + 1} of ${cfg.fixRetries + 1}, with the error`));
      s.attempts = (s.attempts || 0) + 1;
      const resume = attempt === 0 ? (s.key === resumeKey ? 'partial' : null) : dirty(plan.worktree) ? 'partial' : null;
      const run = await runScreen({
        frameDir: s.dir, configFile, log, key, resume,
        extraPrompt: context + (note ? `\n\n${note}` : ''),
        addDirs: [out],
        failureCmds: { retryCmd: command, discardCmd: null },
      });
      if (run.status !== 'done') {
        reason = run.problem || run.reason || run.status;
        if (run.status === 'skipped' || FATAL.test(reason)) {
          stopped = reason;
          break;
        }
        note = `A previous attempt at this screen did not finish: ${reason}. Continue from the work in this checkout.`;
        continue;
      }
      const v = verify(cfg.verify, plan.workDir);
      if (!v.ok) {
        reason = `\`${cfg.verify}\` failed`;
        log(c.red(`✖ ${s.name}: ${reason}`));
        log(c.gray(v.output.split('\n').slice(-8).map((l) => `  ${l}`).join('\n')));
        // Only the error lines: the whole log would fill the retry's context with noise.
        note = `Your work on this screen is in this checkout, but \`${cfg.verify}\` fails. Fix it (keep the screen; don't remove checks). The errors:\n\n${errorLines(v.output)}`;
        continue;
      }
      const touched = changedChecks(checksBefore, checksFingerprint(plan.workDir));
      if (touched.length) s.verifyChanged = touched;
      else delete s.verifyChanged;
      try {
        s.commit = commitScreen({ worktree: plan.worktree, top: plan.top, screen: s });
        s.status = 'done';
        delete s.reason;
        delete s.patch;
        done = true;
        log(`${c.green(c.bold('✔'))} ${c.bold(s.name)} built and committed ${c.cyan(s.commit)} on ${plan.branch}`);
        if (touched.length) log(c.yellow(`  ⚠ this screen changed the project's checks (${touched.join(', ')}): review that change`));
        kitFile = writeKit(out, plan.worktree, state.screens);
      } catch (e) {
        reason = `the commit failed: ${e.message}`; // e.g. the project's own git hooks
        note = `figma-lens could not commit your work: ${e.message}. Fix what it complains about.`;
      }
    }
    if (stopped) {
      s.status = 'todo'; // the work stays in the worktree; the next run continues it (state.current)
      log(c.red(c.bold(`■ stopped: ${stopped}`)));
      log(`  Fix that, then run the same command again; it continues with ${JSON.stringify(s.name)}: ${c.bold(command)}`);
      state.current = s.key;
      writeState(out, state);
      break;
    }
    if (!done) {
      const patch = path.join(s.dir, 'auto', `failed-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.patch`);
      s.status = 'needs-review';
      s.reason = reason;
      try {
        shelveAttempt({ worktree: plan.worktree, top: plan.top, patchFile: patch });
        s.patch = patch;
        log(`${c.red(c.bold('✖'))} ${c.bold(s.name)} needs review after ${cfg.fixRetries + 1} tries: ${reason}`);
        log(c.gray(`  the attempt is saved in ${patch}; the worktree is back at the last good screen. Going on with the next screen.`));
      } catch (e) {
        stopped = `could not reset the worktree (${e.message})`;
        log(c.red(`  ${stopped}; stopping so the next screen doesn't build on broken work`));
      }
    }
    state.current = stopped ? s.key : null;
    writeState(out, state);
  }

  const left = state.screens.filter((s) => s.status !== 'done' && s.status !== 'changed');
  log('');
  log(c.bold(`App "${file}": ${state.screens.length - left.length} of ${state.screens.length} screens built on ${plan.branch}.`));
  for (const s of state.screens) {
    const mark = s.status === 'done' ? c.green('✔') : s.status === 'changed' ? c.yellow('◐') : s.status === 'needs-review' ? c.red('✖') : c.gray('·');
    log(`  ${mark} ${s.name}${s.commit ? c.gray(` ${s.commit}`) : ''}${s.status === 'changed' ? c.yellow(' (changed in Figma since it was built)') : ''}${s.reason && s.status === 'needs-review' ? c.gray(` — ${String(s.reason).slice(0, 90)}`) : ''}`);
  }
  log('');
  log(`Review: ${c.bold(`cd "${plan.worktree}"`)} then ${c.bold(`git log --oneline ${state.base}..HEAD`)} and run the app.`);
  log(`Keep:   in ${plan.top}: ${c.bold(`git merge ${plan.branch}`)}   ·   details: ${path.join(out, REPORT_FILE)}`);
  return { ok: !stopped && left.length === 0, state };
}

/** figma-lens project --status: what is built and what is next, without opening the browser. */
export function projectStatus(out, { log = console.log } = {}) {
  const file = path.join(out, REPORT_FILE);
  if (!fs.existsSync(file)) {
    log(`no ${REPORT_FILE} in ${out} yet: run figma-lens project "<link to the first screen>"`);
    return false;
  }
  log(fs.readFileSync(file, 'utf8'));
  return true;
}
