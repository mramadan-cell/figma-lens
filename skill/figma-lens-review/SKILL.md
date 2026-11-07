---
name: figma-lens-review
description: Review already-built web screens after a change — backend/API wiring, real data, state management, refactors — by building the code from before the change and the code after it, scoring both against the Figma export with figma-lens, and checking the screens for real-data problems (overflow, broken images, missing empty/error states). Use when someone asks "did my change break the screens", "review the screens after my commit", "compare the UI before and after", or wants a visual review after linking the backend to finished screens. It reviews and reports only; it does not build screens (that is the figma-lens skill) and is not part of the figma-lens auto/project loop.
---

# figma-lens-review: did this change break the finished screens?

The scenario: the frontend screens were built from Figma (with figma-lens), then someone changed the code —
usually a backend dev linking APIs and real data. This skill answers: **which screens drifted from the design
because of that change, and what looks wrong with real data?** It is run on demand (after a commit, before a PR,
whenever asked). Web only for now (any app that runs in a browser, including Flutter web).

It is **read-only for the user's code**: never stash, checkout, reset, commit or push in the user's checkout, and
never "fix while reviewing". Report what you found and offer fixes; apply them only if the user asks afterwards.

The `figma-lens` command is the CLI from the figma-lens repo (`npm link` there makes it global; otherwise run
`node <figma-lens>/bin/figma-lens.js …`). Exports live in `design/<frame>/` (spec.md, screen@2x.png, …).

## 1. Decide what "before" is, and confirm it

Pick the base ref, then tell the user in one line what you will compare and wait for an OK if it is not obvious:

