#!/usr/bin/env node
// figma-lens CLI: bridge, render, compare-and-fix, component map, demo.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { startBridge, writeDerived } from '../bridge/server.js';
import { summarizeUsage } from '../bridge/render-md.js';
import { compare } from '../tools/compare.js';
import { shotWeb, shotAdb } from '../tools/shot.js';
import { initMap, loadMap, findMap, MAP_FILE } from '../tools/map.js';
import { makeDemo } from '../tools/demo.js';
import { findConfig, prepareJob, runJob, CONFIG_FILE, CONFIG_TEMPLATE } from '../tools/auto.js';
import { nameAssets } from '../bridge/asset-names.js';
import { resolveBrowserSettings, runBrowser, doctor, initBrowserConfig, login } from '../tools/browser.js';
import { runProject, projectStatus } from '../tools/project.js';
import { parity, parityLines } from '../tools/parity.js';
import { c, pct } from '../tools/colors.js';

const HELP = `figma-lens — let coding agents see Figma designs accurately

Usage:
  figma-lens bridge  [--out design] [--port 4141] [--map figma-lens.map.json] [--auto]
      Receive exports from the Figma plugin. With --auto (and auto.enabled in ${CONFIG_FILE}),
      every export is then implemented by Claude Code, one at a time, in a git worktree on
      branch figma/<frame>. It never commits or pushes: you review the branch.

  figma-lens browser [figma link | name] [--once] [--flow] [--flow-max 30] [--auto] [--out design] [--browser path] [--profile dir] [--map file] [--scale 2] [--css-limit n] [--max-layers n] [--no-css] [--config file]
      Export from figma.com in your own Chrome/Chromium/Edge (Linux, macOS, Windows): no Figma desktop
      app, no plugin. Opens a browser window with its own profile (sign in once); select frames in
      Figma and press Enter, or pass a Figma link with ?node-id= or a name from browser.files (exports
      it and exits). --flow also exports every screen the frames link to (prototype), and so on.
      --auto hands each exported screen to Claude Code (same as bridge --auto).
      Every export also updates design/FLOWS.md: the map of how the screens connect.
      Settings: flags > env (FIGMA_LENS_BROWSER, FIGMA_LENS_PROFILE, FIGMA_LENS_OUT) > "browser" in
      ${CONFIG_FILE} > auto-detect. Uses an undocumented figma.com page API; the plugin is the fallback.
  figma-lens browser --doctor     Show the browser, profile, output folder and display it will use, and what is wrong.
  figma-lens browser --init       Add a "browser" section to ${CONFIG_FILE} in the current folder.
  figma-lens browser --login      Sign in to Figma in the figma-lens profile without the DevTools port. figma-lens
      browser and figma-lens project do this by themselves when the profile isn't signed in.

  figma-lens project "<link to the first screen>" [--if-no-links this|page|stop] [browser flags]
      Build the whole app, unattended: signs in if needed, follows the prototype from that screen,
      then has Claude Code build every screen one after another on ONE branch figma/app-<file>
      (later screens reuse what earlier ones added). Each finished screen that passes auto.verify
      is committed on that branch; a screen that keeps failing is saved as a patch and skipped.
      Run the same command again to continue: it knows what is built, what changed in Figma and
      what is next (design/PROJECT.md). Never touches your branch, never merges, never pushes.
  figma-lens project --status     Show design/PROJECT.md: what is built, what failed, what is next.

  figma-lens parity  <export A> <export B> [--json]
      Compare two exports of the same frame (e.g. desktop plugin vs browser): layers, properties,
      tokens, icons/images by content and the frame preview pixels. Exit code 1 when they differ.

  figma-lens auto    --init
      Write a starter ${CONFIG_FILE} in the current folder (your project root).
  figma-lens auto    --design design/<frame> [--config ${CONFIG_FILE}] [--dry-run]
      Run (or with --dry-run: only print) the Claude Code job for one export, e.g. to retry it.

  figma-lens check   --design design/<frame> (--url <page url> | --adb) [--viewport] [--crop-top px] [--crop-bottom px] [--fail-above pct] [--text-tolerance units] [--run id]
      Render your build and compare it with the Figma frame (shot + compare in one step).
      The last line is a verdict: STOP (within 3%, no real improvement in 2 checks, or 6 checks) or CONTINUE
      (on "made it worse", undo the last change first). It is judged against earlier checks with the same
      --run id (one id per task; FIGMA_LENS_RUN wins when set). Without an id, only the 3% target stops.

  figma-lens port
      Print a free TCP port on 127.0.0.1 (for a dev server).
      Web pages are captured full-page, so a build taller than the frame is reported instead of
      cut off. --viewport captures only the frame-sized viewport (e.g. a scrolling app screen
      whose frame shows one screenful); full-page capture also resizes 100vh / position:fixed.

  figma-lens shot    --design design/<frame> --url <page url> [--out shot.png] [--full] [--wait ms] [--channel msedge|chrome]
  figma-lens shot    --adb [--serial id] --out shot.png
      Render a web page (or Flutter web) at the frame's size, or an Android device/emulator, as an image.

  figma-lens compare --design design/<frame> --actual shot.png [--crop-top px] [--crop-bottom px] [--out dir] [--fail-above pct] [--text-tolerance units] [--run id]
      Diff an image of your build against the frame. Writes compare/{report.md,report.json,diff.png,side-by-side.png}.
      --text-tolerance 1 (experimental, off by default) ignores glyph edges off by up to 1 design unit
      inside text layers; it can also hide one-letter text changes. Text suspects are always reported.

  figma-lens map     [--design design] [--map figma-lens.map.json]
      Create/extend the component map with every component and token seen in the exports.

  figma-lens render  design/<frame> [--map figma-lens.map.json]
      Re-generate spec.md, the section crops and (for large frames) the per-section spec files,
      e.g. after editing the component map or updating figma-lens. Rewrites spec.json/spec.md and
      replaces <frame>/sections/ (without the frame preview it keeps the existing crops); gives meaningless icon/image names real ones.

  figma-lens demo    --design design/<frame> --before first.png --after fixed.png [--out dir] [--crop-top px]
      Make demo.gif + before-after.png (Figma | build | diff) for a README.
`;

