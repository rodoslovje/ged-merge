import { filingNumberOf, isPointer, looksLikeUrl, periodicalOf, resolveSourceCitation, writesCallNumbers } from "../source";
import { VOID_XREF } from "../assoc";
import type { FormatOverrides } from "../../normalize/formatOverrides";
import { linkKey } from "../../normalize/links";
import { childrenByTag, firstChild, removeChildren } from "../node";
import type { Dataset, GedNode } from "../types";
import { insertGrouped, insertOrdered, insertRecord, nextXref } from "./shared";

/** Trailing block of a `SOUR` record a new `OBJE` link must stay ahead of. */
export const SOUR_TRAILING_TAGS = ["REPO", "CHAN", "CREA"] as const;
/** Trailing block a new descriptive field must stay ahead of — the media
 *  links, the repository link and the bookkeeping timestamps. */
export const SOUR_FIELD_TRAILING = ["OBJE", "REPO", "CHAN", "CREA"] as const;
import { bumpSourceCacheVersion, getMediaAndSourceCtx, memoOnContent } from "./cache";
import { createMediaRecord, prefersMimeForm, referencedObjeXrefs } from "./media";
import { fileFormOf, relevel } from "../mediaForm";
import { removeNoteRecordIfOrphaned, setSharedNoteText, type SharedNoteCtx } from "./notes";

/** Fields for a newly authored `SOUR` record — see `createSourceRecord`. */
export interface NewSourceFields {
  title?: string;
  author?: string;
  periodical?: string;
  publisher?: string;
  agency?: string;
  filingNumber?: string;
  note?: string;
  url?: string;
}

/**
 * Create a new top-level `SOUR` record from user-entered/parsed fields and,
 * if `url` is given, a backing `OBJE` record for it — the same shape
 * `resolveSourceCitation` already resolves for imported "paginated" sources
 * (a `SOUR` with one linked `OBJE`), so the new citation displays/links
 * exactly like an imported one.
 */
export function createSourceRecord(
  records: GedNode[],
  fields: NewSourceFields,
  /** Xrefs promised elsewhere (the merge's pending shared-record imports) that
   *  the fresh ids must skip — see `nextXref`. */
  reserved?: ReadonlySet<string>,
  /** The format choices with the target format applied: a strict target
   *  writes the standard forms (see {@link keepsSourceTag}). */
  overrides?: Pick<FormatOverrides, "standard">,
): GedNode {
  const raw: GedNode = { level: 0, xref: nextXref(records, "S", reserved), tag: "SOUR", children: [] };
  const push = (tag: string, value: string | undefined) => {
    if (value) raw.children.push({ level: 1, tag, value, children: [] });
  };
  const keepPeri = keepsSourceTag(records, "PERI", overrides);
  push("TITL", keepPeri ? fields.title : titleWithPeriodical(fields.title, fields.periodical));
  push("AUTH", fields.author);
  if (keepPeri) push("PERI", fields.periodical);
  push("PUBL", fields.publisher);
  if (overrides?.standard && fields.agency) {
    // Neither version has AGNC on the record itself: the standard states the
    // agency inside DATA.
    raw.children.push({ level: 1, tag: "DATA", children: [{ level: 2, tag: "AGNC", value: fields.agency, children: [] }] });
  } else {
    push("AGNC", fields.agency);
  }
  // Bare even where the standard's call number is wanted: the repository link
  // it belongs on is the caller's to add, so the caller settles it after (see
  // `settleSourceFields`).
  push("FILN", fields.filingNumber);
  push("NOTE", fields.note);
  insertRecord(records, raw);
  bumpSourceCacheVersion(records);
  if (fields.url) {
    const obje = createMediaRecord(records, fields.url, undefined, reserved);
    raw.children.push({ level: 1, tag: "OBJE", value: obje.xref, children: [] });
  }
  return raw;
}

/** Add a new `OBJE` (linking `url`, optionally titled) to an already-existing
 * `SOUR` record — a new page of a paginated source that's already cited elsewhere. */
export function addObjeToSource(
  records: GedNode[],
  sourceXref: string,
  url: string,
  title?: string,
  /** Xrefs promised elsewhere that the new media record must skip — see `nextXref`. */
  reserved?: ReadonlySet<string>,
): GedNode {
  const obje = createMediaRecord(records, url, title, reserved);
  const sourceNode = records.find((r) => r.tag === "SOUR" && r.xref === sourceXref);
  if (sourceNode) {
    insertGrouped(
      sourceNode,
      { level: sourceNode.level + 1, tag: "OBJE", value: obje.xref, children: [] },
      SOUR_TRAILING_TAGS,
    );
  }
  return obje;
}

/** A citation about to be written: which source it points at, and the fields
 * that belong to this reference of it rather than to the source record —
 * which entry (`PAGE`) and how good the evidence is (`QUAY`). */
export interface NewCitation {
  sourceXref: string;
  page?: string;
  quay?: string;
}

/** Attach a `SOUR` citation pointer (with optional `PAGE`/`QUAY`) to `record`
 * — an event node, or a top-level INDI/FAM record — in canonical field order. */
export function attachSourceCitation(
  record: GedNode,
  sourceXref: string,
  page: string | undefined,
  order: string[],
  quay?: string,
): void {
  const citation: GedNode = { level: record.level + 1, tag: "SOUR", value: sourceXref, children: [] };
  if (page) citation.children.push({ level: record.level + 2, tag: "PAGE", value: page, children: [] });
  setCitationQuay(citation, quay);
  insertOrdered(record, citation, order);
}

