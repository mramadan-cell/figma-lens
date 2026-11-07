// figma-lens project: the build loop on a real git repo (fake Claude runs), plus the pure helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  slug, screenKey, specHash, builtFromLog, planScreens, canvasOrder, projectPrompt, renderProjectMd,
  assertWorktree, buildApp, collectScreens, projectSettings,
} from '../tools/project.js';
import { loadAutoConfig } from '../tools/auto.js';
import { ensureSignedIn, resolveBrowserSettings } from '../tools/browser.js';

// No global git config from the machine running the tests (signing, hooks, identity).
const EMPTY_GIT_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fl-gitcfg-')), 'gitconfig');
fs.writeFileSync(EMPTY_GIT_CONFIG, '');
process.env.GIT_CONFIG_GLOBAL = EMPTY_GIT_CONFIG;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fl-project-'));
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A project repo with one commit and an auto section; screens exported into <repo>/design. */
function project({ verify = 'npm run verify', fixRetries = 1, identity = true } = {}) {
  const root = tmp();
  const repo = path.join(root, 'shop');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  if (identity) {
    git(repo, 'config', 'user.name', 'Dev');
    git(repo, 'config', 'user.email', 'dev@example.com');
  }
  fs.writeFileSync(path.join(repo, '.gitignore'), 'design/\nnode_modules/\n');
  fs.writeFileSync(path.join(repo, 'figma-lens.config.json'), JSON.stringify({ auto: { enabled: true, verify, fixRetries } }));
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '-m', 'init');
  const out = path.join(repo, 'design');
  const screen = (name, nodeId, spec = { name }) => {
    const dir = path.join(out, slug(name));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ meta: { nodeName: name, exportedAt: String(Date.now()) }, spec }));
    return { name, nodeId, dir, key: screenKey('KEY', 'Shop', nodeId), spec: specHash(dir) };
  };
  const configFile = path.join(repo, 'figma-lens.config.json');
  return { repo, out, screen, configFile, cfg: loadAutoConfig(configFile), worktree: path.join(root, 'shop-figma', 'app-shop') };
}

/** A fake Claude run: writes src/<screen>.txt in the worktree. */
function fakeClaude(worktree, { fail = {} } = {}) {
  const calls = [];
  const run = async (o) => {
    const name = path.basename(o.frameDir);
    calls.push({ name, resume: o.resume, key: o.key, extra: o.extraPrompt, addDirs: o.addDirs, failureCmds: o.failureCmds });
    if (fail[name]) return fail[name](calls.filter((c) => c.name === name).length);
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'src', `${name}.txt`), `${name} ${calls.length}`);
    return { status: 'done' };
  };
  return { run, calls };
}
const quiet = () => {};
const ok = () => ({ ok: true, output: '' });

// ---------- pure helpers ----------

test('slug, screen key and the spec hash (same design = same hash, whenever it was exported)', () => {
  assert.equal(slug('Shop App (v2)'), 'shop-app-v2');
  assert.equal(slug('   '), 'app');
  assert.equal(slug('Café Menü'), 'cafe-menu');
  assert.equal(screenKey('K', 'Shop', '1:2'), 'K#1:2');
  assert.equal(screenKey(null, 'Shop', '1:2'), 'Shop#1:2');
  const dir = tmp();
  const write = (meta, spec) => fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ meta, spec }));
  write({ exportedAt: '1' }, { a: 1 });
  const h1 = specHash(dir);
  write({ exportedAt: '2' }, { a: 1 });
  assert.equal(specHash(dir), h1, 'export time does not change the hash');
  write({ exportedAt: '2' }, { a: 2 });
  assert.notEqual(specHash(dir), h1);
  fs.writeFileSync(path.join(dir, 'tokens.json'), '{"c":1}');
  write({}, { a: 1 });
  assert.notEqual(specHash(dir), h1, 'tokens count too');
});