function parse(argv) {
  const flags = {};
  const pos = [];
  const bool = new Set(['full', 'viewport', 'adb', 'json', 'help', 'auto', 'init', 'dry-run', 'once', 'doctor', 'no-css', 'flow', 'login', 'status']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (bool.has(key)) flags[key] = true;
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new Error(`--${key} needs a value`);
        flags[key] = v;
        i++;
      }
    } else pos.push(a);
  }
  return { flags, pos };
}

const num = (v, d) => (v === undefined ? d : Number(v));
// The session the check verdict judges against. FIGMA_LENS_RUN (auto mode sets a fresh one per Claude
// session) wins over --run, so a retry that reuses an id is never judged against the last attempt.
const runIdFrom = (flags) => process.env.FIGMA_LENS_RUN || flags.run || null;

function needDesign(flags) {
  if (!flags.design) throw new Error('--design design/<frame> is required');
  const dir = path.resolve(flags.design);
  if (!fs.existsSync(path.join(dir, 'spec.json'))) throw new Error(`${dir} is not a figma-lens export (no spec.json)`);
  return dir;
}

function readMeta(designDir) {
  return JSON.parse(fs.readFileSync(path.join(designDir, 'spec.json'), 'utf8')).meta;
}

function mapNear(designDir, explicit) {
  if (explicit) return loadMap(path.resolve(explicit));
  return loadMap(findMap([path.dirname(designDir), path.dirname(path.dirname(designDir))]));
}

