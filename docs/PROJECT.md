# Build the whole app from Figma: `figma-lens project`

One command builds every screen of the app with Claude Code, one after another, and remembers what is
done. The developer only **signs in** (first time) and **pastes the link** to the first screen.

```bash
cd my-app
figma-lens project "https://www.figma.com/design/<key>/<name>?node-id=12-34"
```

## What the developer does

1. Run the command above with the link to the **first screen** of the app (in Figma: right-click the
   frame → *Copy link to selection*).
2. **First time only:** a browser window opens on the Figma login page. Sign in (Google, email, SSO),
   check that your files show, then **close that window**. figma-lens continues by itself.
3. **Only if the screens are not linked in Figma's Prototype tab:** figma-lens asks one question (see
   [Which screens](#which-screens)). Type `1`, `2` or `3`.
4. Wait. Each screen is a full Claude Code run (often 10–60 minutes). It is safe to leave it running.
5. Review the branch and keep it ([Review and keep](#review-and-keep)).

Stopped, closed the terminal, or the computer went to sleep? **Run the same command again.** It knows
what is built and continues with the next screen.

## Set up once per project (the tech lead)

1. The project is a **git repository with at least one commit** (figma-lens builds on a separate branch
   made from it).
2. **`CLAUDE.md`** in the project says where things go (pages, components, icons, images, tokens,
   routes). Claude follows it for every screen. See `lens-showcase` for an example.
3. **`figma-lens.config.json`** in the project root:
   ```json
   {
     "auto": {
       "enabled": true,
       "devServer": "npm run dev -- --port {port} --strictPort",
       "url": "http://localhost:{port}/",
       "verify": "npm run verify",
       "instructions": "Follow CLAUDE.md exactly. Use figma-lens.map.json for components."
     },
     "browser": { "out": "design" }
   }
   ```
   `verify` is the command that must pass before a screen counts as done (type check, lint, build,
   architecture check…). Leave it out and only Claude's own run is the check.
4. **Claude Code** is installed and signed in on each developer's machine: run `claude` once.
5. Commit `figma-lens.config.json` and `CLAUDE.md`, so every developer gets the same setup. Don't
   commit `design/` (the exports): add it to `.gitignore`.

Don't set `timeoutMinutes`: the default (300) never stops a run that is still working. A frozen run is
stopped anyway after `idleMinutes` (20) without any activity. A 45-minute limit stops large screens
halfway (seen in practice), and figma-lens warns about it.

## What you see in the terminal

```
✔ browser window open
Following the prototype from 1 start screen(s)…
▶ [1] Login  FRAME 1:1 · 390×844 · page "Mobile"
✔ Login → design/login (212 layers, 9 files, 6.1s)
↪ following links to 3 more screen(s): "Home", "Search", "Filter sheet" (overlay)
…
App "Shop" → branch figma/app-shop (D:\my-app-figma\app-shop)
5 screen(s): 0 built, 5 to build.
Each screen is a full Claude Code run (often 10–60 min). Safe to leave running. Ctrl+C stops; run the same command again to continue.

[1/5] Login (screen 1 of 5 in the app)
▶ auto: implementing login on figma/app-shop
  …live progress: files read and written, check scores…
✔ Login built and committed 3f2a9c1d0 on figma/app-shop

[2/5] Home (screen 2 of 5 in the app)
…
✖ Search: `npm run verify` failed
  src/features/search/SearchPage.tsx(14,7): error TS2322 …
↻ Search: try 2 of 3, with the error
✔ Search built and committed 8b11e0a42 on figma/app-shop
…
App "Shop": 5 of 5 screens built on figma/app-shop.
  ✔ Login 3f2a9c1d0
  ✔ Home 51c0de977
  …
Review: cd "D:\my-app-figma\app-shop" then git log --oneline main..HEAD and run the app.
Keep:   in D:\my-app: git merge figma/app-shop
```

## Which screens

- **The prototype decides.** figma-lens exports the screen in your link, then every screen its
  prototype links lead to (navigate, swap, open overlay), and so on. That is the app. The order is the
  order a user meets them: the first screen first. There is no screen limit (`--flow`'s default of 30
  doesn't apply here); to set one anyway, use `--flow-max 40` or `flowMax` in the `browser` section.
- **A link without `?node-id=`:** the page's prototype start (Figma's *flow starting point*) is used.
- **No prototype links** (the designer didn't wire the screens): figma-lens says so and asks:
  ```
  "Login" has no prototype links to other screens,
  so figma-lens can't tell from Figma which screens belong to the app. Choose:
    1) build only this screen ("Login")
    2) build every screen on page "Mobile" (8), in canvas order: top to bottom, left to right
    3) stop (ask the designer to link the screens in Figma's Prototype tab, then run this again)
  Choose 1-3:
  ```
  For scripts (no terminal to ask in): `--if-no-links this`, `--if-no-links page` or `--if-no-links stop`.

## How it builds

- **One branch for the whole app:** `figma/app-<figma file name>`, in its own folder next to your
  project (`<project>-figma/app-<name>`, a git worktree). Your checkout, your branch and your
  uncommitted work are never touched.
- **Screen by screen.** Claude is told which screens are already built (so it reuses their components,
  icons and tokens instead of making copies), which come next, and where the prototype links go
  (`design/FLOWS.md`), so it wires the navigation.
- **Done = checked and committed.** Claude builds the screen and compares it with the Figma frame
  (`figma-lens check`, until it is within 3%). Then figma-lens runs `auto.verify`. When it passes,
  **figma-lens** commits the screen on the app branch: `figma: Login`. Claude itself can't commit, push,
  switch branches or delete files.
- **A screen fails** (Claude stops, or `verify` fails): figma-lens tries again with the error, up to
  `fixRetries` (2) more times. Still failing: the attempt is saved as a `.patch` file, the branch goes
  back to the last good screen, the screen is marked **needs review**, and the next screen is built.
- **Problems a retry can't fix** (Claude usage limit reached, Claude Code not signed in): figma-lens
  stops and says what to do. The work on that screen is kept; the next run continues it.

## What is done and what is next

Every commit figma-lens makes carries two lines at the end:
```
Figma-Node: nsXOoy1BB1e34Xgro725Sd#38:2
Figma-Spec: 4be1c09a7f3e
```
That is the memory. On the next run figma-lens exports the screens again and compares:

| Status | Meaning | What the next run does |
|---|---|---|
| ✔ built | Committed, the design is the same | Skips it |
| · to build | New screen (or not reached yet) | Builds it |
| ✖ needs review | Failed every try last time | Tries it again |
| ◐ changed in Figma | Committed, but the designer changed it since | Lists it (not rebuilt automatically) |

It still works after you merged the branch into `main`, also with a **squash merge** or a squashed
pull request (it reads every screen's lines from both, indented or not), and after the app branch was
deleted.

See it any time, without opening the browser:
```bash
figma-lens project --status        # prints design/PROJECT.md
```
`design/PROJECT.md` is rewritten after every step: every screen, its status, commit and notes, what is
next, and how to review.

## Review and keep

```bash
cd ../my-app-figma/app-shop          # the folder figma-lens printed
git log --oneline main..HEAD         # one commit per screen
npm run dev                          # look at the screens
```
Keep it: in your project, `git merge figma/app-shop` (or push the branch and open a pull request).
figma-lens never merges, never pushes and never touches `main`.

A screen marked *needs review*: read its note in `design/PROJECT.md`, fix the cause (or the screen
by hand in the worktree and commit it yourself), then run the command again.

## Settings (`auto` section)

| Setting | Default | Meaning |
|---|---|---|
| `verify` | `""` | Command that must pass before a screen is committed, e.g. `npm run verify`, `flutter analyze`. |
| `fixRetries` | `2` | Extra tries for a failing screen, with the error. |
| `instructions` | `""` | Extra instructions for every screen (or put them in `CLAUDE.md`). |
| `devServer`, `url` | | How Claude starts the app and where the screen is, for the visual check (`{port}` = a free port). |
| `timeoutMinutes` | `300` | Hard limit per screen. Leave the default. |
| `idleMinutes` | `20` | A run with no activity this long is frozen: stopped and retried. |
| `retries` | `2` | Retries for temporary problems (network, busy service). |
| `worktreeRoot` | next to the project | Where the app worktree goes. |
| `model` | | A Claude model for these runs. |

## Safety

- Works only in its own worktree on `figma/app-<name>`; your checkout is never changed.
- Never merges, never pushes, never touches `main`.
- Never throws work away: a failed attempt is saved as a patch, and changes it didn't make in the
  worktree stop the run instead of being reset.
- The figma-lens browser profile holds your Figma login; it is never in the project or in git.