/**
 * Write, change or clear a citation's data-quality value (`QUAY` 0–3) in
 * place. A value that has not changed keeps the line it already holds — the
 * same discipline {@link setSourceRecordFields} keeps for the source's own
 * fields — and a new one goes last, after the `PAGE` the citation opens with.
 */
export function setCitationQuay(citation: GedNode, quay: string | undefined): void {
  const value = quay?.trim();
  const existing = firstChild(citation, "QUAY");
  if (!value) {
    if (existing) citation.children = citation.children.filter((c) => c !== existing);
    return;
  }
  if (existing) {
    if (existing.value?.trim() !== value) existing.value = value;
    return;
  }
  citation.children.push({ level: citation.level + 1, tag: "QUAY", value, children: [] });
}

/** Link the cited page's image beside the citation on `record` — the "page
 * links on events" style (Settings → Page links; "auto" follows the file's
 * habit, see `detectPageMediaStyle`). The caller decides whether the style
 * applies; this only adds the pointer, and never a second one for a page the
 * record already links. */
export function linkPageMedia(record: GedNode, pageObjeXref: string | undefined, order: string[]): void {
  if (!pageObjeXref) return;
  if (childrenByTag(record, "OBJE").some((c) => c.value?.trim() === pageObjeXref)) return;
  insertOrdered(record, { level: record.level + 1, tag: "OBJE", value: pageObjeXref, children: [] }, order);
}

/** The citation nodes the UI counts: valueless `SOUR` children (an exporter
 *  writing only `3 TEXT …` under an empty citation) are invisible to the
 *  domain model — `resolveSourceCitation` drops them — so an index arriving
 *  from a rendered chip must skip them too, or Remove/Edit on the `n`th chip
 *  lands on the wrong node. Exported for the Edit view's own prefill. */
export function sourceCitationNodes(record: GedNode): GedNode[] {
  return childrenByTag(record, "SOUR").filter((c) => c.value?.trim());
}

/** Fields editable on an existing citation — `NewSourceFields` plus the
 * source's `PLAC` (not part of `NewSourceFields`; a new source gets it via
 * the site extras), the citation-local `page` and `quay`, and (when known) the specific
 * `OBJE` its resolved `url` came from, so a `url` edit retargets only that
 * page's file. `repoXref` is the source's `REPO` link: an xref sets it, `""`
 * removes it, and `undefined` leaves whatever the record has untouched;
 * `repoCaln` is that link's call number (`CALN`), same tri-state.
 * `repoCreateName` creates a brand-new `REPO` record with that name and links
 * the source to it — the dialog's "New repository" choice; wins over `repoXref`. */
export type EditSourceFields = NewSourceFields & {
  place?: string;
  /** The years the source covers; undefined leaves them as they are. */
  dateRange?: string;
  page?: string; quay?: string; objeXref?: string; repoXref?: string; repoCaln?: string; repoCreateName?: string;
  /** Read, never written: the record states its coverage in `DATA › EVEN`
   *  (see {@link statesCoverage}), so its place and years are standard. */
  statesCoverage?: boolean;
};

/** Create a top-level `REPO` record holding just a `NAME` — the manual "New
 * repository" path (a site-recognized repo gets its `WWW` via `createSiteRepo`). */
export function createRepoRecord(records: GedNode[], name: string): GedNode {
  const repo: GedNode = { level: 0, xref: nextXref(records, "R"), tag: "REPO", children: [] };
  repo.children.push({ level: 1, tag: "NAME", value: name.trim(), children: [] });
  insertRecord(records, repo);
  // A new top-level REPO stales the cached repo index (see cache.ts).
  bumpSourceCacheVersion(records);
  return repo;
}

/**
 * Update the `index`th `SOUR` citation on `node` (an event node, or a
 * top-level INDI/FAM record) in place. For a citation pointing at a shared
 * `SOUR` record, the bibliographic fields (title/author/.../note) are written
 * to that record — affecting every other citation of the same source, which
 * is correct since they describe the source itself, not this citation of it.
 * `page` and `quay` are citation-local. `url` retargets `fields.objeXref` (the specific
 * page image this citation resolved to) when known, the source's sole `OBJE`
 * when it has exactly one, or otherwise creates a new `OBJE` for this page —
 * never touching another page's file. For an inline (plain-text) citation,
 * only its own value/page can change (there's no shared record).
 */
export function updateSourceCitation(
  records: GedNode[],
  node: GedNode,
  index: number,
  fields: EditSourceFields,
  notes?: SharedNoteCtx,
  overrides?: Pick<FormatOverrides, "standard" | "writeVersion">,
): void {
  const citation = sourceCitationNodes(node)[index];
  if (!citation) return;

  const page = fields.page?.trim();
  removeChildren(citation, "PAGE");
  if (page) citation.children.push({ level: citation.level + 1, tag: "PAGE", value: page, children: [] });
  setCitationQuay(citation, fields.quay);

  const sourceXref = citation.value?.trim();
  if (!sourceXref || !isPointer(sourceXref)) {
    const title = fields.title?.trim();
    if (title) citation.value = title;
    return;
  }

  const sourceNode = records.find((r) => r.tag === "SOUR" && r.xref === sourceXref);
  if (!sourceNode) return;
  setSourceRecordFields(records, sourceNode, fields, notes, overrides);
}

/**
 * The tag a source record's flat date range is written with. A `DATE` on the
 * record itself is in neither 5.5.1 nor 7.0 (the standard states it in
 * `DATA › EVEN`), so a strict target format writes the extension `_DATE`; the
 * file's own format keeps the bare tag where the file already writes it, and
 * writes the extension otherwise.
 */
