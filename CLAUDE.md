# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## MANDATORY FIRST STEP: work in a worktree, never on main

Multiple chat sessions run against this repo in parallel. **Never edit files in the main checkout** (`/Users/lukarenko/rodoslovje/ged-merge`, branch `main`) — parallel sessions doing that corrupt each other's work.

Before your **first** file change of the session (not before the first commit — before the first *edit*):

1. Check where you are: `git rev-parse --git-dir --git-common-dir`. If the two paths are **equal**, you are in the main checkout and must not edit anything yet.
2. Create and switch to a session worktree with the **EnterWorktree** tool (preferred), or `git worktree add ../ged-merge-<topic> -b <topic>`.
3. Do all work and commits on the worktree branch.
4. **When the feature is implemented** (basic tests green, committed): start the dev server in the worktree (`npm run dev`; run `npm install` first if the worktree has no `node_modules`) and hand the URL to the user for live validation. Leave it running while the user tests.
5. **When the user confirms the merge**: stop the dev server, merge the branch to `main`, run the full regression suite **on main** (see below), then clean up — `git worktree remove <path>` and `git branch -d <branch>` (or ExitWorktree). Merge to `main` **only after the user explicitly approves** — never on your own.

Enforcement: a PreToolUse hook (`.claude/hooks/require-worktree.sh`, wired in `.claude/settings.json`) **blocks** Edit/Write in the main checkout. If your edit is denied with a "main checkout" message, do not retry or work around it — create a worktree and redo the change there. The only exception is a user-approved direct fix on `main` (e.g. urgent CI repair): ask the user to confirm, `touch .claude/allow-main-edits`, and delete that file when done.

## Commands

```bash
npm run dev          # start Vite dev server
npm run build        # typecheck + production build (dist/)
npm run typecheck    # tsc -b --noEmit  ← use this, not plain tsc --noEmit -p .
npm run lint         # ESLint with --max-warnings 0
npm run test         # vitest unit tests (run once)
npm run test:watch   # vitest watch mode
npm run test:e2e     # Playwright end-to-end tests
```

To run a single test file: `npx vitest run src/gedcom/date.test.ts`

## Development workflow

