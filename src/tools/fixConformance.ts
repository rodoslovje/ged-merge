import type { Dataset, GedNode } from "../gedcom/types";
import { liftNestedStamps } from "../gedcom/chanCrea";
import { toStandardCoverage } from "./sourceReshape/apply";
import { baptismTargetTag } from "./sourceReshape/scan";
import { cloneNode, nodesEqual } from "../gedcom/node";
import { dropTitleBesideFileTitle, fileFormOf, hangMediaLinesUnderFile, mimeFormOf } from "../gedcom/mediaForm";
import { hangAgencyUnderData, keepsSourceTag, rebuildFamily, rebuildIndividual, settleSourceFields } from "../gedcom/edit";
import type { FormatOverrides } from "../normalize/formatOverrides";
import { upgradeExtensions } from "../normalize/migrate";
import { type RecordPatch } from "../ui/historyTypes";
import { fixableConformance, isSmartMatchEven, isStrayCitationPage, nodeAtPath, tableFor, type ConformanceIssue } from "./conformance/conformance";
import { applyPassSafely, type PassJournal } from "./passSafety";

/**
 * The repairs the conformance check can make:
 *
 *  - **values** — an enumerated value written in another case than the
 *    standard's (`PEDI Adopted` → `adopted`, 7.0's `TYPE married` →
 *    `MARRIED`), a 7.0 name type outside the enumeration (`variation` →
 *    `AKA`, `formal` → `OTHER` with the word as its `PHRASE`), and a 7.0 date still carrying a 5.5.1 calendar escape
 *    (`@#DJULIAN@ 1700` → `JULIAN 1700`);
 *  - **repeats** — a line the standard allows once, repeated as an exact copy
 *    (same value, same lines beneath): the copies go, the first stays;
 *  - **forms** — a media file with no `FORM`, where the file's name says what
 *    it is (`.jpg`, a web address): the line is added in every such file, or
 *    in those whose form is the one a row names;
 *  - **notes** — a 7.0 event line carrying text where only `Y` may stand
 *    (`BIRT ali Ravna Gora?`): the text moves word for word into a `NOTE` on
 *    the event, and the line is left bare;
 *  - **relocate** — a media record's `TITL`/`FORM` kept beside its `FILE`
 *    (the 5.5 shape): moved under the `FILE` in every media record at once,
 *    as the finding is one row for the whole habit;
 *  - **fileTitles** — the one repair that removes something, run only on the
 *    user's word: where a media record has a title beside its `FILE` and a
 *    different one under it, the one under the `FILE` (which the app shows)
 *    is kept;
 *  - **agency** — a source's own `AGNC`, which no version allows on the
 *    record: moved to `DATA.AGNC` in every source at once;
 *  - **extensions** — an extension standing in for a 7.0 structure (`_UID`,
 *    `_FID`, `_MARNM`, …): restated as that structure in every record, the
 *    rewrites the 5.5.1 → 7.0 conversion makes;
 *  - **sourceFields** — a source's `FILN`/`PERI` (GEDCOM 5.5-EL's filing
 *    number and periodical) or their `_` spellings: the id becomes the
 *    repository link's `CALN`, the periodical joins the `TITL`, in every
 *    source at once — or, where the file keeps the bare tag, the `_`
 *    spelling becomes the bare one;
 *  - **coverage** — a source's flat `PLAC`/`DATE`: restated as the standard's
 *    `DATA > EVEN` coverage in every source whose title names its register;
 *  - **mediaInfo** — a media record's `DATE`/`PLAC`, which neither version
 *    has: kept as the `_DATE`/`_PLACE` extensions GED Merge reads and writes;
 *  - **childPedi** — a `PEDI` on a family's `CHIL` line: moved to the child's
 *    own `FAMC` link to that family (or dropped where that link already says
 *    the same);
 *  - **citationPage** — a text `SOUR` inside a citation (a page typed under
 *    the wrong tag): the citation's `PAGE` where it has none, dropped where
 *    the `PAGE` already says the same;
 *  - **smartMatch** — MyHeritage's Smart Match citation (`EVEN Smart
 *    Matching`, the matched person's id in `ROLE`): the id becomes the
 *    citation's `PAGE`, the `EVEN` goes;
 *  - **assoDates** — a `DATE` on an association: kept word for word as a
 *    `NOTE` on the association, in every record at once;
 *  - **stamps** — `CHAN`/`CREA` below a record (on an event, an attribute…):
 *    the newest change and the oldest creation are lifted onto the record,
 *    the rest dropped, in every record at once.
 *
 * A value outside the list, or a repeat that differs from the first, is the
 * user's question and is only reported. Lines on a record without an xref
 * (HEAD) are left alone, as an undo patch is keyed by xref.
 *
 * Mutates the dataset in place and returns `RecordPatch[]` for the undo stack.
 */