export function sourceFieldTag(records: GedNode[], tag: "DATE", overrides?: Pick<FormatOverrides, "standard">): string {
  if (overrides?.standard) return `_${tag}`;
  return memoOnContent(records, `sourceFieldTag:${tag}`, () =>
    records.some((r) => r.tag === "SOUR" && r.children.some((c) => c.tag === tag)) ? tag : `_${tag}`,
  );
}

/**
 * Whether a write keeps a source's `FILN` or `PERI` — GEDCOM 5.5-EL's filing
 * number and periodical, which neither 5.5.1 nor 7.0 has. Only a file kept
 * with its variations that already writes the tag (MacFamilyTree's habit)
 * keeps it; everywhere else the standard's own form is written instead: the
 * repository link's call number, and the title (see {@link settleSourceFields}).
 */
export function keepsSourceTag(records: GedNode[], tag: "FILN" | "PERI", overrides?: Pick<FormatOverrides, "standard">): boolean {
  if (overrides?.standard) return false;
  return memoOnContent(records, `keepsSourceTag:${tag}`, () =>
    records.some((r) => r.tag === "SOUR" && r.children.some((c) => c.tag === tag)),
  );
}

/** Whether a source states what it covers in the standard's `DATA › EVEN`,
 *  where its place and years are the standard's own lines. */
export function statesCoverage(rec: GedNode): boolean {
  const data = firstChild(rec, "DATA");
  return !!data && childrenByTag(data, "EVEN").length > 0;
}

/** Whether a write may put a source's place or years flat on the record,
 *  where neither version has them: only a file kept with its variations that
 *  already writes them so (MacFamilyTree's habit), never a strict target. */
export function keepsFlatCoverage(records: GedNode[], overrides?: Pick<FormatOverrides, "standard">): boolean {
  if (overrides?.standard) return false;
  return memoOnContent(records, "keepsFlatCoverage", () =>
    records.some((r) => r.tag === "SOUR" && r.children.some((c) => c.tag === "PLAC" || c.tag === "DATE" || c.tag === "_DATE")),
  );
}

/** Whether a write states the archive's id as the repository link's call
 *  number rather than as the source's own `FILN`: always where the standard's
 *  form is written, else as the file does (see `writesCallNumbers`). */
export function writesIdAsCallNumber(
  records: GedNode[],
  coverage?: "vendor" | "standard",
  overrides?: Pick<FormatOverrides, "standard">,
): boolean {
  return !keepsSourceTag(records, "FILN", overrides) || writesCallNumbers(records, coverage);
}

/** The version a source's standard forms are written in: the strict target's,
 *  else the file's own. */
export function sourceWriteVersion(overrides?: Pick<FormatOverrides, "standard" | "writeVersion">): "5.5.1" | "7.0" {
  return overrides?.standard ?? overrides?.writeVersion ?? "5.5.1";
}

/** A title with the periodical or collection it belongs to: `Title, Periodical`
 *  — the periodical alone without a title, the title alone where it already
 *  names it. */
export function titleWithPeriodical(title: string | undefined, periodical: string | undefined): string | undefined {
  const t = title?.trim() ?? "";
  const p = periodical?.trim() ?? "";
  if (!p) return t || undefined;
  if (!t) return p;
  return t.toLowerCase().includes(p.toLowerCase()) ? t : `${t}, ${p}`;
}

/**
 * Restate a source record's GEDCOM 5.5-EL fields in the standard's own form:
 *
 *  - `FILN`/`_FILN`, the archive's id for the source, becomes the call number
 *    (`CALN`) on its first repository link. A source kept in no recorded
 *    repository gets a link to none — 5.5.1 writes `REPO` without a pointer,
 *    7.0 points it at `@VOID@`, both for exactly this. A link already stating
 *    the number keeps its one line;
 *  - `PERI`/`_PERI`, the periodical or collection, joins the title (see
 *    {@link titleWithPeriodical}).
 *
 * A tag named in `keep` is the file's own habit: its `_` spelling becomes the
 * bare one instead. Returns the lines it settled — none when the record has
 * nothing to restate.
 */
export function settleSourceFields(
  rec: GedNode,
  version: "5.5.1" | "7.0",
  keep: { FILN?: boolean; PERI?: boolean } = {},
): GedNode[] {
  const settled: GedNode[] = [];
  for (const node of [...rec.children]) {
    const bare = node.tag.replace(/^_/, "");
    if (bare !== "FILN" && bare !== "PERI") continue;
    if (keep[bare]) {
      if (node.tag !== bare) {
        node.tag = bare;
        delete node.spelling;
        settled.push(node);
      }
      continue;
    }
    settled.push(node);
    const value = node.value?.trim();
    if (bare === "PERI") {
      const title = firstChild(rec, "TITL");
      if (!title) {
        // The periodical is the source's only name: the line becomes its title.
        node.tag = "TITL";
        delete node.spelling;
        continue;
      }
      title.value = titleWithPeriodical(title.value, value);
    } else if (value) {
      let link = firstChild(rec, "REPO");
      if (!link) {
        link = { level: rec.level + 1, tag: "REPO", value: version === "7.0" ? VOID_XREF : undefined, children: [] };
        insertGrouped(rec, link, ["CHAN", "CREA"]);
      }
      if (!childrenByTag(link, "CALN").some((c) => c.value?.trim() === value)) {
        link.children.push({ level: link.level + 1, tag: "CALN", value, children: [] });
      }
    }
    rec.children.splice(rec.children.indexOf(node), 1);
  }
  return settled;
}

