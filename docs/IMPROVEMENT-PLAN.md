# figma-lens improvement plan: project mode and auto mode

**Scope.** This is a plan only. Nothing in the code was changed.
**Code basis.** Every `file:line` refers to `origin/main` at **dd332b3** (the merge of PR #3, which includes project mode and browser export). The local `main` checkout is still at 3c8e8b6, six commits behind. I read a snapshot of dd332b3 made with `git archive` and did not touch the checkout.
**Tests.** `npm test` on dd332b3 gives **113 of 113 passed, 0 failed** (about 44 s).
**Data.** MEASURED numbers come from real runs on this machine, in `Documents/Basic/lens-playground`, `Documents/Basic/lens-showcase` and `Documents/hayyacom-figma-test`. They cover 4 auto runs (3 finished, 1 failed) and 1 project run that was interrupted. ESTIMATED numbers say how they were estimated. No Claude, Figma or browser run was started for this plan.

Score = 2×Quality + Time + Tokens + Risk + Effort. Each part is rated 1–5, and for Risk and Effort, 5 means safest or smallest. **Override:** safety and correctness fixes go first in the roadmap, whatever their score.

---

## 1. Summary: top 5 changes

| # | Change | Expected effect |
|---|---|---|
| 1 | **A lock for each project run, with stale-lock detection (P1).** Ordered first for safety. | Two runs can no longer work in one worktree, double-commit or double-spend. Leftover `building`/`running` state is recognised and recovered. |
| 2 | **A foundation gate: pause after the first screen (P11).** | Weak shared components get fixed once, before N−1 screens copy them. This has the biggest quality effect. Cost: one human review. |
| 3 | **Keep the user's global environment out of unattended runs (NEW-A).** | First-turn context is 42–45K tokens today (MEASURED). Expected to fall by about 15–25K, which is about 1–3M fewer cache-read tokens per screen (ESTIMATED). The user's personal rules also stop leaking into runs. |
| 4 | **`check` prints a stop verdict (P13).** | Removes the extra check that changed nothing, seen in 2 of 3 runs (MEASURED). Saves about 2–14 min per screen (MEASURED gaps between checks). |
| 5 | **Unique routes when screen names repeat (NEW-C).** | Fixes a real collision: all 4 screens in the hayyacom test are named "Html → Body" (MEASURED), so the prompt gives every one of them the same route. |

---

## 2. Baseline: where time and tokens go now

### Lifecycle of one screen in project mode
1. **Export.** `runProject` opens the browser, then `collectScreens` exports every screen in the app, every time (project.js:347–356, 286–325).
2. **Hash.** `specHash` hashes spec plus tokens for each screen (project.js:56–65, 367).
3. **Plan.** Trailers in `git log` are compared with the hashes to give done, changed or todo (project.js:73–105, 385–390).
4. **Prompt.** The prompt is built from the auto prompt (auto.js:171–213), the app context (project.js:121–132) and the config instructions.
5. **Claude Code run.** A fresh headless session (auto.js:215–230, 551–596). Claude reads the skill, the project's CLAUDE.md, spec.md, the section .md files and the section crops, builds, then runs the compare loop. The prompt says to stop at ≤3% or when two runs in a row stop improving (auto.js:186–188).
6. **Verify.** `auto.verify` runs through a shell (project.js:236–242).
7. **Commit or retry.** On success, `commitScreen` (project.js:200–215). On failure, up to `fixRetries` fresh sessions with a note (project.js:429–467). If it still fails, `shelveAttempt` saves a patch and resets (project.js:217–226, 476–489).

Quality is lost in four places: the shared kit chosen in step 5 of the first screen, the routes (project.js:128), a verify gate that Claude can edit (step 6), and compare noise.

### Measured cost per screen (auto runs; `claude.json` and `run.json`)

| Run | Status | Wall time | API time | Turns | Cost (list price) | Cache read | Cache write | Output | Denials | Images read |
|---|---|---|---|---|---|---|---|---|---|---|
| playground/main | done | 20.9 min | 16.9 min | 71 | $4.16 | 5.32M | 155K | 44K | 10 | — |
| showcase/html-body | done | 14.3 min | 10.4 min | 80 | $4.31 | 5.71M | 139K | 32K | 7 | 1 |
| showcase/main | done | 41.9 min | 31.2 min | 123 | $5.89 | 8.85M | 181K | 48K | 14 | 3 |
| playground/html-body | failed ("Request timed out") | 32.8 min | 19.5 min | 43 | $4.40 | 2.85M | 147K | 29K | 7 | 7 |

All MEASURED. Other measured details:
- **Context per turn.** It is **42–45K tokens before Claude reads any file** (cache tokens of the first assistant message). It grows to **153–195K** by the end. On average, about 66–75K per turn (cache read ÷ turns).
- **What loads at startup.** The `init` event lists **330 skills, 72 agents and 9 MCP servers** (Zoho, IBKR, Stitch and others) inherited from the user's setup, even though hooks are disabled (auto.js:227).
- **Unexplained second model.** `claude-fable-5-1` appears in `modelUsage` with 76–149K **uncached** input and costs **$1.0–2.1 per run (24–47% of the cost)**. No assistant message in `claude.jsonl` uses that model, so the stream does not show what it does. **Unexplained; measure it** (see §5).
- **Time outside the API.** 19–41% of wall time is spent outside API calls (wall vs `duration_api_ms`). Runs also show 12–27 `rate_limit_event`s and up to 17 `api_retry`s.
- **Permission denials.** 7–14 per run, which is **9–16% of turns** wasted.
- **Compare loop.** 2–4 checks per screen: 5.4→3.3→1.8→**1.8**, 4.4→0.5, and 4.1→3.4→2.2→**2.2**.
- **Prompt caching already works.** Cache writes use the 1-hour TTL, and cache reads are more than 97% of input tokens. The remaining lever is the size of each turn's context, not cache hits.

### What Claude reads (MEASURED file sizes; tokens ESTIMATED as bytes ÷ 4)
- spec.md: 8.8–43 KB, about 2–11K tokens.
- `sections/*.md`: 62–98 KB per screen, about 15–25K tokens, if all are read.
- Section crops: up to 1568 px each, and every image read is re-sent on every later turn.
- FLOWS.md: 1.5 KB. SKILL.md: 184 lines, about 4K tokens. The project's CLAUDE.md: 5.7 KB.
- Tool results per run: 35–108K characters from Read and 18–82K from Bash.

**Project mode is not measured yet.** The one project run in `hayyacom-figma-test` stopped while still in progress: `run.json` says `"running"` and `project.json` says `"building"` since 2026-11-06 17:01. There is no data on export time per screen, on retries, or on verify failures.

---

## 3. Findings

### P1: No lock against two project runs
Status: **confirmed** · Evidence: there is no lock anywhere in tools/project.js, tools/auto.js or bin/figma-lens.js. `writeState` reads, modifies and writes `project.json` with no guard (project.js:254–267). `createWorktree` reuses an existing worktree without complaint (auto.js:158). Stale state is real: `hayyacom-figma-test` was left at `building`/`running`.
Root cause: project mode assumes one run per app.
Options:
- (a) Do nothing.
- (b) A lock file `design/.figma-lens-project.lock` created with `wx`, holding `{pid, host, startedAt}`, plus a heartbeat (mtime touched each minute). It counts as stale if the pid is dead on the same host, or the heartbeat is older than `idleMinutes`+5.
- (c) An OS-level lock (proper-lockfile). Adds a dependency.

Chosen: **(b)**. No dependency, and it works on Windows (`process.kill(pid, 0)`). A lock that can't be confirmed stale is refused with a message, never taken over silently.
Expected effect: prevents duplicate Claude runs, which would cost $4–6 and 15–40 min each (MEASURED per-screen cost).
Risk 5 · Effort S · Score 2·2+1+2+5+4 = **16** (first because of the safety override).
Proof: tests in project.test.js using the injectable `runScreen` (project.js:377):
- A second `buildApp` while the first holds the lock is rejected.
- A lock with a dead pid is taken over.
- The lock is released on throw.

### P2: Browser staging folders are never swept
Status: **confirmed** · Evidence:
- The browser path creates `browser-<uuid>` folders (server.js:232–236, browser.js:558) and removes them only when a job finishes or reports an error (browser.js:581–583, 604, 667).
- The only sweep is inside `createUploads().start()` (server.js:347–356, 369), which only the plugin upload path calls.
- A crash, Ctrl+C or a closed tab during an export leaves the folder forever.
Options: (a) Sweep old entries at every CLI entry point (`browser`, `project`, `bridge`), reusing the same rule: only entries older than the TTL. (b) Clean up on SIGINT only. That misses crashes.
Chosen: **(a)**. Move the sweep into an exported `sweepStaging(outRoot, ttl)` and call it at the start of `exportFromBrowser`.
Expected effect: no disk leaks. Exports are 2–7 MB of screenshots each (MEASURED).
Risk 5 · Effort S · Score 2+1+1+5+5 = **14**.
Proof: a bridge.test.js case. An old `browser-x` folder is removed; a fresh one, and the active session's folder, are kept.

### P3: No early warning when figma.com changes `window.figma`
Status: **confirmed** · Evidence:
- page.ts:8–9 notes that the page object is not a documented API.
- `status()` only checks that `figma` exists (page.ts:55–57).
- The tests use a fake `figma` object (browser.test.js:60).
Options: (a) A capability probe in `status()` that lists the exact missing members (`getNodeByIdAsync`, `exportAsync`, `loadAsync`, `flowStartingPoints`, `currentPage.selection`). `--doctor` would show them, and the plugin would be named as the fallback. (b) A scheduled real-file canary. It needs a login secret in CI, so it is not proposed for CI; it can run as a manual weekly `figma-lens browser --doctor --probe`.
Chosen: **(a)**, plus the manual canary documented.
Risk 5 · Effort S · Score 2+1+1+5+4 = **13**.
Proof: a browser.test.js case. A fake `figma` with no `exportAsync` gives a `missing: ['exportAsync']` reason.

### P4: Prototype export timing and frames on other pages
Status: **partly confirmed, and one bug** · Evidence:
- The official Plugin API Trigger docs say "Both `timeout` and `delay` are stored in milliseconds" ([developers.figma.com/docs/plugins/api/Trigger](https://developers.figma.com/docs/plugins/api/Trigger/)).
- render-md.js:191–192 prints them with an `s` suffix, so a 300 ms delay is shown as "300s". **Bug.**
- `Transition.duration` has no documented unit ([Transition docs](https://developers.figma.com/docs/plugins/api/Transition/)). render-md.js:209 assumes seconds, and only a forum report supports that. **Unverified.**
- Frames on another page are loaded with `loadAsync` (page.ts:113). That matches the docs' dynamic-page rule but has not been run on a real multi-page file.
- One real file (hayyacom-figma-test) confirms ON_CLICK navigation on a single page (MEASURED). It has no timing values.

Options: (a) Fix the units for `timeout`/`delay` now, and settle `duration` with an experiment. (b) Leave as is.
Chosen: **(a)**.
Experiment: a real file with an After-delay of 300 ms, a Smart-animate of 300 ms and a link to a frame on page 2. Export it with `--flow` and inspect `spec.json`.
Risk 5 · Effort S · Score 2·3+1+1+5+5 = **18**.
Proof: a sections.test.js or bridge.test.js snapshot where `{timeout: 300}` renders as "300 ms", plus the result of the experiment above.

### P5: `auto.verify` runs through a shell
Status: **confirmed, low severity** · Evidence: `spawnSync(command, { shell: true })` (project.js:239). The command comes from `figma-lens.config.json` in the user's own checkout. That is the same trust as their npm scripts, and auto.js:5 already says the safety model is "a guard, not a sandbox".
Options: (a) Do nothing. (b) Split the command into argv and drop the shell. That breaks `a && b`, which users need. (c) Print the verify command and the config path once at the start of the run.
Chosen: **(c)**. The real gap is NEW-D.
Risk 5 · Effort S · Score 2+1+1+5+5 = **14**.
Proof: a test that the start log contains the command and the config path.

### P6: Only node_modules is kept out of commits
Status: **confirmed, partly** · Evidence: `KEEP_OUT` lists only node_modules (project.js:189), and the commit uses `git add -A` (202, 220). `-A` respects `.gitignore`, so the exposure is a repo without ignore rules: `.env`, keys, build output, big binaries.
Options:
- (a) Silently exclude a denylist. This hides files and leaves them untracked.
- (b) Before committing, check staged paths against a secret denylist (`.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`) and a size cap (>5 MB). On a hit, unstage, do not commit, and mark the screen `needs-review` with the file list.
- (c) Do nothing.

Chosen: **(b)**. Fails closed and loses no work: the files stay in the worktree.
Risk 5 · Effort S · Score 2+1+1+5+4 = **13**.
Proof: a project.test.js case. Claude's fake run writes `.env`, so the commit is refused, the status is needs-review and `.env` is still on disk.

### P7: The DevTools port stays open after the CLI exits
Status: **partly confirmed (by design)** · Evidence:
- The port is chosen by the browser with `--remote-debugging-port=0` (browser.js:353).
- Project mode disconnects and leaves the window open (project.js:355), and `disconnect` only closes the CDP connection (browser.js:883–889).
- The port listens on loopback only, but any local process on the machine can drive the signed-in Figma session while the window is open.

Options: (a) In `project` mode, close the browser after the export phase if figma-lens started it. Keep reuse for the interactive `browser` command. (b) `--remote-debugging-pipe`, which loses window reuse. (c) Document only.
Chosen: **(a)**. Project mode doesn't need the browser after step 1. Cost: the next run's start, about 5–20 s plus loading the file (ESTIMATED, not timed).
Risk 4 · Effort S · Score 2+1+1+4+5 = **13**.
Proof: a test with an injected `closeBrowser` that is called exactly when `started` is true.

### P8: One delivery function per page, shared context, no busy guard
Status: **confirmed, low impact today** · Evidence:
- `d.ctx` and `d.jobs` are shared for each page (browser.js:539–543), overwritten (640–641) and cleared for each batch (652).
- Page-side `exportNodes` has no guard (page.ts:77).
- No concurrent caller exists in one process: `collectScreens` awaits each export (project.js:291, 322). Two CLI processes on the same tab would run `exportNodes` at the same time.

Options: (a) A page-side `busy` flag that returns "another figma-lens export is running in this tab", plus a CLI-side check that `d.ctx` is null before setting it. (b) Rely on the P1 lock. That doesn't cover two `browser` commands.
Chosen: **(a)**.
Risk 5 · Effort S · Score 2+1+1+5+4 = **13**.
Proof: a browser.test.js case where two concurrent `exportNodes` calls on the fake page give one export and one busy error.

### P9: Each screen is a full Claude Code run
Status: **confirmed** · Evidence: project.js:411 and PROJECT.md:19. MEASURED: 14–42 min and $4.2–5.9 per screen, so a 20-screen app takes about 5–14 h (ESTIMATED: 20 × the measured range).
Options:
- (a) Parallel screens in separate worktrees. Screens that ran in parallel can't reuse each other's components, and merging N branches that each create a "Button" brings conflicts and duplicate kits. Rejected for now: score 2+5+1+1+1 = 10.
- (b) Make each run cheaper with NEW-A, NEW-B, P13 and P12.
- (c) A cheaper `auto.model` (it already exists, auto.js:43). This should be an A/B experiment, not a default.

Chosen: **(b)**, then measure (c).
Expected effect: about 15–30% less time and tokens per screen if (b) lands (ESTIMATED from the turn and context shares in §2).
Proof: the §5 metrics on 3+ screens before and after.

### P10: Every re-run exports every screen again
Status: **confirmed** · Evidence: `collectScreens` always exports (project.js:291, 322), and `specHash` is computed only after the export (367). `specHash` reads only `spec` and `tokens.json` (56–65), not the images.
Options:
- (a) A spec-only export pass that skips PNG (core.ts:984) and SVG (core.ts:425), then a full export only for screens that are todo, changed or needs-review.
- (b) The file `version` from the REST API. Needs a personal token, and only says that something in the file changed.
- (c) Do nothing.

Chosen: **(a)**. **Unverified:** whether the spec-only spec hashes the same. Asset references in the spec might depend on the exported files. A test settles it.
Expected effect: export time for done screens drops to spec walking only. The size is unknown, because no export timing was logged (ESTIMATED: most of the export is PNG rendering of 2–7 MB screenshots).
Risk 4 · Effort M · Score 2+4+1+4+2 = **13**.
Proof: a plugin.test.js case where `specHash(full) === specHash(specOnly)` on fixture nodes, plus timing from the export log on a real file.

### P11: Errors compound from the first screen
Status: **confirmed** · Evidence: only the first screen is told to "set up shared parts … the next screens reuse them" (project.js:125). Every later screen is told to reuse them (126). There is no review point.
Options:
- (a) `--pause-after 1`, the default in project mode. Stop after the first committed screen, print a review checklist (tokens file, kit components, routes), and continue on the next run.
- (b) A dedicated foundation run that builds tokens and kit from all screens' `tokens.json` and component usage before any screen. Larger, with new prompt engineering.
- (c) Do nothing.

Chosen: **(a)** now and (b) later, once the data shows kit churn.
Expected effect: quality, since one review prevents N−1 copies. Costs one human stop.
Risk 5 · Effort S · Score 2·5+2+2+5+4 = **23**.
Proof: a project.test.js case. After screen 1, `buildApp` returns `paused`, PROJECT.md shows "review the foundation", and the next call builds screen 2.

### P12: Context per screen is more than each step needs
Status: **partly confirmed** · Evidence:
- The skill already stages large frames: one section and one image at a time (SKILL.md:53–61, auto.js:194–198).
- The waste is the starting context (NEW-A) and later screens rediscovering the kit through `git log`/`git show` (project.js:126).
Options: (a) Write `design/KIT.md` after each commit: the files each screen added (from `git show --stat`) and the exports of components and tokens, then point the prompt at it. (b) Do nothing.
Chosen: **(a)**.
Expected effect: fewer exploratory Read/Grep/Glob calls on later screens (ESTIMATED; showcase/main spent 35 Reads and 5 Greps, many of them on existing components).
Risk 5 · Effort M · Score 2·3+2+3+5+3 = **19**.
Proof: a project.test.js case where KIT.md lists screen 1's files before screen 2 runs, plus Reads per screen in §5.

### P13: Compare-loop cost
Status: **confirmed** · Evidence:
- The stop rule exists only as an instruction (auto.js:188, SKILL.md:81).
- MEASURED: 2 of 3 runs did one extra check after the score was already ≤3% and flat (1.8→1.8, 2.2→2.2).
- `check` already knows the previous score (compare.js:330–336, 271).
- False differences are already reduced: text "suspects" exist, and text tolerance is off by default (compare.js:142–185).

Options: (a) `report.md` and the CLI output end with `VERDICT: STOP (≤3%)`, `STOP (no improvement since last run)` or `CONTINUE`. (b) Hard enforcement. figma-lens can't stop Claude mid-session.
Chosen: **(a)**.
Expected effect: about 1 check fewer per screen in 2 of 3 runs, which is 2–14 min (MEASURED gap between checks).
Risk 5 · Effort S · Score 2·2+3+3+5+5 = **20**.
Proof: compare.test.js cases for each verdict, plus check iterations counted after the run starts (§5).

### P14: Retries restart with long notes
Status: **partly confirmed** · Evidence:
- Notes for failed runs are already short (project.js:445).
- A verify failure appends the last 80 lines of output (project.js:240, 453).
- Each retry is a fresh session that rediscovers context: about 45K tokens before any read, then spec and code reads.

Options:
- (a) Keep fresh sessions, but filter verify output to error lines (TS/eslint/flutter patterns, at most 40) and list the changed files.
- (b) `--resume <session_id>` ([CLI reference](https://code.claude.com/docs/en/cli-reference)). The session already knows the work, but it carries a 150–195K context into every fix turn.
- (c) Do nothing.

Chosen: **(a)**. (b) is worth an A/B test only if fix retries are frequent, and there is no project-mode data yet.
Risk 4 · Effort S · Score 2·2+2+2+4+4 = **16**.
Proof: a project.test.js case where a 500-line verify log with 3 errors gives a note with those 3 lines.

### NEW-A: The user's global environment leaks into unattended runs
Status: **NEW, confirmed** · Evidence:
- `claudeArgs` disables hooks only (auto.js:227).
- `init` shows 330 skills, 72 agents and 9 MCP servers.
- showcase/main tried **3 Edits on `~/.claude/brutal-review/ledger.md`** and a chrome-devtools MCP call. Both come from the user's global CLAUDE.md and plugins, not from figma-lens (MEASURED, `permission_denials`).

Options:
- (a) `--bare`. Documented to skip "hooks, skills, custom commands, subagents, installed plugins, MCP servers, auto memory, and CLAUDE.md", while skills in an `--add-dir` still load ([CLI reference](https://code.claude.com/docs/en/cli-reference)). It also drops the **project** CLAUDE.md, which auto.js:185 relies on, so the prompt must tell Claude to Read it, or figma-lens must append it with `--append-system-prompt`. **Unverified:** whether bare mode accepts the user's subscription login.
- (b) `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` plus `--disallowedTools "mcp__*"`. Removes MCP only.
- (c) `--setting-sources project,local`. Whether this drops user CLAUDE.md and plugins is **unverified**.

Chosen: run the §5 experiment first. Ship (a) if auth works, otherwise (b) together with (c) if (c) proves effective. Make it a config switch, `auto.isolate`, on by default.
Expected effect: −15–25K tokens per turn, which is −1–3M cache reads per screen (ESTIMATED: Claude Code's own base prompt assumed to be ≤20K of the measured 42–45K). Also fewer off-task turns.
Risk 3 · Effort M · Score 2·4+3+4+3+3 = **21**.
Proof: in auto.test.js, an argv assertion; in a real measurement, first-turn context and the denial count.

### NEW-B: Permission denials waste 9–16% of turns
Status: **NEW, confirmed** · Evidence: 7–14 denials per run (MEASURED). The denied commands are compound `cd … && ls | head`, `sed -i`, `cp -r` to `public/`, `python -c` with PIL, ad-hoc Playwright scripts, `netstat` and PowerShell port checks, and `mkdir /tmp`. The allowlist is in auto.js:17–23.
Options:
- (a) Add CLI helpers so Claude doesn't hand-roll tools: `figma-lens port` (a free port) and `figma-lens check --section N` (a crop and score for one section). Allow `sed`, `grep`, `find`, `rg` and `cp -r`. State in the prompt that compound commands must use allowed programs.
- (b) `--permission-mode bypassPermissions`. Rejected because it weakens the guard.
- (c) Do nothing.

Chosen: **(a)**.
Expected effect: about 5–10 fewer wasted turns per screen (ESTIMATED from the denial list).
Risk 3 (a wider allowlist) · Effort M · Score 2·2+3+3+3+3 = **16**.
Proof: auto.test.js argv cases, plus the denial count in §5.

### NEW-C: Duplicate screen names give identical routes
Status: **NEW, confirmed** · Evidence: the prompt tells Claude to give a screen that isn't built yet "its name in kebab-case" (project.js:128). The real app in `hayyacom-figma-test` has 4 screens, all named "Html → Body" (MEASURED, `project.json`/FLOWS.md). The folders are unique (`html-body-152-279`) but the routes are not.
Options: (a) Compute a unique route slug for each screen in `buildApp` (name slug, plus the folder suffix on collision), list it in FLOWS.md and the prompt, and use it for links. (b) Ask the user to rename the frames. Fragile.
Chosen: **(a)**.
Risk 5 · Effort S · Score 2·4+1+1+5+5 = **20**.
Proof: a project.test.js case where 3 screens with the same name get 3 distinct routes in the prompt.

### NEW-D: Claude can weaken the verify gate
Status: **NEW, confirmed** · Evidence: verify runs in the worktree (project.js:448), and Claude may Edit `package.json` there (auto.js:18). The only defence is the sentence "don't remove checks" (project.js:453).
Options: (a) Hash the files the verify command depends on (`package.json` scripts, lint/tsconfig/analysis_options) at the start of each screen. If they changed, still commit, but add a `Figma-Verify-Changed:` trailer and flag it in PROJECT.md. (b) Run verify from the base commit's scripts. Breaks legitimate new scripts.
Chosen: **(a)**.
Risk 5 · Effort S · Score 2·3+1+1+5+4 = **17**.
Proof: a project.test.js case where the fake run edits `scripts.verify`, so the commit has the trailer and PROJECT.md shows a warning.

---

## 4. Roadmap (one PR per step, in order)

| # | Step | Files | Tests | Score |
|---|---|---|---|---|
| 0 | `figma-lens stats <design>`: prints the §5 metrics from run.json, claude.json, claude.jsonl and history.json. Needed to measure everything after it. | tools/stats.js, bin/figma-lens.js | stats.test.js with fixture logs | prereq |
| 1 | Project lock with stale detection (P1) | tools/project.js | project.test.js | 16 (safety) |
| 2 | Commit guard for secrets and big files (P6) | tools/project.js | project.test.js | 13 (safety) |
| 3 | Staging sweep at every entry point (P2) | bridge/server.js, tools/browser.js | bridge.test.js | 14 (safety) |
| 4 | Pause after the first screen (P11) | tools/project.js, bin/figma-lens.js, docs/PROJECT.md | project.test.js | 23 |
| 5 | Unique routes (NEW-C) | tools/project.js, bridge/flows.js | project.test.js | 20 |
| 6 | Stop verdict in `check` (P13) | tools/compare.js, skill/figma-lens/SKILL.md, tools/auto.js | compare.test.js | 20 |
| 7 | Run the isolation experiment (§5). Then add `auto.isolate` (NEW-A). | tools/auto.js, docs/PROJECT.md | auto.test.js | 21 |
| 8 | KIT.md after each commit (P12) | tools/project.js | project.test.js | 19 |
| 9 | Fix timing units; run the duration experiment (P4) | bridge/render-md.js | sections.test.js | 18 |
| 10 | Verify-tamper trailer (NEW-D) | tools/project.js | project.test.js | 17 |
| 11 | Filtered verify retry note (P14) | tools/project.js | project.test.js | 16 |
| 12 | Helpers plus allowlist (NEW-B) | tools/auto.js, bin/figma-lens.js | auto.test.js | 16 |
| 13 | Print the verify command (P5); close the browser after project export (P7) | tools/project.js | project.test.js | 14 / 13 |
| 14 | Page busy guard and capability probe (P8, P3) | plugin/src/page.ts, tools/browser.js | browser.test.js | 13 |
| 15 | Spec-only change detection (P10) | plugin/src/core.ts, tools/project.js | plugin.test.js, project.test.js | 13 |

Step 4 comes before steps 5–15 despite similar scores because it protects every later run. Step 7 is split into experiment then code so nothing ships on an unverified flag. No step changes the existing guarantees: worktree only, never merge or push, shelve to a patch, refuse unknown changes in the worktree.

---

## 5. Metrics: how to measure before and after each step

Per screen (step 0 automates these):
- **Time.** `run.json`: `durationMs`, `attempts`, `status`. `claude.json`: `duration_api_ms`. Wall time minus API time gives tool and wait time.
- **Tokens.** `claude.json`: `usage.cache_read_input_tokens`, `cache_creation_input_tokens` and `output_tokens`; `modelUsage[*]` for each model; `num_turns`.
- **Starting context.** In `claude.jsonl`, the first `assistant` event's `cache_read + cache_creation + input` tokens.
- **Waste.** `permission_denials.length`, the count of `system:api_retry`, and the number of image Reads.
- **Compare loop.** `compare/history.json` entries with `at >= run.startedAt` (the file is append-only across runs): the count, the final score, and whether the last two are equal.
- **Project.** `project.json`: statuses, `attempts`, and patches; export seconds from the browser log ("exported … in Ns").

Experiments:
- **(E1) Isolation.** In an empty git repo, run `claude -p "reply ok" --output-format json` four times: plain, `--bare`, `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, and `--setting-sources project,local`. Compare `usage` (cache creation is the starting context) and whether authentication works. Cost: a few cents.
- **(E2) Second model.** Run one auto screen with `--debug` or `ANTHROPIC_LOG=debug`, and check which requests use `claude-fable-5-1` (possibly Claude Code's background or permission-check model; unverified).
- **(E3) Timing.** Use the P4 file described above.
- **Quality before and after.** Final mismatch per screen; the number of duplicate components after N screens (`git log --stat` on kit folders); verify pass rate on the first attempt.

---

## 6. Open questions

1. Local `main` is 6 commits behind `origin/main`. Should I fast-forward it, or leave it?
2. Do auto runs use a Claude subscription login or an API key? `--bare` may need an API key, and that decides which way NEW-A goes.
3. Should pausing after the first screen be the default in project mode, or an opt-in `--pause-after 1`?
4. Is it acceptable that `figma-lens project` closes the browser window it opened after exporting? The next run re-opens it, still signed in.
5. May I run experiment E1? That is 4 tiny `claude -p` calls, a few cents. They are the only way to size NEW-A before building it.

Sources:
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Figma Trigger: https://developers.figma.com/docs/plugins/api/Trigger/
- Figma Transition: https://developers.figma.com/docs/plugins/api/Transition/
- Figma PageNode: https://developers.figma.com/docs/plugins/api/PageNode/
