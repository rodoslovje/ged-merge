# AGENTS.md

This file provides guidance to coding agents (Claude Code, Codex, …) when working with code in this repository. It holds the rules most tasks need; the rest lives in the files listed under **Further rules** at the end — read the one that matches your task before you start it.

## MANDATORY FIRST STEP: work in a worktree, never on main

Multiple chat sessions, on more than one machine, run against this repo in parallel. **Never edit files in the main checkout** (the primary clone, on branch `main`) — parallel sessions doing that corrupt each other's work. Everything reaches `main` through a GitHub pull request: a ruleset on `main` refuses direct pushes and merges a PR only when CI is green.

Before your **first** file change of the session (not before the first commit — before the first *edit*):

1. Check where you are: `git rev-parse --git-dir --git-common-dir`. If the two paths are **equal**, you are in the main checkout and must not edit anything yet.
2. Create and switch to a session worktree with the **EnterWorktree** tool (preferred; it branches from `origin/main`), or `git fetch origin && git worktree add ../ged-merge-<topic> -b <topic> origin/main`. Always start from `origin/main`, never from the local `main`, which may be behind.
3. Do all work and commits on the worktree branch.
4. **When the feature is implemented** (basic tests green, committed): start the dev server in the worktree (`npm run dev`; run `npm install` first if the worktree has no `node_modules`) and hand the URL to the user for live validation. Leave it running while the user tests. Also push the branch and open a PR (`git push -u origin HEAD`, `gh pr create --base main --fill`), so CI runs while the user tests; push later fixes to the same branch.
5. **When the user confirms the merge**: stop the dev server and run `gh pr merge --merge --auto` — GitHub merges the PR with a merge commit once CI (lint, typecheck, unit tests, e2e) is green. If the PR conflicts with `main`, merge `origin/main` into the branch, fix it there and push. If CI fails, fix on the branch and push. After the merge lands (`gh pr checks --watch`, then `gh pr view --json state`), clean up — `git worktree remove <path>` and `git branch -D <branch>` (or ExitWorktree); GitHub deletes the remote branch itself. Then bring the main checkout up to date with `git -C <main checkout> pull --ff-only`. Merge **only after the user explicitly approves** — never on your own.

**Local `main` only ever fast-forwards from GitHub.** Never `git merge` a branch into the local `main`, never commit on it, never push it: work merged locally cannot be pushed past the ruleset and piles up unpublished (one machine once collected 57 such commits that needed a catch-up PR). If `git pull --ff-only` refuses because local `main` has commits of its own, stop and tell the user instead of resolving it yourself.

Enforcement: a PreToolUse hook (`.claude/hooks/require-worktree.sh`, wired in `.claude/settings.json`) **blocks** Edit/Write in the main checkout. If your edit is denied with a "main checkout" message, do not retry or work around it — create a worktree and redo the change there. There is no direct path to `main` any more: even an urgent CI repair is a branch and a PR. (`.claude/allow-main-edits` still unlocks the hook, but only for local work the user explicitly asks for in the main checkout — it cannot be pushed.)

## Commands

```bash
npm run dev          # start Vite dev server
npm run build        # typecheck + production build (dist/)
npm run typecheck    # tsc -b --noEmit  ← use this, not plain tsc --noEmit -p .
npm run lint         # ESLint with --max-warnings 0
npm run test         # vitest unit tests (run once)
npm run test:watch   # vitest watch mode
npm run test:coverage # unit tests with the coverage floors CI enforces
npm run test:e2e     # Playwright end-to-end tests (chromium: all; webkit: @smoke only)
npm run test:e2e:pwa # build + service-worker specs (offline, update prompt) on vite preview
```

To run a single test file: `npx vitest run src/gedcom/date.test.ts`

Node: CI runs the version in `.nvmrc` (24 LTS); newer local versions work too.

## Development workflow