/**
 * Write the bibliographic fields of a `SOUR` record itself — shared by
 * {@link updateSourceCitation} (which reaches the record through a citation)
 * and the Tools → Sources panel (which edits the record directly, no citation
 * involved). `page` and `quay` are citation-local and ignored here. `url` retargets
 * `fields.objeXref` (or the record's sole `OBJE`), or creates a new `OBJE`.
 */
export function setSourceRecordFields(
  records: GedNode[],
  sourceNode: GedNode,
  fields: EditSourceFields,
  notes?: SharedNoteCtx,
  overrides?: Pick<FormatOverrides, "standard" | "writeVersion">,
): void {
  // Read before any line is written: whether the file keeps its own filing
  // number and periodical lines, or the standard's forms are written.
  const keepFiln = keepsSourceTag(records, "FILN", overrides);
  const keepPeri = keepsSourceTag(records, "PERI", overrides);
  // A place or years with no `DATA › EVEN` to hold them would stand flat on
  // the record, which a strict target never adds.
  const keepFlat = !overrides?.standard;
  // The dialog displays one line per field — the first node of the tag — so a
  // save may only touch that node: a second NOTE the dialog never showed
  // survives, an unchanged value stays byte-identical (keeping its CONC wrap
  // positions), and a real edit rewrites the value in place so the node keeps
  // its children (a NOTE's PRIV flag, vendor sub-tags) and the position its
  // line already holds. A field the record gains is inserted ahead of the
  // trailing block, the same discipline the reshape's fillField keeps.
  const setChild = (tag: string, value: string | undefined) => {
    const existing = firstChild(sourceNode, tag);
    const trimmed = value?.trim();
    if (!trimmed) {
      if (existing) sourceNode.children = sourceNode.children.filter((c) => c !== existing);
      return;
    }
    if (existing) {
      if (existing.value?.trim() !== trimmed) existing.value = trimmed;
      return;
    }
    insertGrouped(sourceNode, { level: sourceNode.level + 1, tag, value: trimmed, children: [] }, SOUR_FIELD_TRAILING);
  };
  // A line that lives under either spelling (`DATE`/`_DATE`, a kept
  // `FILN`/`_FILN`); the one the record has is edited, under the tag the
  // target writes.
  const setExtension = (tag: "FILN" | "PERI" | "DATE", value: string | undefined) => {
    const want = tag === "DATE" ? sourceFieldTag(records, tag, overrides) : tag;
    const existing = sourceNode.children.find((c) => c.tag === tag || c.tag === `_${tag}`);
    if (existing && existing.tag !== want && value?.trim()) {
      existing.tag = want;
      delete existing.spelling;
    }
    setChild(existing?.tag ?? want, value);
  };
  // A standard-coverage record keeps place and agency inside `DATA` (AGNC on
  // DATA itself, PLAC on its EVEN blocks) — an edit lands where the value
  // lives instead of minting a second, flat copy beside it. The dialog shows
  // the first holder's value (the same rule the prefill reads by), so a save
  // touches only that holder — a sibling EVEN with its own PLAC keeps it.
  const data = firstChild(sourceNode, "DATA");
  const setCoverageAware = (tag: "AGNC" | "PLAC", value: string | undefined) => {
    // A strict target never adds a flat AGNC: the agency belongs in DATA.
    if (!data && tag === "AGNC" && overrides?.standard && value?.trim() && !firstChild(sourceNode, tag)) {
      insertGrouped(sourceNode, { level: sourceNode.level + 1, tag: "DATA", children: [{ level: sourceNode.level + 2, tag, value: value.trim(), children: [] }] }, SOUR_FIELD_TRAILING);
      return;
    }
    const flat = (v: string | undefined) => (tag === "PLAC" && !keepFlat && !firstChild(sourceNode, tag) ? undefined : setChild(tag, v));
    if (!data || firstChild(sourceNode, tag)) return flat(value);
    const holders = tag === "AGNC" ? [data] : childrenByTag(data, "EVEN");
    if (holders.length === 0) return flat(value);
    const holder = holders.find((h) => firstChild(h, tag)) ?? holders[0];
    const node = firstChild(holder, tag);
    const trimmed = value?.trim();
    if (node && trimmed) {
      if (node.value?.trim() !== trimmed) node.value = trimmed;
    } else if (node) {
      holder.children = holder.children.filter((c) => c !== node);
    } else if (trimmed) {
      holder.children.push({ level: holder.level + 1, tag, value: trimmed, children: [] });
    }
  };
  // The periodical: the file's own PERI where it keeps one, else part of the
  // title — a record still carrying the line has it folded in on this save.
  if (keepPeri) {
    setChild("TITL", fields.title);
    setExtension("PERI", fields.periodical);
  } else {
    setChild("TITL", titleWithPeriodical(fields.title, fields.periodical ?? periodicalOf(sourceNode)));
    sourceNode.children = sourceNode.children.filter((c) => c.tag !== "PERI" && c.tag !== "_PERI");
  }
  setChild("AUTH", fields.author);
  setChild("PUBL", fields.publisher);
  setCoverageAware("AGNC", fields.agency);
  setCoverageAware("PLAC", fields.place);
  // The archive's id: the file's own FILN where it keeps one, else the
  // repository link's call number, settled once the link is in place below.
  const pendingIds: string[] = [];
  if (keepFiln) {
    setExtension("FILN", fields.filingNumber);
  } else {
    const id = (fields.filingNumber !== undefined ? fields.filingNumber : filingNumberOf(sourceNode))?.trim();
    if (id) pendingIds.push(id);
    sourceNode.children = sourceNode.children.filter((c) => c.tag !== "FILN" && c.tag !== "_FILN");
  }
  // The years it covers: inside DATA › EVEN where the record states its
  // coverage there, else on the record itself — the line it has, or the one
  // the target writes (see `sourceFieldTag`).
  if (fields.dateRange !== undefined) {
    const flat = sourceNode.children.some((c) => c.tag === "DATE" || c.tag === "_DATE");
    const holders = data ? childrenByTag(data, "EVEN") : [];
    const holder = holders.find((h) => firstChild(h, "DATE")) ?? holders[0];
    const trimmed = fields.dateRange.trim();
    if (holder && !flat) {
      const node = firstChild(holder, "DATE");
      if (node && trimmed) node.value = trimmed;
      else if (node) holder.children = holder.children.filter((c) => c !== node);
      else if (trimmed) holder.children.unshift({ level: holder.level + 1, tag: "DATE", value: trimmed, children: [] });
    } else if (flat || keepFlat) {
      setExtension("DATE", trimmed);
    }
  }
  // A NOTE that points at a shared record is edited inside that record (the
  // dialog was prefilled with its resolved text); clearing it releases the
  // reference, deleting the record only once nothing else uses it.
  const noteNode = firstChild(sourceNode, "NOTE");
  const notePtr = noteNode?.value?.trim();
  if (noteNode && notePtr && isPointer(notePtr) && notes) {
    if (!fields.note?.trim()) {
      sourceNode.children = sourceNode.children.filter((c) => c !== noteNode);
      removeNoteRecordIfOrphaned(notes, notePtr);
    } else {
      setSharedNoteText(notes, notePtr, fields.note);
    }
  } else {
    setChild("NOTE", fields.note);
  }

  const repoCreateName = fields.repoCreateName?.trim();
  if (fields.repoXref !== undefined || repoCreateName) {
    const repoXref = repoCreateName ? createRepoRecord(records, repoCreateName).xref! : fields.repoXref?.trim() ?? "";
    const existingRepo = firstChild(sourceNode, "REPO");
    if (!repoXref) {
      removeChildren(sourceNode, "REPO");
      // The call number outlives the repository: the standard's form keeps it
      // on a link to no repository (see `settleSourceFields`).
      const caln = fields.repoCaln?.trim();
      if (!keepFiln && caln) pendingIds.push(caln);
    } else if (existingRepo) {
      existingRepo.value = repoXref;
    } else {
      insertGrouped(sourceNode, { level: sourceNode.level + 1, tag: "REPO", value: repoXref, children: [] }, ["CHAN", "CREA"]);
    }
    // The call number rides on the repository link itself (REPO > CALN). The
    // dialog shows the first CALN, so only that node is edited — in place, so
    // its own children (a `MEDI microfilm` medium) survive, and a second CALN
    // the dialog never showed is left alone.
    const repoLink = firstChild(sourceNode, "REPO");
    if (repoLink && fields.repoCaln !== undefined) {
      const caln = fields.repoCaln.trim();
      const calnNode = firstChild(repoLink, "CALN");
      if (calnNode && caln) {
        if (calnNode.value?.trim() !== caln) calnNode.value = caln;
      } else if (calnNode) {
        repoLink.children = repoLink.children.filter((c) => c !== calnNode);
      } else if (caln) {
        repoLink.children.push({ level: repoLink.level + 1, tag: "CALN", value: caln, children: [] });
      }
    }
    // Retargeting the source's REPO link changes which repository its
    // citations fall back to for a URL — resolved from the cached repo index,
    // so the cache must be rebuilt before the next rebuildIndividual.
    bumpSourceCacheVersion(records);
  }
  if (pendingIds.length) {
    for (const id of pendingIds) sourceNode.children.push({ level: sourceNode.level + 1, tag: "FILN", value: id, children: [] });
    settleSourceFields(sourceNode, sourceWriteVersion(overrides), { PERI: keepPeri });
  }

  const url = fields.url?.trim();
  const soleObjeXref = sourceNode.children.filter((c) => c.tag === "OBJE" && c.value).length === 1
    ? firstChild(sourceNode, "OBJE")?.value?.trim()
    : undefined;
  const objeXref = fields.objeXref ?? soleObjeXref;

  const objeNode = objeXref ? records.find((r) => r.tag === "OBJE" && r.xref === objeXref) : undefined;
  if (objeNode) {
    // The URL field edits the page's *link* — the OBJE's URL-bearing FILE. A
    // local scan (bare-filename FILE) is not what the dialog displayed, so
    // this field never overwrites, unlinks or prunes it.
    const files = objeNode.children.filter((c) => c.tag === "FILE" && c.value?.trim());
    const urlFile = files.find((c) => looksLikeUrl(c.value!.trim()));
    if (url && urlFile) {
      if (urlFile.value!.trim() !== url) {
        urlFile.value = url;
        bumpSourceCacheVersion(records);
      }
    } else if (url && files.length === 0) {
      const form = fileFormOf(url, prefersMimeForm(records));
      objeNode.children.unshift({
        level: objeNode.level + 1,
        tag: "FILE",
        value: url,
        children: form ? [{ level: objeNode.level + 2, tag: "FORM", value: form, children: [] }] : [],
      });
      bumpSourceCacheVersion(records);
    } else if (url) {
      // The linked OBJE holds only local files — the typed URL becomes its own
      // page OBJE beside it rather than clobbering a scan's filename.
      const obje = createMediaRecord(records, url);
      insertGrouped(
        sourceNode,
        { level: sourceNode.level + 1, tag: "OBJE", value: obje.xref, children: [] },
        SOUR_TRAILING_TAGS,
      );
    } else if (urlFile && files.length > 1) {
      // Cleared, but the OBJE also carries local files: drop just the URL line.
      objeNode.children = objeNode.children.filter((c) => c !== urlFile);
      bumpSourceCacheVersion(records);
    } else if (urlFile) {
      // Cleared: unlink this page's OBJE from the source, prune it if it's now orphaned.
      sourceNode.children = sourceNode.children.filter((c) => !(c.tag === "OBJE" && c.value?.trim() === objeXref));
      const stillReferenced = records.some((r) => r.tag === "SOUR" && r.children.some((c) => c.tag === "OBJE" && c.value?.trim() === objeXref));
      if (!stillReferenced) {
        const oi = records.findIndex((r) => r.tag === "OBJE" && r.xref === objeXref);
        if (oi !== -1) records.splice(oi, 1);
      }
      bumpSourceCacheVersion(records);
    }
  } else if (!objeXref && url) {
    const obje = createMediaRecord(records, url);
    insertGrouped(
      sourceNode,
      { level: sourceNode.level + 1, tag: "OBJE", value: obje.xref, children: [] },
      SOUR_TRAILING_TAGS,
    );
  }
}