test('what is built comes from commit trailers; status: done, changed, needs-review, todo', () => {
  const log = [
    'aaaaaaaaaaaa\x1ffigma: Cart\n\nFigma-Node: K#3:1\nFigma-Spec: s3new\n\x1e',
    'bbbbbbbbbbbb\x1ffigma: Home\n\nFigma-Node: K#2:1\nFigma-Spec: s2\n\x1e',
    'cccccccccccc\x1fold Cart\n\nFigma-Node: K#3:1\nFigma-Spec: s3old\n\x1e',
    'dddddddddddd\x1fa normal commit\n\x1e',
  ].join('\n');
  const built = builtFromLog(log);
  assert.deepEqual([...built], [['K#3:1', { commit: 'aaaaaaaaa', spec: 's3new' }], ['K#2:1', { commit: 'bbbbbbbbb', spec: 's2' }]]);
  const screens = [
    { key: 'K#1:1', name: 'Login', spec: 's1' },
    { key: 'K#2:1', name: 'Home', spec: 's2' },
    { key: 'K#3:1', name: 'Cart', spec: 's3changed' },
    { key: 'K#4:1', name: 'Pay', spec: 's4' },
  ];
  const prev = { screens: [{ key: 'K#4:1', status: 'needs-review', reason: 'verify failed', patch: 'p.patch', attempts: 3 }] };
  assert.deepEqual(planScreens(screens, built, prev).map((s) => [s.name, s.status, s.commit]), [
    ['Login', 'todo', null], ['Home', 'done', 'bbbbbbbbb'], ['Cart', 'changed', 'aaaaaaaaa'], ['Pay', 'needs-review', null],
  ]);
});

test('a squash merge (all screens in one commit, indented) still counts every screen as built', () => {
  const squash = [
    'eeeeeeeeeeee\x1fSquashed commit of the following:',
    '',
    'commit 222',
    'Author: a <a@b>',
    '',
    '    figma: Home',
    '',
    '    Figma-Node: K#2:1',
    '    Figma-Spec: s2',
    '',
    'commit 111',
    '',
    '    figma: Login',
    '',
    '    Figma-Node: K#1:1',
    '    Figma-Spec: s1',
    '\x1e',
  ].join('\n');
  const pr = 'ffffffffffff\x1fShop app (#12)\n\n* figma: Cart\n\nFigma-Node: K#3:1\nFigma-Spec: s3\n\n* figma: Pay\n\nFigma-Node: K#4:1\n\x1e'; // a GitHub squash; Pay without a spec line
  assert.deepEqual([...builtFromLog(squash + '\n' + pr)], [
    ['K#2:1', { commit: 'eeeeeeeee', spec: 's2' }],
    ['K#1:1', { commit: 'eeeeeeeee', spec: 's1' }],
    ['K#3:1', { commit: 'fffffffff', spec: 's3' }],
    ['K#4:1', { commit: 'fffffffff', spec: null }], // never borrows the next screen's spec
  ]);
});

test('project mode follows the whole prototype: no 30-screen limit unless one was set', () => {
  const dir = tmp();
  const base = { cwd: dir, env: {}, platform: 'linux', home: '/h', detect: () => [{ cmd: ['/usr/bin/google-chrome'], kind: 'regular', label: 'chrome' }] };
  assert.equal(resolveBrowserSettings(base).flowMax, 30, '--flow keeps its default');
  assert.equal(projectSettings(resolveBrowserSettings(base)).flowMax, 0);
  assert.equal(projectSettings(resolveBrowserSettings({ ...base, flags: { 'flow-max': '5' } })).flowMax, 5);
  fs.writeFileSync(path.join(dir, 'figma-lens.config.json'), JSON.stringify({ browser: { flowMax: 12 } }));
  assert.equal(projectSettings(resolveBrowserSettings(base)).flowMax, 12);
});

test('canvas order: rows top to bottom, each row left to right (rows need not align exactly)', () => {
  const f = (id, x, y, h = 800) => ({ id, x, y, w: 400, h });
  const order = canvasOrder([f('c', 900, 10), f('a', 0, 0), f('d', 0, 1000), f('b', 450, 30), f('e', 450, 1020)]);
  assert.deepEqual(order.map((x) => x.id), ['a', 'b', 'c', 'd', 'e']);
});