export type ConformanceFixKind = "values" | "repeats" | "forms" | "notes" | "relocate" | "fileTitles" | "agency" | "sourceFields" | "extensions" | "stamps" | "coverage" | "assoDates" | "smartMatch" | "mediaInfo" | "childPedi" | "citationPage";

/** One finding's own fix: its record, and the path of the line inside it. */
export interface ConformanceRef {
  /** The record — absent for a row standing for files across the file. */
  id?: string;
  path?: string;
  /** For the media forms: only the files this form fits. */
  value?: string;
  /** Every finding of one kind across the file: the same value on the same
   *  line, given the same fix (a row standing for all of them). */
  match?: { tag: string; parent: string; sample: string; fix: string };
}

/** Make every text `SOUR` inside a citation the citation's `PAGE`; one equal
 *  to the `PAGE` already there only goes, a different one stays. With `apply`
 *  false, only counts them. */
function strayCitationPages(rec: GedNode, apply: boolean): number {
  let n = 0;
  const visit = (node: GedNode) => {
    for (const c of node.children) {
      if (c.tag.startsWith("_")) continue;
      // `c` is a citation; a text SOUR beneath it is a typed page.
      if (c.tag === "SOUR") {
        for (const stray of c.children.filter(isStrayCitationPage)) {
          const page = c.children.find((g) => g.tag === "PAGE");
          if (page && page.value?.trim() !== stray.value?.trim()) continue;
          n++;
          if (!apply) continue;
          if (page) c.children = c.children.filter((g) => g !== stray);
          else {
            c.children = c.children.filter((g) => g !== stray);
            c.children.unshift({ ...stray, tag: "PAGE" });
          }
        }
      }
      visit(c);
    }
  };
  visit(rec);
  return n;
}

/** The extension a media item's date or place is kept under. */
const MEDIA_EXTENSION: Record<string, string> = { DATE: "_DATE", PLAC: "_PLACE" };

/** Rename a media record's `DATE`/`PLAC` to `_DATE`/`_PLACE`; one equal to
 *  the extension already there only goes, a different one stays. With
 *  `apply` false, only counts them. */
function mediaInfoToExtensions(obje: GedNode, apply: boolean): number {
  let n = 0;
  for (const c of [...obje.children]) {
    const ext = MEDIA_EXTENSION[c.tag];
    if (!ext) continue;
    const held = obje.children.find((g) => g.tag === ext);
    if (held && held.value?.trim() !== c.value?.trim()) continue;
    n++;
    if (!apply) continue;
    if (held) obje.children = obje.children.filter((g) => g !== c);
    else c.tag = ext;
  }
  return n;
}

/**
 * Move every `PEDI` written on a family's `CHIL` lines to the child's own
 * `FAMC` link to that family; where that link already states a pedigree, an
 * equal one (any case) only goes and a different one stays. Calls `touch`
 * before changing a record. Returns how many it settled.
 */