async function takeShot(flags, designDir, out, { fullPage = !!flags.full } = {}) {
  if (flags.adb) return shotAdb({ out, serial: flags.serial });
  const meta = designDir ? readMeta(designDir) : {};
  return shotWeb({
    url: flags.url,
    width: num(flags.width, meta.width || 390),
    height: num(flags.height, meta.height || 844),
    scale: num(flags.scale, meta.scale || 2),
    out,
    fullPage,
    waitMs: num(flags.wait, 800),
    channel: flags.channel,
  });
}

function printCompare(r, flags) {
  if (flags.json) {
    console.log(JSON.stringify(r, null, 1));
  } else {
    const trend = r.previousMismatchPct != null ? c.gray(` (was ${r.previousMismatchPct}%)`) : '';
    console.log(`${c.bold(r.frame)}: ${pct(r.mismatchPct)} different from the Figma frame${trend}`);
    if (r.text && r.text.ignoredNoisePx) console.log(c.gray(`  font rendering noise ignored (plain pixel diff: ${r.rawMismatchPct}%)`));
    if (Math.abs(r.heightDelta) >= 2) console.log(c.yellow(`  ⚠ your build is ${Math.abs(r.heightDelta)} units ${r.heightDelta > 0 ? 'taller' : 'shorter'} than the frame`));
    for (const g of r.regions.slice(0, 5)) {
      const layers = g.nodes.map((n) => `${n.id} "${n.name}"`).join(', ') || 'background/spacing';
      console.log(`  ${c.gray('-')} ${g.box.x},${g.box.y} ${g.box.w}×${g.box.h}: ${pct(g.mismatchPct)} → ${c.gray(layers)}`);
    }
    console.log(`${c.gray('report:')} ${r.reportFile}`);
    console.log(`${c.gray('Figma | build | diff:')} ${r.files.sideBySide}`);
    if (r.verdict) console.log(r.verdict.stop ? c.green(r.verdict.text) : c.yellow(r.verdict.text));
  }
  if (flags['fail-above'] !== undefined && r.mismatchPct > Number(flags['fail-above'])) process.exitCode = 1;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }
  const { flags, pos } = parse(rest);

  switch (cmd) {
    case 'bridge':
      startBridge({ out: flags.out, port: flags.port && Number(flags.port), map: flags.map, auto: !!flags.auto });
      return;

    case 'auto': {
      if (flags.init) {
        const file = path.resolve(CONFIG_FILE);
        if (fs.existsSync(file)) throw new Error(`${file} already exists`);
        fs.writeFileSync(file, JSON.stringify(CONFIG_TEMPLATE, null, 2) + '\n');
        console.log(`wrote ${file} — edit devServer, url and instructions for this project, then run: figma-lens bridge --auto`);
        // Claude Code reads project rules from ./CLAUDE.md or ./.claude/CLAUDE.md
        if (!['CLAUDE.md', path.join('.claude', 'CLAUDE.md')].some((f) => fs.existsSync(path.resolve(f)))) {
          console.log('');
          console.log(c.yellow('⚠ No CLAUDE.md here.') + ' Auto runs follow ONLY what your project writes down: add a CLAUDE.md with your');
          console.log('  architecture (where pages, components, icons, images and tokens go) and commit it before exporting.');
          console.log('  Guide + templates: https://github.com/mramadan-cell/figma-lens/blob/main/docs/PROJECT-SETUP.md');
        }
        return;
      }
      const designDir = needDesign(flags);
      const configFile = flags.config
        ? path.resolve(flags.config)
        : findConfig([path.dirname(designDir), path.dirname(path.dirname(designDir)), process.cwd()]);
      if (!configFile) throw new Error(`no ${CONFIG_FILE} found near ${designDir} (run figma-lens auto --init in your project)`);
      if (flags['dry-run']) {
        const job = prepareJob({ frameDir: designDir, configFile });
        console.log(`config:   ${configFile}`);
        console.log(`branch:   ${job.plan.branch}`);
        console.log(`worktree: ${job.plan.worktree}  (not created in a dry run)`);
        console.log(`cwd:      ${job.plan.workDir}`);
        console.log(`command:  ${[job.cmd, ...job.args].map((a) => (/[\s"*()]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
        console.log('prompt (sent on stdin):');
        console.log(job.prompt);
        return;
      }
      const run = await runJob({ frameDir: designDir, configFile });
      if (run.status !== 'done') process.exitCode = 1;
      return;
    }

    case 'shot': {
      const designDir = flags.adb ? null : needDesign(flags);
      const out = path.resolve(flags.out || 'shot.png');
      await takeShot(flags, designDir, out);
      console.log(`${c.green('✔')} saved: ${out}`);
      return;
    }

    case 'compare': {
      const designDir = needDesign(flags);
      if (!flags.actual) throw new Error('--actual <build.png> is required (an image of your build)');
      const r = compare({
        designDir,
        actualFile: path.resolve(flags.actual),
        cropTop: num(flags['crop-top'], 0),
        cropBottom: num(flags['crop-bottom'], 0),
        textToleranceUnits: num(flags['text-tolerance'], 0),
        outDir: flags.out && path.resolve(flags.out),
        runId: runIdFrom(flags),
      });
      printCompare(r, flags);
      return;
    }

    case 'port': {
      const srv = net.createServer();
      await new Promise((resolve, reject) => srv.once('error', reject).listen(0, '127.0.0.1', resolve));
      console.log(srv.address().port);
      await new Promise((resolve) => srv.close(resolve));
      break;
    }

    case 'check': {
      const designDir = needDesign(flags);
      const outDir = path.resolve(flags.out || path.join(designDir, 'compare'));
      fs.mkdirSync(outDir, { recursive: true });
      const shot = path.join(outDir, 'actual.png');
      // Full page by default: with a frame-sized viewport, anything below the frame height is cut
      // off, so a build that is too tall never shows up as a height difference.
      await takeShot(flags, designDir, shot, { fullPage: !flags.viewport });
      const r = compare({
        designDir,
        actualFile: shot,
        cropTop: num(flags['crop-top'], 0),
        cropBottom: num(flags['crop-bottom'], 0),
        textToleranceUnits: num(flags['text-tolerance'], 0),
        outDir,
        runId: runIdFrom(flags),
      });
      printCompare(r, flags);
      return;
    }

    case 'map': {
      const designRoot = path.resolve(flags.design || 'design');
      const mapFile = path.resolve(flags.map || MAP_FILE);
      const r = initMap({ designRoot, mapFile });
      console.log(`map: ${r.mapFile}`);
      console.log(`added ${r.added.components.length} component(s), ${r.added.tokens.length} token(s)`);
      if (r.unmapped.components.length) console.log(`components still unmapped: ${r.unmapped.components.join(', ')}`);
      if (r.unmapped.tokens.length) console.log(`tokens still unmapped: ${r.unmapped.tokens.length}`);
      return;
    }

    case 'render': {
      const designDir = path.resolve(pos[0] || flags.design || '');
      if (!fs.existsSync(path.join(designDir, 'spec.json'))) throw new Error(`${designDir} is not a figma-lens export (no spec.json)`);
      const { meta, spec } = JSON.parse(fs.readFileSync(path.join(designDir, 'spec.json'), 'utf8'));
      const tokensAll = JSON.parse(fs.readFileSync(path.join(designDir, 'tokens.json'), 'utf8'));
      const { usage, ...tokens } = tokensAll;
      const map = mapNear(designDir, flags.map);
      const screenFile = meta.screen && path.join(designDir, meta.screen);
      const screenBuf = screenFile && fs.existsSync(screenFile) ? fs.readFileSync(screenFile) : null;
      // Older exports: give meaningless icon/image file names (container-12.svg, hashes) real names.
      const onDisk = ['assets', 'images'].flatMap((d) =>
        fs.existsSync(path.join(designDir, d)) ? fs.readdirSync(path.join(designDir, d)).map((f) => ({ path: `${d}/${f}` })) : [],
      );
      const { renames } = nameAssets(spec, onDisk);
      // Check every rename before doing any, so a problem can never leave the folder half renamed.
      for (const [from, to] of Object.entries(renames)) {
        if (!fs.existsSync(path.join(designDir, from))) throw new Error(`cannot rename ${from}: file not found (nothing was changed)`);
        if (fs.existsSync(path.join(designDir, to))) throw new Error(`cannot rename ${from} to ${to}: target exists (nothing was changed)`);
      }
      for (const [from, to] of Object.entries(renames)) fs.renameSync(path.join(designDir, from), path.join(designDir, to));
      if (Object.keys(renames).length) meta.assetRenames = { ...(meta.assetRenames || {}), ...renames };
      await writeDerived(designDir, { meta, spec, tokens, usage: usage || summarizeUsage(spec), map, screenBuf });
      const parts = meta.sectionPlan.length ? `, ${meta.sectionFiles.length} section crop(s)` : '';
      const named = Object.keys(renames).length ? `, ${Object.keys(renames).length} asset(s) renamed` : '';
      console.log(`${c.green('✔')} rewrote ${path.join(designDir, 'spec.md')}${parts}${named}${map ? ` using ${map.file}` : c.gray(' (no component map found)')}`);
      return;
    }

    case 'demo': {
      const designDir = needDesign(flags);
      if (!flags.before || !flags.after) throw new Error('--before and --after images are required');
      const r = makeDemo({
        designDir,
        before: path.resolve(flags.before),
        after: path.resolve(flags.after),
        outDir: flags.out && path.resolve(flags.out),
        cropTop: num(flags['crop-top'], 0),
        cropBottom: num(flags['crop-bottom'], 0),
      });
      console.log(`${r.frame}: ${r.beforePct}% → ${r.afterPct}% different`);
      console.log(`gif: ${r.gif}`);
      console.log(`png: ${r.png}`);
      return;
    }

    case 'browser': {
      if (flags.init) {
        const r = initBrowserConfig(process.cwd());
        console.log(r.created ? `added a "browser" section to ${r.file}; edit it, then run figma-lens browser --doctor` : `${r.file} already has a "browser" section`);
        return;
      }
      const settings = resolveBrowserSettings({ flags });
      if (flags.doctor) {
        process.exitCode = (await doctor(settings)) ? 0 : 1;
        return;
      }
      if (flags.login) {
        await login(settings);
        return;
      }
      const ok = await runBrowser(settings, { url: flags.url || pos[0], once: !!flags.once, flow: !!flags.flow, auto: !!flags.auto });
      process.exit(ok ? 0 : 1); // drop the DevTools connection; the browser window stays open
    }

    case 'project': {
      const settings = resolveBrowserSettings({ flags });
      if (flags.status) {
        process.exitCode = projectStatus(settings.out) ? 0 : 1;
        return;
      }
      const choice = flags['if-no-links'];
      if (choice !== undefined && !['this', 'page', 'stop'].includes(choice)) throw new Error(`--if-no-links must be this, page or stop; got ${choice}`);
      const ok = await runProject(settings, { url: flags.url || pos[0], ifNoLinks: choice });
      process.exit(ok ? 0 : 1); // drop the DevTools connection; the browser window stays open
    }

    case 'parity': {
      const [a, b] = [pos[0], pos[1]];
      if (!a || !b) throw new Error('usage: figma-lens parity <export A> <export B>');
      const r = parity(path.resolve(a), path.resolve(b));
      if (flags.json) console.log(JSON.stringify(r, null, 1));
      else for (const line of parityLines(r, c)) console.log(line);
      if (!r.same) process.exitCode = 1;
      return;
    }

    default:
      throw new Error(`unknown command "${cmd}" (run figma-lens help)`);
  }
}

main().catch((e) => {
  console.error(`figma-lens: ${e.message}`);
  process.exitCode = 2;
});
