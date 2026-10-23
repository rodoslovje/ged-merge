# STATUS — ged-merge
_Updated 2026-10-23_

GED Merge, live at gedmerge.com (test site test.gedmerge.com). Rules: `CLAUDE.md`/`AGENTS.md`. **Backlog and priorities: `IDEAS.md`** (not duplicated here).
Workflow since 4. 10.: every change is a worktree branch + PR; `main` merges only on green CI, every green `main` deploys the test site, production only on request.

**Last work (4.–23. 10., PRs #1–#42)**
- Date handling: one date input everywhere, D. M. YYYY display, dual years kept (#32 #34 #36 #39)
- Full six-area review of 22. 10.: data-loss, correctness, dedup and perf fixes merged (#33 #35 #37 #38); tests + undo-position fix (#40)
- Edit: siblings row + wider family, partner beside partner, separated-union marks (#20–#25)
- Page history (Back walks visits), chart re-root trail, start person from the kinship chip (#12–#14, #27)
- Dependencies updated, vite advisories closed (#42)

**In flight**
- PR #41 *Event time in the date field* — open, own worktree `event-time`

**Now (top of IDEAS.md priority queue)**
1. Living-persons privacy as one global setting
2. Merge mode: media/photo field

**Still open from the 2026-10-22 review**
- GEDCOM coverage audit gaps 03–10 (unlifted standard tags, `TEMP`/`MIME`, no user-facing version migration, `HEAD.SCHMA`, `SEX X`, …)
- Merge review panel ignores `fieldAnchors`; worker patch is a full rebuild (~7 s on 500k)
- Bulk normalize not idempotent on a second run; SNOTE/`_`-tag→OBJE pointers not remapped in merge
- Known flaky e2e: `dropdown-menu.spec.ts:95`, delete-undo association search count

**Held back on purpose**
- TypeScript 7 — waits for typescript-eslint support (`<6.1.0` today)
- `@vitejs/plugin-react` 6.1.2 — Babel 8 optional peer clashes with Workbox's Babel 7

**Outreach (not code)**
- [ ] Raise awareness in genealogy communities (SLO/HR/global): landing page, OG image, posts
- [ ] rodoslovni-viri record `gedmerge.md` exists — keep it current

**Decided**
- Free, runs entirely in the browser, no backend, MIT
- Nothing reaches `main` except through a PR with green CI; local `main` only fast-forwards
- Production deploys only when the user asks (`gh workflow run deploy-production.yml`)