test('the app context for Claude and PROJECT.md', () => {
  const p = projectPrompt({ screen: { name: 'Cart' }, index: 3, total: 5, built: ['Login', 'Home'], next: ['Pay'], flowsFile: '/d/FLOWS.md', branch: 'figma/app-shop', verify: 'npm run verify' });
  assert.match(p, /Screen 3 of 5: "Cart"/);
  assert.match(p, /Already built on this branch \(committed\): "Login", "Home"/);
  assert.match(p, /Still to build after this one: "Pay"/);
  assert.match(p, /\/d\/FLOWS\.md/);
  assert.match(p, /`npm run verify` passes/);
  assert.match(p, /Do not commit/);
  assert.match(projectPrompt({ screen: { name: 'A' }, index: 1, total: 1, built: [], next: [], flowsFile: 'F', branch: 'b', verify: '' }), /none yet: this is the first screen/);
  const md = renderProjectMd({
    file: 'Shop', branch: 'figma/app-shop', worktree: '/w', top: '/p', base: 'main', command: 'figma-lens project "L"', updatedAt: 'now',
    screens: [{ name: 'Login', status: 'done', commit: 'abc' }, { name: 'A | B', status: 'needs-review', reason: 'npm run verify failed', patch: '/x.patch' }, { name: 'Pay', status: 'todo' }],
  });
  assert.match(md, /\*\*1 of 3 screens built\*\* · 1 need review/);
  assert.match(md, /\*\*Next:\*\* "A \| B"/);
  assert.match(md, /\| 2 \| A \\\| B \| ✖ needs review/);
  assert.match(md, /git merge figma\/app-shop/);
  assert.match(md, /## Needs review/);
});

// ---------- the build loop, on a real repo ----------

test('builds every screen on one branch, one commit each with trailers; a second run builds nothing', async () => {
  const p = project();
  const screens = [p.screen('Login', '1:1'), p.screen('Home', '2:1'), p.screen('Cart', '3:1')];
  const claude = fakeClaude(p.worktree);
  const verified = [];
  const r = await buildApp({ screens, file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'figma-lens project "L"', log: quiet, runScreen: claude.run, verify: (cmd, cwd) => (verified.push([cmd, cwd]), ok()) });
  assert.equal(r.ok, true);
  assert.deepEqual(claude.calls.map((c) => [c.name, c.key, c.resume]), [['login', 'app-shop', null], ['home', 'app-shop', null], ['cart', 'app-shop', null]]);
  assert.match(claude.calls[1].extra, /Already built on this branch \(committed\): "Login"/);
  assert.deepEqual(claude.calls[0].addDirs, [p.out]);
  assert.deepEqual(claude.calls[0].failureCmds, { retryCmd: 'figma-lens project "L"', discardCmd: null }, 'never suggests deleting the app branch');
  assert.equal(verified.length, 3);
  assert.equal(verified[0][0], 'npm run verify');
  // the branch: three commits on top of main, each with its trailers; main untouched
  const log = git(p.worktree, 'log', '--format=%s|%(trailers:key=Figma-Node,valueonly,separator=)', 'main..HEAD').split('\n');
  assert.deepEqual(log, ['figma: Cart|KEY#3:1', 'figma: Home|KEY#2:1', 'figma: Login|KEY#1:1']);
  assert.equal(git(p.repo, 'log', '--oneline', 'main').split('\n').length, 1);
  assert.equal(git(p.repo, 'status', '--porcelain'), '', 'the project checkout is never touched');
  assert.match(fs.readFileSync(path.join(p.out, 'PROJECT.md'), 'utf8'), /\*\*3 of 3 screens built\*\*/);

  // run again: everything is known to be built
  const again = fakeClaude(p.worktree);
  const r2 = await buildApp({ screens, file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: again.run, verify: ok });
  assert.equal(r2.ok, true);
  assert.equal(again.calls.length, 0);

  // the designer changes Home: reported as changed, not rebuilt; a new screen is built
  const home2 = p.screen('Home', '2:1', { name: 'Home', changed: true });
  const pay = p.screen('Pay', '4:1');
  const third = fakeClaude(p.worktree);
  const r3 = await buildApp({ screens: [screens[0], home2, screens[2], pay], file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: third.run, verify: ok });
  assert.deepEqual(third.calls.map((c) => c.name), ['pay']);
  assert.deepEqual(r3.state.screens.map((s) => s.status), ['done', 'changed', 'done', 'done']);
  assert.match(third.calls[0].extra, /Screen 4 of 4/);
});

test('a screen that keeps failing verify: retried with the error, saved as a patch, worktree reset, next screen built', async () => {
  const p = project({ fixRetries: 1 });
  const screens = [p.screen('Login', '1:1'), p.screen('Home', '2:1'), p.screen('Cart', '3:1')];
  const claude = fakeClaude(p.worktree);
  const verify = (cmd, cwd) => (fs.existsSync(path.join(cwd, 'src', 'home.txt')) ? { ok: false, output: 'src/home.tsx(3,1): error TS2304' } : ok());
  const r = await buildApp({ screens, file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: claude.run, verify });
  assert.equal(r.ok, false);
  assert.deepEqual(claude.calls.map((c) => [c.name, c.resume]), [['login', null], ['home', null], ['home', 'partial'], ['cart', null]]);
  assert.match(claude.calls[2].extra, /`npm run verify` fails[\s\S]*error TS2304/, 'the retry gets the error');
  const home = r.state.screens[1];
  assert.equal(home.status, 'needs-review');
  assert.ok(fs.readFileSync(home.patch, 'utf8').includes('src/home.txt'), 'the attempt is kept as a patch');
  // Cart was built on the last good screen: Home's broken work is not in the branch
  assert.equal(git(p.worktree, 'status', '--porcelain'), '');
  assert.deepEqual(git(p.worktree, 'ls-files', 'src').split('\n').sort(), ['src/cart.txt', 'src/login.txt']);
  assert.match(fs.readFileSync(path.join(p.out, 'PROJECT.md'), 'utf8'), /needs review/);

  // next run: Home is tried again (and now passes)
  const again = fakeClaude(p.worktree);
  const r2 = await buildApp({ screens, file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: again.run, verify: ok });
  assert.deepEqual(again.calls.map((c) => c.name), ['home']);
  assert.equal(r2.ok, true);
});

test('a problem retries cannot fix (usage limit) stops the run; the next run continues that screen first', async () => {
  const p = project();
  const screens = [p.screen('Login', '1:1'), p.screen('Home', '2:1'), p.screen('Cart', '3:1')];
  const claude = fakeClaude(p.worktree, {
    fail: {
      home: () => {
        fs.writeFileSync(path.join(p.worktree, 'src', 'home-partial.txt'), 'half');
        return { status: 'failed', problem: 'your Claude usage limit was reached' };
      },
    },
  });
  const r = await buildApp({ screens, file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: claude.run, verify: ok });
  assert.equal(r.ok, false);
  assert.deepEqual(claude.calls.map((c) => c.name), ['login', 'home'], 'no retry, no next screen');
  assert.ok(fs.existsSync(path.join(p.worktree, 'src', 'home-partial.txt')), 'the partial work is kept');

  const again = fakeClaude(p.worktree);
  await buildApp({ screens, file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: again.run, verify: ok });
  assert.deepEqual(again.calls.map((c) => [c.name, c.resume]), [['home', 'partial'], ['cart', null]]);
});

test('squash-merged into main, app branch deleted: the next run still knows every screen is built', async () => {
  const p = project();
  const screens = [p.screen('Login', '1:1'), p.screen('Home', '2:1')];
  await buildApp({ screens, file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: fakeClaude(p.worktree).run, verify: ok });
  git(p.repo, 'merge', '-q', '--squash', 'figma/app-shop');
  git(p.repo, 'commit', '-q', '--no-edit');
  git(p.repo, 'worktree', 'remove', '--force', p.worktree);
  git(p.repo, 'branch', '-D', 'figma/app-shop');
  const again = fakeClaude(p.worktree);
  const r = await buildApp({ screens, file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: again.run, verify: ok });
  assert.equal(again.calls.length, 0, 'nothing rebuilt');
  assert.deepEqual(r.state.screens.map((s) => s.status), ['done', 'done']);
});

test('changes in the worktree that figma-lens did not make stop the run (never thrown away)', async () => {
  const p = project();
  const screens = [p.screen('Login', '1:1')];
  await buildApp({ screens, file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: fakeClaude(p.worktree).run, verify: ok });
  fs.writeFileSync(path.join(p.worktree, 'src', 'my-fix.txt'), 'by hand');
  await assert.rejects(
    buildApp({ screens: [...screens, p.screen('Home', '2:1')], file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: fakeClaude(p.worktree).run, verify: ok }),
    /has changes that are not committed and not from an unfinished figma-lens screen/,
  );
  assert.ok(fs.existsSync(path.join(p.worktree, 'src', 'my-fix.txt')));
});

test('no git identity on the machine: the screen is still committed (as figma-lens)', async () => {
  const p = project({ identity: false });
  const r = await buildApp({ screens: [p.screen('Login', '1:1')], file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: fakeClaude(p.worktree).run, verify: ok });
  assert.equal(r.ok, true);
  assert.equal(git(p.worktree, 'log', '-1', '--format=%an <%ae>'), 'figma-lens <figma-lens@localhost>');
});

test('destructive git commands refuse the project checkout', () => {
  const p = project();
  assert.throws(() => assertWorktree(p.repo, p.repo), /it is your project checkout/);
  fs.mkdirSync(path.join(p.repo, 'sub'));
  assert.throws(() => assertWorktree(path.join(p.repo, 'sub'), p.repo), /not the root of a git worktree/);
});

// ---------- choosing the screens ----------

test('screens: follow the prototype; without links, ask: this screen, every screen on the page, or stop', async () => {
  const st = (over = {}) => ({ ids: ['1:1'], selection: [], flows: [], page: 'Mobile', frames: [{ id: '2:1', x: 500, y: 0, w: 1, h: 800 }, { id: '1:1', x: 0, y: 0, w: 1, h: 800 }, { id: '3:1', x: 0, y: 900, w: 1, h: 800 }], ...over });
  const r = (id, prototype = {}) => ({ name: `S${id}`, nodeId: id, dir: `/d/${id}`, prototype });
  const linked = { links: [{ type: 'NODE', navigation: 'NAVIGATE', to: '2:1' }], destinations: [{ id: '2:1', name: 'Home' }] };
  const calls = [];

  // linked: the flow export is the app
  let out = await collectScreens({ st: st(), settings: {}, log: quiet, ask: assert.fail, exportFn: async (b, s, o) => (calls.push(o), [r('1:1', linked), r('2:1')]) });
  assert.deepEqual(out.map((x) => x.nodeId), ['1:1', '2:1']);
  assert.equal(calls.at(-1).flow, true);

  // no links → asked; "2" = every screen on the page, in canvas order, the start one not exported twice
  const noLinks = async (b, s, o) => (calls.push(o), o.flow ? [r(o.nodeIds[0])] : o.nodeIds.map((id) => r(id)));
  const asked = [];
  out = await collectScreens({ st: st(), settings: {}, log: quiet, ask: async (q, choices) => (asked.push(choices), '2'), exportFn: noLinks });
  assert.deepEqual(asked, [['1', '2', '3']]);
  assert.deepEqual(out.map((x) => x.nodeId), ['1:1', '2:1', '3:1']);
  assert.deepEqual(calls.at(-1).nodeIds, ['2:1', '3:1']);
  out = await collectScreens({ st: st(), settings: {}, log: quiet, ifNoLinks: 'this', ask: assert.fail, exportFn: noLinks });
  assert.deepEqual(out.map((x) => x.nodeId), ['1:1']);
  assert.deepEqual(await collectScreens({ st: st(), settings: {}, log: quiet, ifNoLinks: 'stop', ask: assert.fail, exportFn: noLinks }), []);

  // no start at all (no node-id, nothing selected, no flow): "this" is not an option
  await assert.rejects(collectScreens({ st: st({ ids: null }), settings: {}, log: quiet, ifNoLinks: 'this', ask: assert.fail, exportFn: noLinks }), /--if-no-links this is not possible here \(choose page, stop\)/);
  // the page's prototype start is used when the link has no node-id
  await collectScreens({ st: st({ ids: null, flows: [{ id: '3:1', name: 'Onboarding' }] }), settings: {}, log: quiet, ifNoLinks: 'this', ask: assert.fail, exportFn: noLinks });
  assert.deepEqual(calls.at(-1).nodeIds, ['3:1']);
  // no terminal and no --if-no-links: a clear error, not a hang
  await assert.rejects(collectScreens({ st: st(), settings: {}, log: quiet, ask: async () => null, exportFn: noLinks }), /--if-no-links this\|page\|stop/);
});

// ---------- sign-in ----------

test('not signed in: the plain sign-in window opens by itself, then figma-lens continues signed in', async () => {
  const steps = [];
  const signed = new Set(['b2']);
  const r = await ensureSignedIn({ id: 'b1' }, {
    port: 1, settings: { profile: '/p' }, log: quiet,
    isSignedIn: async (b) => signed.has(b.id),
    close: async (b, port) => steps.push(['close', b.id, port]),
    signIn: async () => steps.push(['sign-in window']),
    start: async () => (steps.push(['start']), { port: 2, started: true }),
    connect: async (port) => (steps.push(['connect', port]), { id: 'b2' }),
    webgl: async (b, o) => (steps.push(['webgl', o.port]), { browser: b, port: o.port }),
  });
  assert.deepEqual(steps, [['close', 'b1', 1], ['sign-in window'], ['start'], ['connect', 2], ['webgl', 2]]);
  assert.equal(r.browser.id, 'b2');
  // already signed in: nothing happens
  const same = await ensureSignedIn({ id: 'b2' }, { port: 5, settings: {}, log: quiet, isSignedIn: async () => true, close: assert.fail, signIn: assert.fail, start: assert.fail, connect: assert.fail });
  assert.equal(same.port, 5);
  // closed the sign-in window without signing in: clear error, connection dropped
  let dropped = false;
  await assert.rejects(ensureSignedIn({ id: 'b1' }, {
    port: 1, settings: {}, log: quiet, isSignedIn: async () => false, close: async () => {}, signIn: async () => {},
    start: async () => ({ port: 2 }), connect: async () => ({ close: async () => (dropped = true) }), webgl: async (b, o) => ({ browser: b, port: o.port }),
  }), /still not signed in to Figma/);
  assert.equal(dropped, true);
});

// ---------- one run at a time, kit, verify notes, changed checks ----------

test('project lock: a second run is refused; a dead or silent holder is taken over; released after the run', async () => {
  const { acquireLock, LOCK_FILE } = await import('../tools/project.js');
  const out = tmp();
  const release = acquireLock(out);
  assert.throws(() => acquireLock(out), /another figma-lens project run is working on this app/);
  release();
  assert.equal(fs.existsSync(path.join(out, LOCK_FILE)), false);
  // holder process gone (same machine): stale
  fs.writeFileSync(path.join(out, LOCK_FILE), JSON.stringify({ pid: 999999, host: os.hostname(), startedAt: 'x' }));
  acquireLock(out, { alive: () => false })();
  // other machine, not refreshed for longer than staleMs: stale
  fs.writeFileSync(path.join(out, LOCK_FILE), JSON.stringify({ pid: 1, host: 'elsewhere', startedAt: 'x' }));
  assert.throws(() => acquireLock(out, { staleMs: 60000 }), /another figma-lens project run/);
  acquireLock(out, { staleMs: 60000, now: () => Date.now() + 120000 })();

  const p = project();
  const hold = acquireLock(p.out);
  const claude = fakeClaude(p.worktree);
  await assert.rejects(buildApp({ screens: [p.screen('Login', '1:1')], file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: claude.run, verify: ok }), /another figma-lens project run/);
  assert.equal(claude.calls.length, 0, 'nothing ran');
  hold();
  const r = await buildApp({ screens: [p.screen('Login', '1:1')], file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: claude.run, verify: ok });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(p.out, LOCK_FILE)), false, 'released after the run');
});