/** The source fields a page lookup can still fill after the source was added.
 *  The place and years are not among them: a new source states those in the
 *  site's coverage block, which only the Add writes. */
export type CompletableSourceFields = Partial<Pick<EditSourceFields, "title" | "author" | "periodical" | "publisher" | "agency">>;

/**
 * The fields to save on a just-added `SOUR` record once a page lookup answers
 * after the Add, for {@link setSourceRecordFields}: each field takes its
 * `after` value only while the record still holds the `before` one it was
 * written with, so an edit made in the meantime wins. Undefined when nothing
 * would change — or the record is gone (the Add was undone).
 */
export function completedSourceFields(
  records: GedNode[],
  sourceXref: string,
  before: CompletableSourceFields,
  after: CompletableSourceFields,
): EditSourceFields | undefined {
  const sourceNode = records.find((r) => r.tag === "SOUR" && r.xref === sourceXref);
  if (!sourceNode) return undefined;
  const current = sourceRecordEditFields(records, sourceNode);
  const next: EditSourceFields = { ...current };
  let changed = false;
  for (const key of Object.keys(after) as (keyof CompletableSourceFields)[]) {
    const value = after[key]?.trim();
    if (!value || value === current[key] || (current[key] ?? "") !== (before[key]?.trim() ?? "")) continue;
    next[key] = value;
    changed = true;
  }
  return changed ? next : undefined;
}

