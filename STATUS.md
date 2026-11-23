# STATUS — ged-merge
_Updated 2026-11-23_

GED Merge, live at gedmerge.com (test site test.gedmerge.com). Rules: `CLAUDE.md`/`AGENTS.md` (details in `docs/agents/`). **Backlog and priorities: `IDEAS.md`** (not duplicated here).
Workflow: one worktree per task, every change a branch + PR; `main` merges only on green CI, every green `main` deploys the test site, production only on request.

**Last work (23. 10.–20. 11., PRs #43–#252)**
- Charts: 3D network (families as clusters, layout in a worker, blood / branch / all branches) #227; Timeline Lines layout and historical events by place #213 #214 #217; colour axes by country/region #96 #104; zoom by typed percentage #224
- Statistics (Tools): new tab with charts, brick walls, places & migration, surnames by decade, marriages between surnames, averages by quarter-century #77 #89 #212 #215 #216 #218
- Family website: export the tree as one HTML page with charts, photos, map and link previews #196–#211
- GEDCOM: target format per file (own / 5.5.1 / 7.0), health check with standard repairs and compliance tab, normalize on the open file #46 #53–#58; Gemini audit taken over and verified — all correctness items merged #180–#191
- Health check & Batch: detached branches (download, remove, in bulk), marriage/birth estimates, saved filters, two-column batch actions #163–#178 #185 #225
- Merge & duplicates: whole incoming file across, parents resolver, twins and sisters kept apart, previews of what a merge writes #75 #87 #107 #115 #180 #187
- Places & addresses: SI/HR address registers, house coordinates, place format with ADDR #127 #128 #142 #150 #155
- Photos: find faces and name them, resize regions #157 #159 #160
- Index & sources: search a person in the genealogical index / FamilySearch / Geni / WikiTree, index links recognized as sources, Google Books, Matricula repositories #148 #154 #219–#221
- Tools → DNA: FamilyTreeDNA surname CSV and earliest known ancestors #223
- Memory: parsed tree trimmed, no second copy of the incoming file #222; CI: e2e in the Playwright image, chromium in three shards #226
- Tutorial videos: scripted YouTube episodes 1–17, Slovenian and English voice-over #123–#234
- Code review of 20. 11. (whole codebase, findings re-checked in code), plan PRs 1–9 merged:
  losing work (failed re-load, UTF-16 cache, Back under a dialog, two tabs) #237; records left inconsistent #238; living people's ages and bounded birth dates #241; crashes and minute-long stalls on large files #242; what a confirmed merge writes #244; matching, measured on Renko/Trobec/Pratnekar/Hawlina #247; CSV/workbook imports and coordinates #249; small UI fixes #250; version conversion and strict writers #251; new extension tags `_CROP`, `_RIN`/`_AFN`/`_RFN` #252
- From that review also: Health check lists unused NOTE/OBJE/SOUR records #239; an incoming address is split onto a place the main already has #245; a sibling added from the siblings row #235; Complete Tree #240

**In flight**
- **Research notes, PR #299** (waiting for the user's validation and merge approval): `_RESEARCH` records for ideas, questions, tasks and finds, filed under a person, family or event, or under nobody; edited in Edit, listed in Tools → Notebook, a note for later from the header (`B`). **Its terms page for `_RESEARCH` must reach production before files declaring the tag are written there.** Not done: attaching media by drag-and-drop or paste (media come from the media folder picker only); a research-note filter of its own in the person search (the note filter reads them).
- Nothing open. Production was last deployed on 20. 11. at #248 (tag `2026-11-20.2`); #249–#252 are on the test site only. **#252 adds terms pages for new extension tags: production must be deployed before strict files declaring `_CROP`/`_RIN`/`_AFN`/`_RFN` go out** — on request, as always.

**Now (top of IDEAS.md priority queue)**
1. Living-persons privacy as one global setting (also in matching)
2. Merge mode: media/photo field (`review/fields.ts` has no media rows)

**Still open (verify in code before acting)**
- Review of 20. 11., not done yet:
  - main-thread work on large files: Batch rows, Statistics facts, the coordinate scan and Validate's counts (4–6 s each at 200k people) belong in the tools worker — first `foldSearch` and friends out of `src/ui/globalSearch.ts`, which pulls React into `src/tools` and `src/stats`; charts have no size guard, and the kinship wheel's dot placement alone takes 5 s for 20k relatives; every relative picker builds and sorts the whole person list; the whole edit state is re-written to the cache on each pause; a worker patch is still a full rebuild (~7 s on 500k)
  - site and pipeline: gedmerge.com sends no CSP/HSTS/frame protection (part of it is hosting configuration outside the repo); the deploy workflow builds and deploys in one job with write permissions; the offline precache omits wasm, the face model, jpg and the sample trees; a 2.9 MB site-viewer chunk is precached for everyone; 11 dev-only `npm audit` advisories have a non-breaking fix
  - smaller: two incoming records confirmed to one main use stale rows in the merge engine (not checked whether the UI allows it); removing an event leaves its shared note/photo/source unreferenced (the Health check now lists them); nested family pointers held by people outside a removed family are not cleaned; a neutral kinship word for unknown sex on the wheel; `INIL` has no 5.5.1 form; a locale key that nothing uses is not caught by a test (52 were removed by hand on 20. 11.; over a thousand keys are built at run time, so a check needs a list of those patterns)
- Tried in that review, measured and dropped — do not retry without new evidence: slack on `ABT` dates in the matcher's lifespan gate (a false strong match), a cap on date similarity across years (lost strong pairs), the index search asking again when the person is edited (it closed the comparison in use)
- 3D network: the person panel covers the zoom buttons; a large "All branches" layout still takes ~20 s for 55k people (multi-threading would need COOP/COEP headers)
- Bug: "One sheet" print is cropped on Android (see IDEAS.md)

**Held back on purpose**
- TypeScript 7 — waits for typescript-eslint support
- `@vitejs/plugin-react` 6.1.2 — Babel 8 optional peer clashes with Workbox's Babel 7

**Outreach (not code)**
- [ ] Raise awareness in genealogy communities (SLO/HR/global): landing page, OG image, posts
- [ ] rodoslovni-viri record `gedmerge.md` exists — keep it current

**Decided**
- Research notes are written by Save only: every export leaves them out and an incoming file's are never merged; the tag is `_RESEARCH`, not `_TODO` (that one is Brother's Keeper's / Family Historian's)
- Free, runs entirely in the browser, no backend, MIT
- Nothing reaches `main` except through a PR with green CI; local `main` only fast-forwards
- Production deploys only when the user asks (`gh workflow run deploy-production.yml`)
- Duplicate-finder blocking by crowded decade dropped (measured on 493k: lost pairs, no faster)
- Bug-fix PRs merge without changelog or guide entries; features get both, in both languages