function childPediToFamc(
  fam: GedNode, indis: Map<string, GedNode>, apply: boolean, touch: (rec: GedNode) => void,
): number {
  let n = 0;
  for (const chil of fam.children) {
    if (chil.tag !== "CHIL") continue;
    const pedi = chil.children.find((g) => g.tag === "PEDI");
    const child = pedi && chil.value ? indis.get(chil.value.trim()) : undefined;
    const famc = child?.children.find((g) => g.tag === "FAMC" && g.value?.trim() === fam.xref);
    if (!pedi || !child || !famc) continue;
    const held = famc.children.find((g) => g.tag === "PEDI");
    if (held && held.value?.trim().toLowerCase() !== pedi.value?.trim().toLowerCase()) continue;
    n++;
    if (!apply) continue;
    touch(fam);
    chil.children = chil.children.filter((g) => g !== pedi);
    if (!held) {
      touch(child);
      famc.children.push({ ...pedi, level: famc.level + 1 });
    }
  }
  return n;
}

/** Restate every Smart Match citation in the record: the matched person's
 *  id (its `ROLE`) as the citation's `PAGE` where it has none, and the
 *  `EVEN` label gone. With `apply` false, only counts them. */
function smartMatchToPage(rec: GedNode, apply: boolean): number {
  let n = 0;
  const visit = (node: GedNode) => {
    for (const c of node.children) {
      if (c.tag.startsWith("_")) continue;
      if (c.tag === "SOUR") {
        const even = c.children.find(isSmartMatchEven);
        if (even) {
          n++;
          if (apply) {
            const id = even.children.find((g) => g.tag === "ROLE")?.value?.trim();
            c.children = c.children.filter((g) => g !== even);
            if (id && !c.children.some((g) => g.tag === "PAGE")) {
              c.children.unshift({ level: c.level + 1, tag: "PAGE", value: id, children: [] });
            }
          }
        }
      }
      visit(c);
    }
  };
  visit(rec);
  return n;
}

/** Turn every `DATE` under an association into a `NOTE` there carrying the
 *  same words (a `PHRASE` beside them); one equal to a note already there
 *  only goes. With `apply` false, only counts them. */
function assoDatesToNotes(rec: GedNode, apply: boolean): number {
  let n = 0;
  const visit = (node: GedNode) => {
    for (const c of node.children) {
      if (c.tag.startsWith("_")) continue;
      if (c.tag === "ASSO") {
        const dates = c.children.filter((g) => g.tag === "DATE");
        n += dates.length;
        if (apply) {
          for (const date of dates) {
            const phrase = date.children.find((g) => g.tag === "PHRASE")?.value?.trim();
            const text = [date.value?.trim(), phrase && `(${phrase})`].filter(Boolean).join(" ");
            const i = c.children.indexOf(date);
            if (!text || c.children.some((g) => g.tag === "NOTE" && g.value?.trim() === text)) c.children.splice(i, 1);
            else c.children[i] = { level: date.level, tag: "NOTE", value: text, children: [] };
          }
        }
      }
      visit(c);
    }
  };
  visit(rec);
  return n;
}

/** Add the `FORM` a media file's name says to every `FILE` without one (only
 *  where it is `value`, when given); with `apply` false, only counts them. */
function fillMediaForms(rec: GedNode, v7: boolean, value: string | undefined, apply: boolean): number {
  let n = 0;
  const visit = (node: GedNode) => {
    for (const c of node.children) {
      if (c.tag.startsWith("_")) continue;
      if (node.tag === "OBJE" && c.tag === "FILE" && c.value && !c.children.some((g) => g.tag === "FORM")) {
        const form = fileFormOf(c.value, v7);
        if (form && (value === undefined || form === value)) {
          n++;
          if (apply) c.children.unshift({ level: c.level + 1, tag: "FORM", value: form, children: [] });
        }
      }
      visit(c);
    }
  };
  visit(rec);
  return n;
}

