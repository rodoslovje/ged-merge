# How matching works

This documents the individual-matching algorithm as implemented in `src/match/`
and its within-file twin in `src/tools/duplicates.ts`. It reflects the state
after the 2026-07 false-positive overhaul; the constants quoted here live in
code next to doc comments explaining their calibration — when code and this
file disagree, the code is right.

There are three entry points, all built from the same primitives:

| Entry point | Purpose |
|---|---|
| `matchDatasets` (`src/match/engine.ts`) | Compare an incoming file against the main file; produce a one-to-one candidate list for the merge review. |
| `findDuplicates` (`src/tools/duplicates.ts`) | Find duplicate records *within* one file (Tools tab). |
| `matchGiPairs` (`src/match/giMatch.ts`) | Resolve a genealogical-index matches CSV: rows arrive pre-paired by an exact name+birth-year key, so only the scoring stage runs. |

## Design principles

- **Never merge wrong, silently.** Anything automatic (the flat 100 score, the
  incoming-duplicate consolidation) must err toward *missing* a match, never
  toward a wrong one. A missed duplicate just stays visible in the tree; a
  wrong merge corrupts data.
- **Demote, don't delete.** Doubtful pairs are penalized or capped, not
  dropped: they stay in the results as weak suggestions, and the
  relationship passes — which reason from *matched relatives*, not names —
  can restore any pair that turns out to be corroborated.
- **Evidence must discriminate.** Fields that are shared by construction
  (a father's surname, a child's surname) or nearly free in the data
  (a mother named Marija, two records both estimated "~1900") are not treated
  as evidence of identity.
- **Calibrated on real files.** Thresholds come from measured similarity
  values over Slovenian/Austro-Hungarian parish-record data (see the
  calibration table at the end), and changes are benchmarked against the
  `test-data/` files and the genealogical-index corpus before landing.

## Pipeline (cross-file `matchDatasets`)

```
parse → normalize (compare reshaped to main's conventions, see src/normalize/)
  → ½ uid pre-match     shared _UID/UID = certain identity, score 100
  → 1 blocking          only plausible pairs are ever scored
  → 2 hard gates        sex / name / era vetoes
  → 3 scoring           weighted components + penalties + ceiling
  → 4 1:1 assignment    greedy by score
  → 5 relationship link co-parents of matched children override name/date
  → 6 relative boost    corroborated pairs floored into the 90s
  → 7 incoming-duplicate consolidation (same person split across incoming records)
  → (optional) kinship re-ranking from the home person
```

### 0. Name preparation — placeholders are not names

Before any comparison, name parts go through `comparableName`
(`src/match/similarity.ts`): parts that are placeholders per
`isPlaceholderName` (`src/match/text.ts`) are treated as **missing**. The
placeholder set covers privacy scrubs (`Living`, `Privat`, `Private`),
unknown-name markers (`NN`, `N.N.`, `neznan/-a/-o`, `unknown`, `unbekannt`),
template tokens (`?Ime?`, `?Priimek?`), bare initials, and anything with no
letters (`?`, `???`, `____`). Rationale: placeholders compare as a *perfect*
match ("Living" ~ "Living" = 1.0) while identifying nothing — before this
filter, privacy-scrubbed files produced hundreds of "duplicate" pairs of
unnamed siblings. Display code is unaffected; this is a matching-layer
judgement only.

A record whose entire name is placeholders gets no blocking key at all — it
cannot be matched by name, though relationship linking can still connect it.

### ½. UID identity pre-match (`matchByUid`, `src/match/engine.ts`)

Most programs stamp every person with a persistent unique id (vendor `_UID`,
GEDCOM 7 `UID`) that survives export/import within the same software lineage.
Two records carrying the same id **are** the same person by construction, so
such pairs are matched before anything else: they bypass blocking and every
gate (the whole point — the copies may have diverged in name or dates), score
a flat 100 (identity is not a probability; the UI marks them 🔑), are placed
first so the greedy 1:1 assignment always keeps them, and the relationship
pass is forbidden from displacing them. Safeties: values are canonicalized
(braces/dashes/case) before comparison, anything under 12 canonical chars is
ignored as junk, and an id carried by two records in *one* file identifies
nothing and is skipped. On merge, the incoming record's ids are carried onto
the merged main record (`carryUids`, `src/merge/merge.ts`) so the *next*
import of that lineage auto-matches by identity.