test('KIT.md lists what each built screen added, and later screens are pointed at it', async () => {
  const p = project();
  const claude = fakeClaude(p.worktree);
  await buildApp({ screens: [p.screen('Login', '1:1'), p.screen('Home', '2:1')], file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: claude.run, verify: ok });
  const kit = fs.readFileSync(path.join(p.out, 'KIT.md'), 'utf8');
  assert.match(kit, /## Login \(`[0-9a-f]+`\)\n- added `src\/login.txt`/);
  assert.match(kit, /## Home/);
  assert.doesNotMatch(claude.calls[0].extra, /KIT\.md/, 'nothing built yet: no kit to point at');
  assert.match(claude.calls[1].extra, /KIT\.md lists the files each built screen added/);
});

test('a failed verify gives the retry only the error lines', async () => {
  const { errorLines } = await import('../tools/project.js');
  const log = [...Array.from({ length: 300 }, (_, i) => `building module ${i}`), 'src/a.ts:3:5 - error TS2322: bad type', 'npm ERR! verify failed', 'done'].join('\n');
  assert.equal(errorLines(log), 'src/a.ts:3:5 - error TS2322: bad type\nnpm ERR! verify failed');
  assert.equal(errorLines('a\nb\nc', 2), 'b\nc', 'no recognisable error line: the last lines');

  const p = project({ fixRetries: 1 });
  const claude = fakeClaude(p.worktree);
  let n = 0;
  await buildApp({ screens: [p.screen('Login', '1:1')], file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: claude.run, verify: () => (++n === 1 ? { ok: false, output: log } : ok()) });
  assert.match(claude.calls[1].extra, /The errors:\n\nsrc\/a\.ts:3:5 - error TS2322: bad type\nnpm ERR! verify failed$/);
  assert.doesNotMatch(claude.calls[1].extra, /building module/);
});

test('a screen that changes the project checks is committed, but flagged (trailer + PROJECT.md)', async () => {
  const p = project();
  const claude = fakeClaude(p.worktree);
  const run = async (o) => {
    fs.writeFileSync(path.join(p.worktree, 'package.json'), JSON.stringify({ scripts: { verify: 'exit 0' } }));
    return claude.run(o);
  };
  const r = await buildApp({ screens: [p.screen('Login', '1:1')], file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: run, verify: ok });
  assert.equal(r.ok, true);
  assert.match(git(p.worktree, 'log', '-1', '--format=%B'), /Figma-Verify-Changed: package\.json/);
  assert.match(fs.readFileSync(path.join(p.out, 'PROJECT.md'), 'utf8'), /changed the project's checks \(package\.json\)/);
  // the next screen leaves the checks alone: no flag
  const claude2 = fakeClaude(p.worktree);
  await buildApp({ screens: [p.screen('Login', '1:1'), p.screen('Home', '2:1')], file: 'Shop', fileKey: 'KEY', cfg: p.cfg, configFile: p.configFile, out: p.out, command: 'c', log: quiet, runScreen: claude2.run, verify: ok });
  assert.doesNotMatch(git(p.worktree, 'log', '-1', '--format=%B'), /Figma-Verify-Changed/);
});

test('project lock on the same machine follows the process, not the heartbeat (a long verify pauses it)', async () => {
  const { acquireLock, LOCK_FILE } = await import('../tools/project.js');
  const out = tmp();
  fs.writeFileSync(path.join(out, LOCK_FILE), JSON.stringify({ pid: 4242, host: os.hostname(), startedAt: 'x' }));
  const later = () => Date.now() + 60 * 60 * 1000; // heartbeat an hour old, process alive
  assert.throws(() => acquireLock(out, { staleMs: 60000, now: later, alive: () => true }), /another figma-lens project run/);
  acquireLock(out, { staleMs: 60000, now: later, alive: () => false })();
});