- **Minimal change.** Implement a feature with the smallest change that does the job. If you spot a broader improvement (refactor, better abstraction, adjacent cleanup), suggest it to the user instead of doing it unasked.
- **Reuse before writing.** When making changes, actively look for opportunities to reuse existing code and deduplicate — prefer extending an existing helper/component over adding a parallel one.
- **One workspace per chat.** Each chat session works in its own git worktree — see the mandatory first-step section at the top of this file. Never edit in the main checkout.
- **Test and commit per feature/phase.** Every feature or development phase is run through basic tests (`npm run typecheck`, `npm run lint`, relevant `vitest` files) and committed before moving on.
- **Dev server for user validation.** After a feature is implemented and committed, start `npm run dev` in the worktree and give the user the URL so they can validate it live before deciding on the merge.
- **Update the changelog on merge.** Before merging to main, add a dated entry (today's date, newest entry at the top) to **both** `changelog/index.html` (English) and `posodobitve/index.html` (Slovenian) — same content in each. Log **only new functionality or major improvements** — skip bug fixes, minor tweaks, internal refactors/cleanup, and doc-only updates entirely. A fix does not become loggable by being folded into a feature bullet: the reader does not care what was broken. **Hard budget: 2 sentences and 40 words per bullet**, counted — the `2026-07-22` entry is the model; a bullet that reads as a paragraph is over budget and must be cut, not trimmed. **Lead with what is new**, never with the old behaviour: it earns at most one short clause, and only when the new thing makes no sense without it. No internal mechanics and no step-by-step instructions — that is the User's Guide's job. **Order the bullets under one date by area, biggest first**: bullets about the same area of the app (maps, geocoding, sources, charts, …) sit next to each other, the areas run from the one with the most substantial news down, and within an area the larger feature comes before the smaller refinement. Grouping means adjacency only — no sub-headings. When a merge adds bullets to a date that already has some, re-sort the whole entry rather than appending. Commit it in the worktree branch so it merges along with the feature. **The changelog also feeds the landing screen**: the landing page's "What's new" panel reads the newest bullets from these pages at runtime and shows each bullet's `<strong>` lead-in as a headline. So every bullet must start with a `<strong>` lead-in sentence (in both languages) that stands alone as a short headline, the entry must keep the `.changelog-entry` → `h2` + `ul > li` structure, and after editing the changelog check the landing panel shows sensible titles.
- **Update the User's Guide on merge.** When a merge adds or changes a user-facing workflow, feature or icon, also update the matching section in **both** `guide/index.html` (English) and `navodila/index.html` (Slovenian) — write English first, then mirror it in Slovenian — keeping section numbers, `id` anchors and `§` cross-references consistent across the two. Prefer folding new material into an existing numbered section over renumbering. If the change genuinely needs no guide edit (pure internal work), that's fine — but decide it explicitly, don't skip by default. Commit the guide changes in the worktree branch so they merge with the feature.
- **Keep translations in parity.** Every user-facing string change ships in both languages in the same merge: UI strings in `src/locales/en.ts` **and** `src/locales/sl.ts`, plus the paired English/Slovenian changelog and guide pages above. When writing Slovenian guide or changelog copy, reuse the app's existing Slovenian UI terms (grep `src/locales/sl.ts`) so the docs and the interface agree.
- **Merge to main = stop server + merge + full regression + cleanup.** When the user confirms the merge: stop the dev server, merge to main, run the complete regression suite on main (`npm run build`, `npm run lint`, `npm run test`, `npm run test:e2e`), then remove the worktree and delete its branch.
- **Never kill processes by port — you will kill the user's browser.** `lsof -ti tcp:5173 | xargs kill` (likewise `fuser -k`, `kill $(lsof -t -i:PORT)`) lists *every* process holding a socket on that port, and that includes the browser tab connected to the dev server. This has killed the user's Firefox more than once. Stop the dev server by the process you started: launch it with a known PID (`npm run dev & echo $!`, or a background Bash call) and kill that PID, or at most `pkill -f "vite.*<this worktree path>"`. Never kill a process you did not start.
- **Keep CI green after merge.** After merging, the automatic CI test runs must be back in a working state — fix any breakage on main immediately rather than leaving it for later.
- **Ask when unsure.** If you need help understanding a requirement or existing behavior, ask the user rather than guessing.

## Architecture

**Browser-only React + TypeScript + Vite app.** No backend; all data stays local.

### Data model (two layers)

`src/gedcom/types.ts` defines both:
- **`GedNode`** — lossless raw line tree (level/tag/value/children). Everything serializes from this; no information is lost.
- **Typed domain model** (`Individual`, `Family`, `Dataset`) — a projection built on top for matching and UI. Each domain object keeps a `.raw` back-reference to its `GedNode`.

### Web Worker

All heavy work runs off the main thread in `src/worker/gedcom.worker.ts`. The worker owns the parse → normalize → match pipeline and communicates via typed messages (`src/worker/messages.ts`):

- `parse` → emits `parsed` (with `Dataset`) and then `matching`/`matched`
- `parseCsv` → loads genealogical-index matches CSV (indeks.rodoslovje.si) into the compare slot
- `setHome` → re-ranks the last match result by kinship distance; emits `matching`/`matched`

The worker keeps its own copies of `mainDataset`, `compareNormalized`, and `lastResult` so any side can be (re)loaded in any order and the results stay consistent.

### Normalization

When the compare file loads, `src/normalize/` reshapes it to match the main file's "house style" — date format (e.g. `DD.MM.YYYY` vs `JAN 1900`), place layout (`structured-addr` / `packed-plac` / …), and link languages (Matricula, Geneanet). The `NormalizationReport` summarizes what changed. Downstream matching compares like-for-like.

### Matching

`src/match/engine.ts` scores each main/compare individual pair 0–100 over weighted field components (surname, given name, birth date/place, parents, partners, children, marriage). Hard gates on surname/given/year-gap prune implausible pairs before scoring. `src/match/distance.ts` re-ranks results by kinship hops from the home person. The full algorithm — pipeline stages, penalties, calibrated thresholds, and how to verify changes — is documented in [MATCHING.md](MATCHING.md).

### App state (App.tsx)

Both **Edit** and **Merge** mode views stay mounted simultaneously and are toggled with CSS `display`, not conditional rendering — avoids remounting large unvirtualized lists on mode switches.

Key state:
- `main` / `compare` — `SlotState` (empty → loading → loaded | error)
- `lastMainFile` — the last successfully loaded main file, preserved while a reload is in progress so the views don't flash back to the landing page
- `decisions` — `Map<string, CandidateDecision>` keyed by `decisionKey("individual", mainId, compareId)`
- **Unified undo/redo** stack covers both edit patches (`RecordPatch[]`) and merge decisions in one history

### Save flow

`handleSave` → `mergeDecisions` (merge) or `buildEditReport` (edit) → `SaveDialog` preview → `handleConfirmSave` → downloads `{base}.gedmerge.ged` + `{base}.gedmerge.report.txt`. After confirming, the live `mainDataset` is rebuilt in-place from the saved records so the app reflects the new baseline without a reload.

### Styling

Plain global CSS (no CSS Modules / CSS-in-JS). Files load in a deliberate order — keep it:

`theme/fonts.css` → `theme/heritage-pine.css` → `index.css` → `theme/components.css` (overrides win last). `src/guide.css` is the standalone guide page.

- **`theme/heritage-pine.css` is the single source of design tokens** (`--bg`, `--panel`, `--accent`, `--danger`, `--status-*`, `--sex-*`, `--state-*`, `--node-*`, `--radius*`, …). `index.css` is layout/components; `components.css` is targeted overrides that must win the cascade.
- **Use a token, don't hardcode.** No raw hex/`rgb()` for anything that maps to an existing token. Colors → the `--*` color tokens; corner radii → the `--radius-sm` / `--radius` / `--radius-lg` / `--radius-pill` scale; destructive UI → `--danger` (+ `--danger-soft` for tinted fills); male/female → `--sex-male` / `--sex-female`; field accents (new / changed / link / importable) → `--status-*`.
- **New semantic color ⇒ new token, defined in *both* themes.** Add it to the dark `:root` *and* the `[data-theme="light"]` block. A color used in only one place can stay literal, but anything reused or theme-sensitive becomes a token. Don't use `var(--x, #fallback)` to paper over a missing definition — define `--x` instead (a dangling token with a fallback hides the gap and drifts).
- **Don't tokenize a foreground color that sits on a hardcoded colored background** (e.g. the status chips `background:#14492f; color:#…`) unless you token-ize the background too — otherwise light theme breaks. Convert the pair together or leave both literal.
- **Avoid `!important`** — fix specificity instead (e.g. match the descendant-selector weight and rely on source order). The few existing uses are for genuine cases (drag cursor, responsive grid resets).
- **Breakpoints (max-width): `1100` / `880` / `720` / `560`** — reuse these, don't invent new ones. Most overrides are grouped in the responsive section at the bottom of `index.css`; some live next to their component.

Sanity check after CSS edits: every referenced var must resolve to a definition, and `npm run build` must pass (it compiles the CSS).

### Module map

| Path | Responsibility |
|------|----------------|
| `src/gedcom/` | Parser, builder, types, serialize, edit (rebuild/remove), date, place, name, citation, lifespan |
| `src/normalize/` | Reshape compare to main's date/place/link conventions |
| `src/match/` | Scoring engine, similarity functions, kinship distance ranking |
| `src/merge/` | Apply decisions → produce merged `GedNode[]` + change report |
| `src/review/` | Field-comparison rows (`FieldRow`), diff counts for the results table |
| `src/chart/` | Pure chart data + geometry: person tree builder (`personTree`), layered/fan/relationship layouts, timeline rows, per-node display rules (`nodeDisplay`) — no React |
| `src/report/` | Pure text-report builders: Ahnentafel + NGSQ descendant register (`model`, `text`) |
| `src/csv/` | Genealogical index CSV import |
| `src/tools/` | Whole-file maintenance tools (Tools tab): validation/health check, within-file duplicate finder, bulk normalize — pure functions run on the main thread |
| `src/ui/` | React components |
| `src/locales/` | i18n strings (English `en`, Slovenian `sl`) via i18next |
| `src/worker/` | Web Worker entry point + message types |