- **Minimal change.** Implement a feature with the smallest change that does the job. If you spot a broader improvement (refactor, better abstraction, adjacent cleanup), suggest it to the user instead of doing it unasked.
- **Reuse before writing.** When making changes, actively look for opportunities to reuse existing code and deduplicate — prefer extending an existing helper/component over adding a parallel one.
- **Test and commit per feature/phase.** Every feature or development phase is run through basic tests (`npm run typecheck`, `npm run lint`, relevant `vitest` files) and committed before moving on.
- **Dev server for user validation.** After a feature is implemented and committed, start `npm run dev` in the worktree, push the branch and open its PR, and give the user both the dev-server URL and the PR link so they can validate it live while CI runs.
- **Never kill processes by port — you will kill the user's browser.** `lsof -ti tcp:5173 | xargs kill` (likewise `fuser -k`, `kill $(lsof -t -i:PORT)`) lists *every* process holding a socket on that port, and that includes the browser tab connected to the dev server. This has killed the user's Firefox more than once. Stop the dev server by the process you started: launch it with a known PID (`npm run dev & echo $!`, or a background Bash call) and kill that PID, or at most `pkill -f "vite.*<this worktree path>"`. Never kill a process you did not start.
- **Keep CI green.** A PR merges only when its checks pass, but main's own CI run can still break (two PRs that pass alone fail together) — fix that immediately, on a new branch through a PR.
- **Merge-time docs and deploys.** Before a merge, update the changelog and the User's Guide in both languages, following [docs/agents/merging.md](docs/agents/merging.md). Production is deployed only when the user asks — never on your own.
- **Keep translations in parity.** Every user-facing string change ships in both languages in the same merge: UI strings in `src/locales/en.ts` **and** `src/locales/sl.ts`, plus the paired English/Slovenian changelog and guide pages. Before writing any Slovenian, read [docs/agents/slovenian-copy.md](docs/agents/slovenian-copy.md). At the end of a feature, list every new `sl.ts` string and Slovenian doc sentence for the user.
- **Undo is explained once, never per action.** New UI strings and doc sentences never add "you can undo it", "(undoable)" or the like — the guide's §2 (`#undo`) covers it. Exceptions and wording: [docs/agents/merging.md](docs/agents/merging.md).
- **E2E tests wait for conditions, never for durations.** No `page.waitForTimeout`; assert through a retrying `expect` (`toBeVisible`, `toHaveCount(n)`), never on a value read once; bound repeat-until loops with `expect(async () => {…}).toPass({ timeout })`. `playwright.config.ts` carries the budgets, so a new spec needs no timeout of its own unless it is genuinely heavier.
- **Ask when unsure.** If you need help understanding a requirement or existing behavior, ask the user rather than guessing.

## GEDCOM output

GED Merge reads anything; what it writes follows the main file's **target format** — Master file (keep the file's own dialect), strict GEDCOM 5.5.1, or strict 7.0 — stored per main file. Any code that creates, rewrites, offers, checks or normalizes GEDCOM lines must follow [docs/agents/gedcom-standard.md](docs/agents/gedcom-standard.md); read it first. The rules most changes touch:

- **The target is a parameter.** Writers receive mode + version + dialect explicitly; never re-read HEAD in a helper. Inside normalize/merge the target is always the **main** file's.
- **Every download goes through one path:** `prepareDownload` in `src/save/outputFile.ts`, then `serializeGedcom` with `outputOptions`.
- **Extensions:** in a strict mode an extension tag starts with `_`; a bare vendor tag is never written.
- **One source of truth:** `src/tools/conformance/spec70.ts` / `spec551.ts` decide what is standard. Never add another hard-coded tag or enum list.
- **Mark non-standard tags** through `eventDisplayLabel` / `eventGlyph` in `gedcom/eventTags.ts`.
- **Test like the standard:** a new writer, fix or conversion gets a unit test that runs its output through `validateConformance` in strict 5.5.1 and 7.0.
- **500k-person files:** no `records.find(...)` inside a loop — build an xref index once.

## Architecture

**Browser-only React + TypeScript + Vite app.** No backend; all data stays local. `GedNode` (`src/gedcom/types.ts`) is the lossless raw line tree everything serializes from; `Individual` / `Family` / `Dataset` are a typed projection with a `.raw` back-reference. Heavy work runs in `src/worker/gedcom.worker.ts`. Edit and Merge views stay mounted and are toggled with CSS `display`.

**Styling:** plain global CSS. Use the tokens in `src/theme/heritage-pine.css`, never a raw hex or radius; a new token is defined in both themes; avoid `!important`; breakpoints are `1100` / `880` / `720` / `560`.

Worker messages, normalization, matching, app state, the save flow and the full styling rules: [docs/agents/architecture.md](docs/agents/architecture.md).

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
| `src/csv/` | Incoming-table imports: genealogical-index matches (`giMatches`) and the Slovenian parish-register index (`parishIndex`), from CSV or an `.xlsx`/`.xlsm` workbook (`xlsx`), on a shared record registry (`people`) |
| `src/tools/` | Whole-file maintenance tools (Tools tab): validation/health check, within-file duplicate finder, bulk normalize — pure functions; the heavy scans run in `tools.worker`, the geocode scans on the main thread behind a paint |
| `src/ui/` | React components |
| `src/locales/` | i18n strings (English `en`, Slovenian `sl`) via i18next |
| `src/worker/` | Web Worker entry point + message types |

## Further rules

| File | Read it when |
|------|--------------|
| [docs/agents/slovenian-copy.md](docs/agents/slovenian-copy.md) | writing any Slovenian (`sl.ts`, `navodila/`, `posodobitve/`) |
| [docs/agents/gedcom-standard.md](docs/agents/gedcom-standard.md) | code creates, rewrites, offers, checks or normalizes GEDCOM lines |
| [docs/agents/merging.md](docs/agents/merging.md) | the user approves a merge: changelog, User's Guide, undo wording, production deploy |
| [docs/agents/architecture.md](docs/agents/architecture.md) | touching the worker, normalization, matching, app state, save flow or CSS |
| [MATCHING.md](MATCHING.md) | changing match scoring |
