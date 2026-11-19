# STATUS — ged-merge
_Updated 2026-11-19_

GED Merge, live at gedmerge.com (test site test.gedmerge.com). Rules: `CLAUDE.md`/`AGENTS.md` (details in `docs/agents/`). **Backlog and priorities: `IDEAS.md`** (not duplicated here).
Workflow: one worktree per session, every change a branch + PR; `main` merges only on green CI, every green `main` deploys the test site, production only on request.

**Last work (23. 10.–19. 11., PRs #43–#227)**
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
- Tutorial videos: scripted YouTube episodes 1–16, Slovenian voice-over #123–#183

**In flight**
- Nothing open. Production was last deployed on 18. 11. at #224; #225–#227 (bulk detached branches, CI, 3D network) are on the test site only — deploy on request.

**Now (top of IDEAS.md priority queue)**
1. Living-persons privacy as one global setting (also in matching)
2. Merge mode: media/photo field (`review/fields.ts` has no media rows)

**Still open (verify in code before acting)**
- Audit leftovers (2026-11-15): migrate enums/PHRASE/TIME and structure, CSV/parish 7.0, edit writers/media, stricter validator (split spec551 IEVEN), repair-not-delete, thread `isV7`; strict EVEN→`_MSTAT` skip, 7.0 SLGC FAMC `@VOID@` lost on downgrade, `setFsIds` ignores strict tag, `importAncestors`/`hasIncomingAncestors` use `childOf[0]`
- From the 2026-10-22 review: merge review panel ignores `fieldAnchors`; worker patch is a full rebuild (~7 s on 500k); bulk normalize not idempotent on a second run
- 3D network: the person panel covers the zoom buttons; a large "All branches" layout still takes ~20 s for 55k people (multi-threading would need COOP/COEP headers)
- Bug: "One sheet" print is cropped on Android (see IDEAS.md)

**Held back on purpose**
- TypeScript 7 — waits for typescript-eslint support
- `@vitejs/plugin-react` 6.1.2 — Babel 8 optional peer clashes with Workbox's Babel 7

**Outreach (not code)**
- [ ] Raise awareness in genealogy communities (SLO/HR/global): landing page, OG image, posts
- [ ] rodoslovni-viri record `gedmerge.md` exists — keep it current

**Decided**
- Free, runs entirely in the browser, no backend, MIT
- Nothing reaches `main` except through a PR with green CI; local `main` only fast-forwards
- Production deploys only when the user asks (`gh workflow run deploy-production.yml`)
- Duplicate-finder blocking by crowded decade dropped (measured on 493k: lost pairs, no faster)
- Bug-fix PRs merge without changelog or guide entries; features get both, in both languages