/** Fields editable on a `REPO` record (Tools → Sources repository edit) —
 * the GEDCOM repository set: name, postal address (multi-line, `ADDR`+`CONT`),
 * phone, e-mail, web link and note. `undefined` leaves a field untouched,
 * `""` clears its line. */
export interface EditRepoFields {
  name?: string;
  addr?: string;
  phone?: string;
  email?: string;
  url?: string;
  note?: string;
}

/** GEDCOM's address-structure order, `NAME` first, trailing blocks last. */
const REPO_CHILD_ORDER = ["NAME", "ADDR", "PHON", "EMAIL", "FAX", "WWW", "NOTE", "REFN", "RIN", "CHAN", "CREA"];

/**
 * Write a `REPO` record's own fields. The address edits only the free-text
 * lines (`ADDR` value + `CONT`), leaving any structured sub-tags (`CITY`,
 * `CTRY`, …) the file already has in place; a pointer `NOTE` is edited inside
 * the shared record via `notes`, matching {@link setSourceRecordFields}.
 */
export function setRepoRecordFields(records: GedNode[], repoNode: GedNode, fields: EditRepoFields, notes?: SharedNoteCtx): void {
  const set = (tag: string, value: string | undefined) => {
    if (value === undefined) return;
    const trimmed = value.trim();
    const existing = firstChild(repoNode, tag);
    if (existing) {
      if (trimmed) existing.value = trimmed;
      else repoNode.children = repoNode.children.filter((c) => c !== existing);
    } else if (trimmed) {
      insertOrdered(repoNode, { level: repoNode.level + 1, tag, value: trimmed, children: [] }, REPO_CHILD_ORDER);
    }
  };
  set("NAME", fields.name);
  set("PHON", fields.phone);
  set("EMAIL", fields.email);
  set("WWW", fields.url);

  if (fields.addr !== undefined) {
    const lines = fields.addr.split("\n").map((s) => s.trim()).filter(Boolean);
    let addrNode = firstChild(repoNode, "ADDR");
    if (lines.length === 0) {
      if (addrNode) {
        addrNode.value = undefined;
        removeChildren(addrNode, "CONT");
        if (addrNode.children.length === 0) repoNode.children = repoNode.children.filter((c) => c !== addrNode);
      }
    } else {
      if (!addrNode) {
        addrNode = { level: repoNode.level + 1, tag: "ADDR", children: [] };
        insertOrdered(repoNode, addrNode, REPO_CHILD_ORDER);
      }
      addrNode.value = lines[0];
      addrNode.children = [
        ...lines.slice(1).map((l) => ({ level: addrNode!.level + 1, tag: "CONT", value: l, children: [] })),
        ...addrNode.children.filter((c) => c.tag !== "CONT"),
      ];
    }
  }

  if (fields.note !== undefined) {
    const noteNode = firstChild(repoNode, "NOTE");
    const notePtr = noteNode?.value?.trim();
    if (noteNode && notePtr && isPointer(notePtr) && notes) {
      if (!fields.note.trim()) {
        repoNode.children = repoNode.children.filter((c) => c !== noteNode);
        removeNoteRecordIfOrphaned(notes, notePtr);
      } else {
        setSharedNoteText(notes, notePtr, fields.note);
      }
    } else {
      set("NOTE", fields.note);
    }
  }
  // The cached repo index is a *snapshot* of each REPO's NAME/WWW (unlike the
  // source index, which holds live nodes), so editing a repository's fields
  // stales it — without this, citations kept resolving their repo-fallback
  // URL against the pre-edit snapshot for the rest of the session.
  bumpSourceCacheVersion(records);
}