### 1. Blocking (`individualBlockKeys`, `src/match/scoreIndividual.ts`)

A cheap recall-oriented pass so the expensive scoring is only run on
plausible pairs. Every individual is bucketed by:

- `SB:<surname-soundex>:<birth-decade>` for a known birth year (±1 decade),
  or a relative-derived estimate (`src/match/birthEstimate.ts`, ±2 decades);
- `S:<surname-soundex>` as a fallback for records with no usable date;
- `SG:<surname-soundex>:<given-initial>`.

Two records are compared iff they share at least one bucket.

### 2. Hard gates (`plausibleIndividualMatch`)

Pairs failing any gate are never scored:

- **Sex**: both recorded and different.
- **Name**: surname similarity < 0.8 or given similarity < 0.5
  (Jaro-Winkler over folded tokens; given names compared token-wise so middle
  names and ordering matter less). The loose given gate deliberately admits
  nickname/cross-language variants; precision is recovered later by penalties.
- **Era**: representative years (birth, else estimate, else death/marriage)
  more than 30 years apart, or a lifespan impossibility (one died before the
  other was born).

### 3. Scoring (`scoreIndividualPair`, `src/match/scoreIndividual.ts`)

A weighted average over comparable components (0..1, shown as 0–100):

| Component | Weight | Notes |
|---|---|---|
| surname | 3 | identity key |
| given | 2 | identity key |
| birthDate | 3 | identity key |
| birthPlace / birthAddress | 1.5 / 1.5 | locality compared without the house number; same house number is decisive |
| deathDate / deathPlace | 1.5 / 0.75 | corroboration only — absence is skipped, not penalized |
| sex | 0.5 | |
| parents | 2 | **role-wise**: father by given name only (his surname is the family surname, already scored), mother by full name (her maiden surname genuinely discriminates) |
| partners | 1.5 | full-name set comparison — a spouse's family name discriminates |
| children | 1.5 | given names only (children share the person's surname) |
| marriageDate / marriagePlace | 1.5 / 0.75 | best over the cross-product of both sides' marriages |

Key rules inside the components:

- **Identity key & missing data.** Surname, given and birth date are always
  scored; a side missing one is charged `missingKeyScore` (0.3) instead of
  the component being skipped — an incomplete record cannot look complete.
- **Marriage-derived birth plausibility.** When one side has no birth date,
  a fallback may score the birth key 0.85 instead of 0.3 — but only when the
  birth-less record comes from a *sparse-birth source* (`Dataset.
  sparseBirthDates`, set only by the GI matches CSV import, whose family rows
  often carry just a marriage date) **and** the known birth year implies a
  plausible age (15–60) at the birth-less record's own marriage. Unscoped,
  this fallback once inflated every sparse GEDCOM pair to 85+ "strong".
- **Date similarity** (`dateSimilarity`, `src/match/similarity.ts`): exact
  years within ±4 decay linearly; approximate (ABT/EST) within ±10;
  BEF/AFT/BET assert bounds, not points — consistency with a bound scores
  0.9, contradiction decays. Within the same year: different month 0.55,
  different day 0.9. **A perfect 1.0 requires two exact day-precision dates
  that agree in full** — two bare years that merely match score 0.9, because
  namesakes born the same year are routine in dense clusters.

After combining, three multiplicative corrections:

- **Given-name conflict penalty** (×0.8 when given similarity < 0.7): a clear
  given disagreement is stronger negative evidence than a weighted average
  can express — Marta/Uršula or Johann/Franc pairs used to average out at
  80+ on surname and dates alone. 0.7 sits just under the nickname band
  (William/Bill 0.73 passes; Janez/Ivan 0.63 is knowingly demoted and left
  to relationship recovery).
- **Both-parents conflict penalty** (×0.8 when *both* the fathers' and the
  mothers' given names are in the conflict band, < 0.65): different father
  *and* different mother means a different family, however well the person's
  own key agrees (the IDEAS.md "dense name clusters" case). A single
  conflicting role is deliberately not penalized — one parent under a
  cross-language variant (Jurij/Georg 0.47) is routine in bilingual records.
  The two penalties stack (×0.64) for pairs wrong on both counts.
- **No-evidence ceiling** (cap at 0.6): a pair needs at least one hard
  discriminator — a comparable full name (real given *and* surname both
  sides), an exact month-or-better birth **or death** agreement, or
  comparable parent/partner/child names. Skeleton records (placeholder name
  part + estimated "~1900" year) offer none, and their surname+fuzzy-year
  pairs multiply quadratically in big files (Hawlina: ~977-person
  same-surname clusters). The ceiling keeps them below the duplicate-list
  cutoff (0.70) and the probable band (0.65).

Finally:

- **Perfect key = flat 100.** All three key fields present, real, and exact —
  which for the birth date now means day-precision on both sides. 100 is
  *reserved* for this; every other pair is capped at 99.9.
- **Relative full-name bonus**: +1.5 points each for a father, mother or
  partner whose full name matches exactly (post-placeholder), capped at 99.9.

### 4. One-to-one assignment

Greedy by descending score: a main record and a compare record each appear in at
most one match. Right model for a merge; kills many-to-one noise between
similarly-named people.

### 5. Relationship linking (`linkByRelationships`, `src/match/engine.ts`)

Bootstraps from the assignment: if a main person and a compare person are
same-role parents of the same *confidently matched* children (each relative's
own match ≥ 85), they are linked as the same person — overriding whatever
weaker name/date match either had. Evidence bar: 2+ shared matched children,
or 1 shared child plus a matched co-parent ("complete the couple"). This is
what recovers maiden-vs-married surnames and nickname mothers ("Slavka" vs
"Stanislava Marija") that name scoring cannot. Linked pairs carry
`relationshipLinked: true` for the UI's 🌳 flag. An existing assignment is
only displaced by a link with strictly more matched-relative corroboration.

### 6. Relative-corroboration boost (`boostByMatchedRelatives`)

After assignment, any pair with ≥2 relatives that are *themselves matched*
(spouse↔spouse, child↔child, parent↔parent, each ≥ 85) is floored into the
90s: 2 relatives → 91, 3 → 92, … capped at 97. The floor only raises. This is
also the safety net for everything the penalties demote: a genuine
cross-language pair (Jera/Gertrud) penalized on names is pulled back up by
its matched family.

### 7. Categories

On the 0..1 scale: **strong** ≥ 0.85, **probable** ≥ 0.65, else **weak**;
pairs below `minScore` 0.45 are discarded. (`maxPerRecord` exists in the
config but is currently unused — assignment is 1:1 anyway.)

### 8. Incoming-duplicate consolidation (`findIncomingDuplicateClusters`)

Index exports often contain the same person several times. The reliable
signal is several incoming records all matching the *same* main person: the
runner-ups that lost the 1:1 assignment are candidate duplicates of the
winner. Before consolidating (the worker merges them into the kept record),
each runner-up must survive hard vetoes — given similarity ≥ 0.85, birth
years within 3, no parent conflict per the shared three-band verdict — and
score ≥ 85 against the kept record directly. Erring high here means a missed
consolidation (harmless); the vetoes exist because a wrong one merges two
different people silently.

### 9. Kinship re-ranking (`src/match/distance.ts`)

When a home person is set, candidates are annotated with BFS hop distance
(parent/spouse/child = 1 hop) from the home person and re-ranked so nearby
relatives surface first. Scores are unchanged.

## Within-file duplicates (`findDuplicates`, `src/tools/duplicates.ts`)

Same blocking, gates and scoring — with three differences:

- No 1:1 assignment (everyone's best match would be themselves); every
  unordered pair is scored once, from its lower-id side (no global seen-set —
  one exceeded V8's ~16.7M Set limit on a 500k-person file).
- A stricter acceptance cutoff: 0.70 (vs 0.45), since both records come from
  one curated file.
- **`distinctRelatives` vetoes**, applied before scoring, because a weighted
  average cannot outvote circumstantial agreement between close relatives:
  - given similarity < 0.85 → distinct people (siblings/cousins; nickname
    variants are knowingly sacrificed — twins vastly outnumber them);
  - both exact birth dates with different years → namesake child;
  - **same exact calendar birth day → all parent vetoes are skipped**: two
    copies of one christening entry may still spell a parent differently
    (Gertrud vs Jera — German vs Slovene register);
  - father given names in the conflict band → different family, and a mother
    "agreement" cannot rescue the pair (mother given names are dominated by
    a handful of ubiquitous names — same-named cousins routinely both have a
    mother Marija);
  - otherwise, some parent role conflicting with none agreeing → cousins.
- Output pairs are oriented so the record with more linked relatives leads as
  the merge survivor.

## Parent given-name bands (shared)

One source of truth in `src/match/similarity.ts` (`parentGivenVerdict`):
**agree ≥ 0.75**, **conflict < 0.65**, in between **unknown** — used by the
within-file vetoes, the consolidation veto and the both-parents penalty. The
gap exists because the data genuinely has one: distinct parents measure ≤ 0.6
(Anton/Jakob is exactly 0.600), recording variants of one parent 0.69+
(Miko/Mihael, Janez/Johann). Forcing a call inside the gap produced wrong
merges either way.

## Calibration reference (measured `givenSimilarity` on real pairs)

| Same person (variants) | | Different people | |
|---|---|---|---|
| Jože/Jožef | 0.96 | Marta/Uršula | 0.58 |
| Marjanca/Marjana | 0.98 | Johann/Franc | 0.58 |
| Marija/Anna Maria | 0.97 | Jožef/Jakob | 0.52 |
| Anton/Antonius | 0.93 | Mihael/Florijan | 0.53 |
| Franc/Frančišek | 0.91 | Anton/Alojz | 0.64 |
| William/Bill | 0.73 | Anton/Jakob | 0.60 |
| Janez/Johann | 0.73 | Neža/Ana | 0.72 |
| Jože/Josip | 0.71 | Marija/Terezija | 0.72 |
| Miko/Mihael | 0.69 | Nikola/Matija | 0.56 |
| Janez/Ivan | 0.63 | Primož/Janez | 0.46 |
| Jera/Gertrud | 0.60 | Martin/Franc | 0.59 |
| Jurij/Georg | 0.47 | Blaž/Franc | 0.00 |

The two columns overlap between ~0.55 and ~0.75 — no string threshold can
separate nickname variants from distinct people. That is why the pipeline
penalizes-and-recovers (via relationships) instead of gating harder.

## Where the knobs live

| What | Where |
|---|---|
| Weights, gates, `missingKeyScore`, bonuses, category thresholds | `DEFAULT_CONFIG` in `src/match/types.ts` |
| Given-conflict penalty (0.7 / ×0.8), parent-conflict penalty (×0.8), no-evidence ceiling (0.6), marriage-age range | module constants in `src/match/scoreIndividual.ts` |
| Parent bands (0.75 / 0.65) | `src/match/similarity.ts` |
| Consolidation vetoes (0.85 given, ±3 years, ≥85 pair score) | `src/match/engine.ts` |
| Within-file vetoes (0.85 given, cutoff 0.70) | `src/tools/duplicates.ts` |
| Placeholder token set | `src/match/text.ts` |

## Verifying changes

Behavior is pinned by `src/match/match.test.ts` (gates, penalties, ceiling,
key rules, relationship passes), `src/match/similarity.test.ts`,
`src/tools/tools.test.ts` (within-file vetoes) and the end-to-end golden
merge suite in `src/__fixtures__/merge.pipeline.test.ts`. When tuning
scoring, also sweep real files: run `findDuplicates` over `test-data/*.ged`
and cross-match known pairs (Renko ↔ Renko-Rakar must stay ~8.9k strong with
no losses; Renko ↔ Trobec shares only the Okorn family and is a false-positive
canary). The genealogical-index corpus (`~/rodoslovje/srd-data/index/input`,
271 files up to 500k individuals) is the scale/robustness benchmark.