function kindOf(issue: ConformanceIssue): ConformanceFixKind {
  return issue.citationPage ? "citationPage" : issue.childPedi ? "childPedi" : issue.mediaInfo ? "mediaInfo" : issue.smartMatch ? "smartMatch" : issue.assoDate ? "assoDates" : issue.coverage ? "coverage" : issue.stamps ? "stamps" : issue.agency ? "agency" : issue.relocate ? "relocate" : issue.repeat ? "repeats" : issue.toNote ? "notes" : issue.category === "missingLine" ? "forms" : "values";
}

/** What a file-wide pass does to one media (or source) record; returns the
 *  lines it moved or dropped. Each answers a habit row, which names no one
 *  record. */
type MediaPass = (obje: GedNode) => GedNode[];

/** The media pass a kind runs, when the file's own standard calls the lines
 *  beside FILE out of place (5.5 allows them). */
function mediaPassFor(records: GedNode[], kind: ConformanceFixKind | undefined, issues: ConformanceIssue[]): MediaPass | undefined {
  if (kind === "fileTitles") {
    return issues.some((i) => i.relocate && i.sample === "TITL") ? dropTitleBesideFileTitle : undefined;
  }
  if (!issues.some((i) => i.relocate)) return undefined;
  // 7.0 writes a FORM as a media type, so a moved `jpg` arrives as one.
  const form = tableFor(records)?.version.startsWith("7") ? mimeFormOf : undefined;
  return (obje) => hangMediaLinesUnderFile(obje, form);
}

/** How many findings of `kind` the fix would settle — the count on its button;
 *  for the media passes, the media records they would change. */
export function countFixableConformance(dataset: Dataset, kind: ConformanceFixKind, overrides?: Pick<FormatOverrides, "standard">): number {
  if (kind === "sourceFields") {
    const pass = sourceFieldPass(dataset.records, overrides);
    return dataset.records.filter((r) => r.tag === "SOUR" && r.xref && pass(cloneNode(r)).length > 0).length;
  }
  if (kind === "extensions") {
    return dataset.records.filter((r) => r.xref && upgradeExtensions([cloneNode(r)]) > 0).length;
  }
  const fixable = fixableConformance(dataset.records);
  if (kind === "citationPage") {
    if (!fixable.some((i) => i.citationPage)) return 0;
    return dataset.records.reduce((n, r) => n + (r.xref ? strayCitationPages(r, false) : 0), 0);
  }
  if (kind === "mediaInfo") {
    if (!fixable.some((i) => i.mediaInfo)) return 0;
    return dataset.records.reduce((n, r) => n + (r.tag === "OBJE" && r.xref ? mediaInfoToExtensions(r, false) : 0), 0);
  }
  if (kind === "childPedi") {
    if (!fixable.some((i) => i.childPedi)) return 0;
    const indis = new Map(dataset.records.filter((r) => r.tag === "INDI" && r.xref).map((r) => [r.xref!, r] as const));
    return dataset.records.reduce((n, r) => n + (r.tag === "FAM" && r.xref ? childPediToFamc(r, indis, false, () => {}) : 0), 0);
  }
  if (kind === "smartMatch") {
    if (!fixable.some((i) => i.smartMatch)) return 0;
    return dataset.records.reduce((n, r) => n + (r.xref ? smartMatchToPage(r, false) : 0), 0);
  }
  if (kind === "assoDates") {
    if (!fixable.some((i) => i.assoDate)) return 0;
    return dataset.records.reduce((n, r) => n + (r.xref ? assoDatesToNotes(r, false) : 0), 0);
  }
  if (kind === "coverage") {
    if (!fixable.some((i) => i.coverage)) return 0;
    const baptism = baptismTargetTag(dataset.records);
    return dataset.records.filter((r) => r.tag === "SOUR" && r.xref && toStandardCoverage(cloneNode(r), baptism)).length;
  }
  if (kind === "stamps") {
    if (!fixable.some((i) => i.stamps)) return 0;
    const v7 = isV7Table(dataset.records);
    return dataset.records.filter((r) => r.xref && liftNestedStamps(cloneNode(r), v7).length > 0).length;
  }
  if (kind === "agency") {
    if (!fixable.some((i) => i.agency)) return 0;
    return dataset.records.filter((r) => r.tag === "SOUR" && r.xref && hangAgencyUnderData(cloneNode(r)).length > 0).length;
  }
  const pass = kind === "relocate" || kind === "fileTitles" ? mediaPassFor(dataset.records, kind, fixable) : undefined;
  if (pass) return dataset.records.filter((r) => r.tag === "OBJE" && r.xref && pass(cloneNode(r)).length > 0).length;
  // A grouped row (the media forms) stands for as many lines as it counts.
  return fixable
    .filter((i) => kindOf(i) === kind)
    .reduce((n, i) => n + (kind === "forms" ? Number(i.messageVars?.count) || 1 : 1), 0);
}