/** Prefill for the repository editor — the same fields {@link setRepoRecordFields}
 * writes, with a pointer `NOTE` resolved to the shared record's text and the
 * address joined from its `ADDR`+`CONT` lines. Missing fields come back `""`
 * so a save writes exactly what the dialog showed. */
export function repoRecordEditFields(records: GedNode[], repoNode: GedNode): EditRepoFields {
  const text = (tag: string) => firstChild(repoNode, tag)?.value?.trim() || "";
  const addrNode = firstChild(repoNode, "ADDR");
  const addr = addrNode
    ? [addrNode.value?.trim(), ...childrenByTag(addrNode, "CONT").map((c) => c.value?.trim())].filter(Boolean).join("\n")
    : "";
  const noteVal = text("NOTE");
  return {
    name: text("NAME"),
    addr,
    phone: text("PHON"),
    email: text("EMAIL"),
    url: text("WWW"),
    note: noteVal && isPointer(noteVal) ? getMediaAndSourceCtx(records).noteIndex.get(noteVal)?.text.trim() ?? "" : noteVal,
  };
}

/**
 * Prefill for editing a `SOUR` record on its own (Tools → Sources) — the
 * record's bibliographic fields, plus (when it has exactly one page image)
 * that `OBJE`'s URL so a link edit retargets it, the same sole-OBJE rule
 * {@link setSourceRecordFields} applies on save. A pointer `NOTE` prefills
 * with the shared record's resolved text, matching the Edit view's dialog.
 */
export function sourceRecordEditFields(records: GedNode[], sourceNode: GedNode): EditSourceFields {
  const text = (tag: string) => firstChild(sourceNode, tag)?.value?.trim() || undefined;
  // Standard-coverage records state place/agency inside DATA — prefill from
  // there when the flat field is absent, matching where a save writes back.
  const data = firstChild(sourceNode, "DATA");
  const coveredPlace = data
    ? childrenByTag(data, "EVEN")
        .map((e) => firstChild(e, "PLAC")?.value?.trim())
        .find(Boolean)
    : undefined;
  const coveredAgency = data ? firstChild(data, "AGNC")?.value?.trim() || undefined : undefined;
  const coveredDate = data
    ? childrenByTag(data, "EVEN")
        .map((e) => firstChild(e, "DATE")?.value?.trim())
        .find(Boolean)
    : undefined;
  const objeChildren = childrenByTag(sourceNode, "OBJE").filter((c) => c.value);
  const objeXref = objeChildren.length === 1 ? objeChildren[0].value!.trim() : undefined;
  const objeNode = objeXref ? records.find((r) => r.tag === "OBJE" && r.xref === objeXref) : undefined;
  // The URL field shows the OBJE's URL-bearing FILE — the same line a save
  // edits — never a local scan's filename (whatever FILE happens to be first).
  const objeUrl = objeNode?.children
    .find((c) => c.tag === "FILE" && c.value && looksLikeUrl(c.value.trim()))
    ?.value?.trim();
  const noteVal = text("NOTE");
  return {
    statesCoverage: statesCoverage(sourceNode),
    title: text("TITL"),
    author: text("AUTH"),
    periodical: periodicalOf(sourceNode),
    publisher: text("PUBL"),
    agency: text("AGNC") ?? coveredAgency,
    place: text("PLAC") ?? coveredPlace,
    dateRange: text("DATE") ?? text("_DATE") ?? coveredDate,
    filingNumber: filingNumberOf(sourceNode),
    note: noteVal && isPointer(noteVal) ? getMediaAndSourceCtx(records).noteIndex.get(noteVal)?.text.trim() : noteVal,
    url: objeUrl,
    objeXref,
    // "" (not undefined) when there is no REPO link: the dialog's dropdown
    // shows the explicit no-repository choice and a save writes it back as-is.
    // A link to no repository (7.0's `@VOID@`) is the same no-repository
    // choice: the call number it carries is shown on its own.
    repoXref: (() => {
      const repo = text("REPO");
      return repo && repo.toUpperCase() !== VOID_XREF ? repo : "";
    })(),
    repoCaln: (() => {
      const repoLink = firstChild(sourceNode, "REPO");
      return repoLink ? firstChild(repoLink, "CALN")?.value?.trim() ?? "" : "";
    })(),
  };
}