| Situation | Before | After |
|---|---|---|
| The user named a commit, branch or PR base | that ref | the current checkout |
| Uncommitted changes in the working tree | `HEAD` | the working tree as it is |
| Clean tree, reviewing the last commit | `HEAD~1` | `HEAD` |
| Feature branch, reviewing the whole branch | `git merge-base origin/main HEAD` (or the branch's real base) | `HEAD` |

Write the base as a short sha in the report header, so the result can be reproduced.

## 2. Find the affected screens

1. Changed files: `git diff --name-only <base>` (this includes uncommitted changes; add `git ls-files --others --exclude-standard` for new untracked files).
2. Map files to screens:
   - `design/KIT.md` (written by `figma-lens project`) lists, per built screen, the files its commit added or changed.
   - Otherwise follow imports: which page/route components import the changed files (services, hooks, stores, API clients, shared components).
   - `design/INDEX.md` lists the exported frames; `design/PROJECT.md` (project mode) lists built screens.
   - A change to something every screen uses (theme, layout, API client, auth) affects all screens: review them all, or the ones the user picks.
3. For each screen find its **route** in the app's router and what it needs to show real content: login, a seeded record id, a query string, feature flags. If you cannot tell, ask once with the full list instead of guessing per screen.
4. Screens **with** a `design/<frame>` export get a Figma score before and after. Screens **without** one get only the real-data look (step 5). Say which is which.

## 3. Run "before" and "after" side by side

**Before** runs in a temporary git worktree, so the user's checkout is never touched:

1. Clean up leftovers from an earlier review first: `git worktree list`, and remove only worktrees whose folder name starts with `figma-lens-review-` (`git worktree remove --force <path>`). Never remove any other worktree.
2. Create it outside the repo, detached: `git worktree add --detach "<temp dir>/figma-lens-review-<short sha>" <base>`.
3. Copy the untracked env files the app needs (`.env`, `.env.local`, … from the main checkout) into the same place in the worktree. Never print their contents.
4. Install dependencies the fast way (`npm install --prefer-offline --no-audit --no-fund`, or the project's package manager), get a free port with `figma-lens port`, and start the dev server in the background the way the project runs it (`auto.devServer` in `figma-lens.config.json`, or the usual dev command).
5. Both versions must see **the same backend and data** (same API URL, same account, same record ids). If the backend is part of this repo and changed too, run each version's backend, or say in the report that "before" used the current backend.

**After** is the user's checkout: start its dev server on another free port (or use the one already running).

**If "before" will not build or run** (missing dependencies, no backend at that commit), do not abandon the review: use the last score in `design/<frame>/compare/history.json` (the score when the screen was finished) as the before reference, and say so in the report.

## 4. Shoot and score every screen (both versions)

For each affected screen, with **`--design` always pointing at the main checkout's `design/<frame>`** (the worktree may not have `design/` at all):

```
figma-lens shot    --design design/<frame> --url http://localhost:<before port>/<route> --full --out design/<frame>/review/before.png
figma-lens compare --design design/<frame> --actual design/<frame>/review/before.png --out design/<frame>/review/before
figma-lens shot    --design design/<frame> --url http://localhost:<after port>/<route>  --full --out design/<frame>/review/after.png
figma-lens compare --design design/<frame> --actual design/<frame>/review/after.png  --out design/<frame>/review/after
```

Separate `review/before` and `review/after` folders keep the screen's own `compare/` history clean. Ignore the
STOP/CONTINUE line `compare` prints: that verdict is for the build loop, not for a review. Add `--wait <ms>` to
`shot` when data loads after the first paint, and use the same wait for both versions.

## 5. Judge the differences

Read `review/before/report.md` and `review/after/report.md` and **look at both `side-by-side.png` images**
(Figma | build | diff). Compare per screen:

- **Figma mismatch** before → after, and the change in points.
- **heightDelta** before → after (the page got taller or shorter).
- **Regions** in the after report: new ones, ones that moved, ones that got worse. Each lists the Figma layer ids; look them up in `design/<frame>/spec.md`.

Classify every difference. Real data never matches the design's placeholder content, so most text changes are fine:

| Expected (real data) | Regression (report it) |
|---|---|
| A TEXT layer region whose box did not move: different names, numbers, dates | `heightDelta` changed, or regions below a point all shifted (spacing, a new/removed element) |
| An IMAGE fill region: a real photo instead of the design's | A region that exists after but not before on a non-text layer (frame, card, icon, divider, button) |
| A list with a different number of items, if the item layout is unchanged | Colors, radii, borders, shadows, fonts that changed (text **suspects** about weight/size, not content) |
| | An element missing, duplicated, or overlapping another |

Look closely at any screen whose mismatch got worse by **1 point or more**, or that has any new non-text region.
A screen whose score improved can still have a regression: check its regions too.

**Real-data problems** in the after screenshots (and the code that renders them), Figma export or not:

- Text that overflows, is cut off, wraps badly or pushes the layout (long names, big numbers, other languages, RTL).
- Broken or missing images, wrong aspect ratio, no placeholder while loading.
- Raw values: unformatted numbers, currency, dates or times, `null`/`undefined`/`NaN`, ids instead of names.
- Placeholder content from the design still hard-coded (the export's sample text appearing as-is).
- Empty, loading and error states: one screenshot shows only one state, so read the code for how the others are handled. Report missing ones as **risks**, not as proven bugs.

## 6. Write the report and clean up

Write `design/REVIEW.md` (scratch output; it is not meant to be committed, and the `review/` folders are not either):

```markdown
# Screen review: <before ref> (<short sha>) → <after ref> (<short sha>)
Changed: <n> files. Screens reviewed: <n>. Backend/data used: <what>.

| Screen | Route | Figma before | Figma after | Δ | Verdict |
|---|---|---|---|---|---|
| Card Screen | /cards | 2.1% | 6.8% | +4.7 | regression |
| Profile | /me | 2.4% | 3.0% | +0.6 | ok (real data) |

## Card Screen: regression
- What changed, the layer ids (`1:23` "Price row"), the area, and why it is not just real data.
- Images: design/card-screen/review/after/side-by-side.png (compare with review/before/side-by-side.png).
- Likely cause: <file:line from the diff>.

## Real-data problems
## Risks (not proven)
## Not reviewed, and why
```

Then stop both dev servers and remove the worktree you created (`git worktree remove --force <its path>`),
**also when the review failed half way**. In your reply: the table, the regressions first, the real-data problems,
and an offer to fix them (one by one or all). Do not change any code unless the user asks.
