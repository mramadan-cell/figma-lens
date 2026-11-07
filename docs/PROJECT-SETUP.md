# Set up your project before the first export

> **figma-lens builds inside *your* architecture only if you write it down.**
> Claude Code reads your project the way a new teammate would. If the rules aren't written anywhere,
> it guesses: new folders with its own names, a second `Button`, raw colors instead of your tokens,
> icons dropped wherever. Ten minutes of setup prevents that, for every export, interactive or auto mode.

You need four things. The first one matters most.

| # | What | File | Read by |
|---|---|---|---|
| 1 | **Your architecture and guidelines** | `CLAUDE.md` (project root) | every Claude Code session, including auto runs |
| 2 | **Your components and tokens** | `figma-lens.map.json` | spec.md (`⇒ USE …`), so Claude reuses instead of rebuilding |
| 3 | **A check that proves the rules** | an npm/flutter script (lint, arch check, tests) | Claude runs it before saying "done" |
| 4 | **Auto mode settings** (optional) | `figma-lens.config.json` | `figma-lens bridge --auto` |

---

## 1. `CLAUDE.md`: tell it where everything goes

Put it in the project root. Write it for someone who has never seen the project. Be concrete: real paths, real names.
**A table of "what → where → rule" works best**, because every file Claude creates has to land in exactly one row.

Cover these, at minimum:

- **Pages / screens:** folder, file naming, where routes are registered.
- **Components:** where reusable ones live vs. one-screen ones, one folder per component or not, how they're exported.
- **Icons:** folder, naming (kebab-case? `ic_` prefix?), how they're rendered (an `Icon` component, `SvgPicture.asset`, a sprite…).
- **Images:** folder (per feature?), naming, how they're imported or registered (e.g. `pubspec.yaml` assets).
- **Design tokens:** where colors, spacing, radii, fonts and shadows live, and the rule "no raw values outside this file".
- **Fonts:** where they're added.
- **State, data and text:** where content and state go (e.g. `data.ts`, a Cubit, l10n files).
- **Boundaries:** what may import what (features never import each other, etc.).
- **Don'ts:** e.g. "don't change an existing component's look for one screen, add a variant", "no new dependencies without a reason".
- **Definition of done:** the exact commands that must pass.

### Template: web (React / Vue / Next…)

```markdown
# <Project>: architecture rules

<Stack in one line, e.g. React 18 + TypeScript + Vite + react-router, CSS Modules. `@/` = `src/`.>

## Where everything goes
| What | Where | Rule |
|---|---|---|
| Page | `src/features/<feature>/pages/<Name>Page.tsx` | Routed in `src/app/router.tsx`, path = feature name |
| Feature-only component | `src/features/<feature>/components/` | Used by one feature |
| Reusable component | `src/components/ui/<Name>/` | Exported from `src/components/ui/index.ts` |
| Icons | `src/assets/icons/<kebab-name>.svg` | Render with `<Icon name="…" />`, never inline SVG |
| Images | `src/assets/images/<feature>/<kebab-name>.jpg` | Rename hash names from the export |
| Colors, spacing, radii, fonts | `src/theme/tokens.css` | `var(--…)` everywhere else; new value → new token named by meaning |

## Boundaries
- Features never import other features; shared parts move to `src/components/`.

## Done means
`npm run lint && npm run build` pass, and `figma-lens check` is ≤ 3%.
```

### Template: Flutter

```markdown
# <App>: architecture rules

Flutter 3.x, <state management, e.g. flutter_bloc>, go_router. Clean architecture per feature.

## Where everything goes
| What | Where | Rule |
|---|---|---|
| Screen | `lib/features/<feature>/presentation/pages/<name>_page.dart` | Route added in `lib/core/router/app_router.dart` |
| Feature widget | `lib/features/<feature>/presentation/widgets/` | Used by one feature |
| Reusable widget | `lib/core/widgets/` | Prefix `App` (`AppButton`) |
| Icons | `assets/icons/<snake_name>.svg` | Registered in `pubspec.yaml`, shown with `SvgPicture.asset` via `AppIcons` |
| Images | `assets/images/<feature>/` | Registered in `pubspec.yaml` |
| Colors / text styles / spacing | `lib/core/theme/app_colors.dart`, `app_text_styles.dart`, `app_spacing.dart` | No `Color(0x…)` outside theme |
| Strings | `lib/l10n/app_en.arb` (+ `app_ar.arb`) | No hard-coded UI text |

## Done means
`flutter analyze` is clean, `flutter test` passes, and `figma-lens check` is ≤ 3%.
```

---

## 2. `figma-lens.map.json`: reuse, don't rebuild

```bash
figma-lens map --design design      # adds every component and token seen in your exports, with empty values
```

Fill each entry with your real code (`path#Symbol`, plus prop mapping). Use wildcards for families:

```json
{
  "components": {
    "Button": { "web": "src/components/ui/Button/Button.tsx#Button", "props": { "Variant": "variant", "Label": "children" } },
    "Icon/*": "<Icon name=\"<name>\" /> (file: src/assets/icons/<name>.svg)"
  },
  "tokens": { "color/primary": { "web": "var(--color-primary)" } }
}
```

Then spec.md shows `component Button {Variant=Primary} ⇒ USE …` on every instance, and lists what is **not mapped yet**.
Tip: in Figma, name components the way your code does (`Button`, `Card`, `Icon/arrow-right`), so the mapping is obvious.

---

## 3. A check that proves the rules

Written rules are followed most of the time. A check makes it every time: Claude runs it, sees what's wrong, and fixes it.

- Web: `npm run lint`, `tsc`, a small script that checks folders/naming (e.g. "every `.svg` is in `src/assets/icons/`", "no hex colors outside `src/theme/`", "every page is routed").
- Flutter: `flutter analyze` with custom lint rules, `flutter test`, a script that checks `pubspec.yaml` assets.

Name the command in `CLAUDE.md` under **Done means**, and in `instructions` (below) for auto mode.

---

## 4. `figma-lens.config.json`: auto mode

```bash
figma-lens auto --init
```

```json
{
  "auto": {
    "enabled": true,
    "devServer": "npm run dev -- --port {port} --strictPort",
    "url": "http://localhost:{port}/<feature-route>",
    "instructions": "Follow CLAUDE.md exactly. Use figma-lens.map.json for components. `npm run verify` must pass before you finish; list every added file grouped by folder in the report.",
    "timeoutMinutes": 300,
    "idleMinutes": 20,
    "retries": 2
  }
}
```

Auto mode works on a **git worktree made from your last commit**, so **commit `CLAUDE.md`, the map and your check script first**,
or the run won't see them.

---

## Checklist before the first export

- [ ] `CLAUDE.md` exists in the project root, with a "what → where → rule" table covering pages, components, icons, images and tokens
- [ ] It names the **Done means** commands
- [ ] `figma-lens.map.json` maps your existing components and tokens (no important `""` left)
- [ ] The check command passes on the project as it is now
- [ ] (Auto mode) `figma-lens.config.json` has `devServer`, `url` and `instructions`
- [ ] (Auto mode) all of the above is **committed**
- [ ] Figma components are named like your code components

## After each export

Review before you merge: the report (`design/<frame>/auto/report.md` in auto mode) lists every file and every guess.
If Claude put something in the wrong place, **add that rule to `CLAUDE.md`** (or to the check) instead of only fixing the file:
the next export will get it right.