/**
 * Remove the `index`th `SOUR` citation from `record` (an event node, or a
 * top-level INDI/FAM record), then delete the cited `SOUR`/`OBJE` records if
 * nothing else in the dataset still references them.
 *
 * The citation's page image goes with it: in the "on events" page-media style
 * an added citation also links its page's `OBJE` beside itself on the same
 * node, and that pointer left behind would both keep the `OBJE` record alive
 * through the prune and linger as a read-only link chip with no way to remove
 * it. Only the removed citation's own page image is unlinked (resolved the
 * same way the edit dialog resolves it — by xref, or by the page's URL, which
 * also sweeps a duplicate `OBJE` for the same page left by an earlier
 * remove-without-unlink), and only if no remaining citation on the node still
 * resolves to it — media the user attached independently of any citation is
 * untouched. An `OBJE` record only those swept pointers referenced is deleted
 * along with them.
 */
export function removeSourceCitationAtIndex(dataset: Dataset, record: GedNode, index: number): void {
  const node = sourceCitationNodes(record)[index];
  if (!node) return;
  const { media, sourceCtx } = getMediaAndSourceCtx(dataset.records);
  const resolved = resolveSourceCitation(node, sourceCtx);
  const pageObjeXref = resolved?.objeXref;
  // `exact` means the url came from a page OBJE (not the repository fallback).
  const pageUrlKey = resolved?.exact && resolved.url ? linkKey(resolved.url) : undefined;
  const i = record.children.indexOf(node);
  if (i !== -1) record.children.splice(i, 1);

  const claimed = new Set(
    sourceCitationNodes(record)
      .map((c) => resolveSourceCitation(c, sourceCtx)?.objeXref)
      .filter(Boolean),
  );
  const isPageLink = (c: GedNode) => {
    if (c.tag !== "OBJE" || !c.value?.trim()) return false;
    const xref = c.value.trim();
    if (claimed.has(xref)) return false;
    if (xref === pageObjeXref) return true;
    if (!pageUrlKey) return false;
    return (media.get(xref) ?? []).some((u) => linkKey(u) === pageUrlKey);
  };
  const sweptXrefs = new Set(record.children.filter(isPageLink).map((c) => c.value!.trim()));
  if (sweptXrefs.size) record.children = record.children.filter((c) => !isPageLink(c));

  const sourceXref = node.value?.trim();
  if (sourceXref) pruneUnreferencedSource(dataset, sourceXref);

  // Delete swept OBJE records nothing else references (a page OBJE that is a
  // child of the pruned source is already gone via the prune's own cascade;
  // this catches the duplicate-orphan one that hangs off no source).
  const stillReferenced = referencedObjeXrefs(dataset.records, sweptXrefs);
  let pruned = false;
  for (const objeXref of sweptXrefs) {
    if (stillReferenced.has(objeXref)) continue;
    const oi = dataset.records.findIndex((r) => r.tag === "OBJE" && r.xref === objeXref);
    if (oi !== -1) {
      dataset.records.splice(oi, 1);
      pruned = true;
    }
  }
  if (pruned) bumpSourceCacheVersion(dataset.records);
}

/**
 * Delete the top-level `SOUR` record `sourceXref` (and any `OBJE` record it
 * alone referenced) if no citation anywhere in the dataset still points at it.
 */
export function pruneUnreferencedSource(dataset: Dataset, sourceXref: string): void {
  const stack: GedNode[] = [...dataset.records];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.tag === "SOUR" && !node.xref && node.value?.trim() === sourceXref) return; // still cited
    for (const child of node.children) stack.push(child);
  }

  const sourceIndex = dataset.records.findIndex((r) => r.tag === "SOUR" && r.xref === sourceXref);
  if (sourceIndex === -1) return;
  const objeXrefs = dataset.records[sourceIndex].children
    .filter((c) => c.tag === "OBJE" && c.value)
    .map((c) => c.value!.trim());
  dataset.records.splice(sourceIndex, 1);

  // Cascade-prune the source's page images — but only those nothing else
  // references, checked against the *whole* tree in one pass: a shared photo
  // that's also attached to a person or another source must survive (the same
  // rule as `pruneUnreferencedMedia`).
  const stillReferenced = referencedObjeXrefs(dataset.records, new Set(objeXrefs));
  for (const objeXref of objeXrefs) {
    if (stillReferenced.has(objeXref)) continue;
    const oi = dataset.records.findIndex((r) => r.tag === "OBJE" && r.xref === objeXref);
    if (oi !== -1) dataset.records.splice(oi, 1);
  }
  bumpSourceCacheVersion(dataset.records);
}

/**
 * Move a source record's own `AGNC` (no version allows it there) to
 * `DATA.AGNC`, the agency responsible for the source's data. `DATA` holds one
 * `AGNC`: a value equal to the one already there is dropped as a copy, a
 * different one stays for the user to settle. Returns the lines it moved or
 * dropped — none when the record has nothing to move.
 */
export function hangAgencyUnderData(rec: GedNode): GedNode[] {
  const flat = childrenByTag(rec, "AGNC");
  if (flat.length === 0) return [];
  let data = firstChild(rec, "DATA");
  const settled: GedNode[] = [];
  for (const agnc of flat) {
    const held = data && firstChild(data, "AGNC");
    if (held && held.value?.trim() !== agnc.value?.trim()) continue;
    rec.children.splice(rec.children.indexOf(agnc), 1);
    settled.push(agnc);
    if (held) continue;
    if (!data) {
      data = { level: rec.level + 1, tag: "DATA", children: [] };
      insertGrouped(rec, data, SOUR_FIELD_TRAILING);
    }
    relevel(agnc, data.level + 1);
    data.children.push(agnc);
  }
  return settled;
}