/** @param only — settle just the one finding a row names.
 *  @param overrides — the target's format choices: whether the file keeps its
 *  own source lines (see `keepsSourceTag`). */
export function fixConformance(
  dataset: Dataset,
  kind?: ConformanceFixKind,
  only?: ConformanceRef,
  overrides?: Pick<FormatOverrides, "standard">,
): RecordPatch[] {
  if (kind === "sourceFields") {
    const pass = sourceFieldPass(dataset.records, overrides);
    return applyPassSafely(dataset, (journal) => mediaPassOver(dataset.records, pass, journal, "SOUR"));
  }
  if (kind === "extensions") {
    return applyPassSafely(dataset, (journal) => {
      const patches: RecordPatch[] = [];
      for (const rec of dataset.records) {
        if (!rec.xref || upgradeExtensions([cloneNode(rec)]) === 0) continue;
        const before = cloneNode(rec);
        journal.keep(rec.xref, before);
        upgradeExtensions([rec]);
        patches.push(recordPatch(dataset, rec.xref, rec, before));
      }
      return patches;
    });
  }
  const scanned = fixableConformance(dataset.records, only?.id);
  if (kind === "fileTitles") return runMediaPass(dataset, mediaPassFor(dataset.records, kind, scanned));
  const issues = scanned.filter(
    (i) => (!kind || kindOf(i) === kind) && (!only || only.path === undefined || i.path === only.path)
      && (!only?.match || (i.messageVars.tag === only.match.tag && i.messageVars.parent === only.match.parent
        && i.sample === only.match.sample && i.fix === only.match.fix)),
  );
  const mediaPass = mediaPassFor(dataset.records, kind, issues);
  const byRecord = new Map<string, ConformanceIssue[]>();
  for (const issue of issues) {
    if (issue.relocate || issue.agency || issue.stamps || issue.coverage || issue.assoDate || issue.smartMatch || issue.mediaInfo || issue.childPedi || issue.citationPage || (issue.category === "missingLine" && issue.fix !== undefined)) continue;
    const list = byRecord.get(issue.recordId!);
    if (list) list.push(issue);
    else byRecord.set(issue.recordId!, [issue]);
  }
  const agencyPass = issues.some((i) => i.agency);
  const formsPass = issues.some((i) => i.category === "missingLine" && i.fix !== undefined);
  const stampsPass = issues.some((i) => i.stamps);
  const coveragePass = issues.some((i) => i.coverage);
  const assoPass = issues.some((i) => i.assoDate);
  const smartPass = issues.some((i) => i.smartMatch);
  const mediaInfoPass = issues.some((i) => i.mediaInfo);
  const childPediPass = issues.some((i) => i.childPedi);
  const citationPagePass = issues.some((i) => i.citationPage);
  if (!byRecord.size && !mediaPass && !agencyPass && !stampsPass && !formsPass && !coveragePass && !assoPass && !smartPass && !mediaInfoPass && !childPediPass && !citationPagePass) return [];

  const records = new Map<string, GedNode>();
  for (const r of dataset.records) if (r.xref && byRecord.has(r.xref)) records.set(r.xref, r);

  const patches: RecordPatch[] = [];
  applyPassSafely(dataset, (journal) => {
    for (const [xref, list] of byRecord) {
      const rec = records.get(xref);
      if (!rec) continue;
      const before = cloneNode(rec);
      journal.keep(xref, before);
      // Every line is found before any is removed, so the paths stay valid;
      // values first, so copies whose shared value was recased still match.
      const targets = list
        .map((issue) => ({ issue, node: nodeAtPath(rec, issue.path ?? "") }))
        .sort((a, b) => Number(!!a.issue.repeat) - Number(!!b.issue.repeat));
      for (const { issue, node } of targets) {
        if (!node) continue;
        if (issue.repeat) {
          const tag = issue.sample!;
          const first = node.children.find((c) => c.tag === tag);
          node.children = node.children.filter((c) => c === first || c.tag !== tag || !nodesEqual(c, first!));
        } else if (issue.category === "missingLine" && issue.fix !== undefined) {
          node.children.unshift({ level: node.level + 1, tag: issue.sample!, value: issue.fix, children: [] });
        } else if (issue.toNote && node.value) {
          const text = node.value.trim();
          if (!node.children.some((c) => c.tag === "NOTE" && c.value?.trim() === text)) {
            node.children.push({ level: node.level + 1, tag: "NOTE", value: text, children: [] });
          }
          node.value = undefined;
        } else if (issue.fix !== undefined) {
          node.value = issue.fix;
          if (issue.fixPhrase && !node.children.some((c) => c.tag === "PHRASE")) {
            node.children.unshift({ level: node.level + 1, tag: "PHRASE", value: issue.fixPhrase, children: [] });
          }
        }
      }
      patches.push(recordPatch(dataset, xref, rec, before));
    }
    if (mediaPass) patches.push(...mediaPassOver(dataset.records, mediaPass, journal));
    if (agencyPass) patches.push(...mediaPassOver(dataset.records, hangAgencyUnderData, journal, "SOUR"));
    if (formsPass) {
      const v7 = isV7Table(dataset.records);
      for (const rec of dataset.records) {
        if (!rec.xref || (only?.id && rec.xref !== only.id)) continue;
        if (!fillMediaForms(rec, v7, only?.value, false)) continue;
        const before = cloneNode(rec);
        journal.keep(rec.xref, before);
        fillMediaForms(rec, v7, only?.value, true);
        patches.push(recordPatch(dataset, rec.xref, rec, before));
      }
    }
    if (citationPagePass) {
      for (const rec of dataset.records) {
        if (!rec.xref || !strayCitationPages(rec, false)) continue;
        const before = cloneNode(rec);
        journal.keep(rec.xref, before);
        strayCitationPages(rec, true);
        patches.push(recordPatch(dataset, rec.xref, rec, before));
      }
    }
    if (mediaInfoPass) {
      for (const rec of dataset.records) {
        if (rec.tag !== "OBJE" || !rec.xref || !mediaInfoToExtensions(rec, false)) continue;
        const before = cloneNode(rec);
        journal.keep(rec.xref, before);
        mediaInfoToExtensions(rec, true);
        patches.push(recordPatch(dataset, rec.xref, rec, before));
      }
    }
    if (childPediPass) {
      // A move touches two records, the family and the child: each is kept
      // once, before its first change, and patched once at the end.
      const indis = new Map(dataset.records.filter((r) => r.tag === "INDI" && r.xref).map((r) => [r.xref!, r] as const));
      const befores = new Map<GedNode, GedNode>();
      const touch = (rec: GedNode) => {
        if (befores.has(rec)) return;
        const before = cloneNode(rec);
        befores.set(rec, before);
        journal.keep(rec.xref!, before);
      };
      for (const rec of dataset.records) if (rec.tag === "FAM" && rec.xref) childPediToFamc(rec, indis, true, touch);
      for (const [rec, before] of befores) patches.push(recordPatch(dataset, rec.xref!, rec, before));
    }
    if (smartPass) {
      for (const rec of dataset.records) {
        if (!rec.xref || !smartMatchToPage(rec, false)) continue;
        const before = cloneNode(rec);
        journal.keep(rec.xref, before);
        smartMatchToPage(rec, true);
        patches.push(recordPatch(dataset, rec.xref, rec, before));
      }
    }
    if (assoPass) {
      for (const rec of dataset.records) {
        if (!rec.xref || !assoDatesToNotes(rec, false)) continue;
        const before = cloneNode(rec);
        journal.keep(rec.xref, before);
        assoDatesToNotes(rec, true);
        patches.push(recordPatch(dataset, rec.xref, rec, before));
      }
    }
    if (coveragePass) {
      const baptism = baptismTargetTag(dataset.records);
      for (const rec of dataset.records) {
        if (rec.tag !== "SOUR" || !rec.xref || !toStandardCoverage(cloneNode(rec), baptism)) continue;
        const before = cloneNode(rec);
        journal.keep(rec.xref, before);
        toStandardCoverage(rec, baptism);
        patches.push(recordPatch(dataset, rec.xref, rec, before));
      }
    }
    if (stampsPass) {
      const v7 = isV7Table(dataset.records);
      for (const rec of dataset.records) {
        if (!rec.xref || !liftNestedStamps(cloneNode(rec), v7).length) continue;
        const before = cloneNode(rec);
        journal.keep(rec.xref, before);
        liftNestedStamps(rec, v7);
        patches.push(recordPatch(dataset, rec.xref, rec, before));
      }
    }
  });
  return patches;
}

/** The file's declared version is 7.0 — the stamps pass writes `CREA`
 *  there and `_CREA` in 5.5.1. */
function isV7Table(records: GedNode[]): boolean {
  return !!tableFor(records)?.version.startsWith("7");
}

/** The pass that restates a source's `FILN`/`PERI` lines (see
 *  `settleSourceFields`), in the version the file declares — the save converts
 *  it with the rest when the target is the other one. */
function sourceFieldPass(records: GedNode[], overrides?: Pick<FormatOverrides, "standard">): MediaPass {
  const version = isV7Table(records) ? "7.0" : "5.5.1";
  const keep = { FILN: keepsSourceTag(records, "FILN", overrides), PERI: keepsSourceTag(records, "PERI", overrides) };
  return (rec) => settleSourceFields(rec, version, keep);
}

/** Run a pass over every media (or source) record, one undo patch per record
 *  it changed. */
function mediaPassOver(records: GedNode[], pass: MediaPass, journal: PassJournal, tag = "OBJE"): RecordPatch[] {
  const patches: RecordPatch[] = [];
  for (const rec of records) {
    if (rec.tag !== tag || !rec.xref) continue;
    // Tried on a copy first, so the journal holds a record only when it changes.
    if (!pass(cloneNode(rec)).length) continue;
    const before = cloneNode(rec);
    journal.keep(rec.xref, before);
    pass(rec);
    patches.push({ type: "record", id: rec.xref, before, after: cloneNode(rec) });
  }
  return patches;
}

function runMediaPass(dataset: Dataset, pass: MediaPass | undefined): RecordPatch[] {
  if (!pass) return [];
  return applyPassSafely(dataset, (journal) => mediaPassOver(dataset.records, pass, journal));
}

/** A record rewritten in place: the typed model brought back in step, and the
 *  undo patch from its `before` clone. */
export function recordPatch(dataset: Dataset, xref: string, rec: GedNode, before: GedNode): RecordPatch {
  const indi = dataset.individuals.get(xref);
  const fam = dataset.families.get(xref);
  if (indi && indi.raw === rec) {
    rebuildIndividual(dataset, indi);
    return { type: "individual", id: xref, before, after: cloneNode(rec) };
  }
  if (fam && fam.raw === rec) {
    rebuildFamily(dataset, fam);
    return { type: "family", id: xref, before, after: cloneNode(rec) };
  }
  return { type: "record", id: xref, before, after: cloneNode(rec) };
}
