import { isPointer, objeInfoOf } from "../source";
import { childrenByTag, firstChild } from "../node";
import type { Dataset, GedNode } from "../types";
import { insertGrouped, insertOrdered, insertRecord, nextXref } from "./shared";

/** Trailing block of a `SOUR` record a new `OBJE` link must stay ahead of. */
const SOUR_TRAILING_TAGS = ["REPO", "CHAN", "CREA"] as const;
import { bumpSourceCacheVersion, getMediaAndSourceCtx } from "./cache";
import { createMediaRecord, referencedObjeXrefs } from "./media";
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
export function createSourceRecord(records: GedNode[], fields: NewSourceFields): GedNode {
  const raw: GedNode = { level: 0, xref: nextXref(records, "S"), tag: "SOUR", children: [] };
  const push = (tag: string, value: string | undefined) => {
    if (value) raw.children.push({ level: 1, tag, value, children: [] });
  };
  push("TITL", fields.title);
  push("AUTH", fields.author);
  push("PERI", fields.periodical);
  push("PUBL", fields.publisher);
  push("AGNC", fields.agency);
  push("FILN", fields.filingNumber);
  push("NOTE", fields.note);
  insertRecord(records, raw);
  bumpSourceCacheVersion(records);
  if (fields.url) {
    const obje = createMediaRecord(records, fields.url);
    raw.children.push({ level: 1, tag: "OBJE", value: obje.xref, children: [] });
  }
  return raw;
}

/** Add a new `OBJE` (linking `url`, optionally titled) to an already-existing
 * `SOUR` record — a new page of a paginated source that's already cited elsewhere. */
export function addObjeToSource(records: GedNode[], sourceXref: string, url: string, title?: string): GedNode {
  const obje = createMediaRecord(records, url, title);
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

/** Attach a `SOUR` citation pointer (with optional `PAGE`) to `record` — an
 * event node, or a top-level INDI/FAM record — in canonical field order. */
export function attachSourceCitation(record: GedNode, sourceXref: string, page: string | undefined, order: string[]): void {
  const citation: GedNode = { level: record.level + 1, tag: "SOUR", value: sourceXref, children: [] };
  if (page) citation.children.push({ level: record.level + 2, tag: "PAGE", value: page, children: [] });
  insertOrdered(record, citation, order);
}

function sourceCitationNodes(record: GedNode): GedNode[] {
  return childrenByTag(record, "SOUR");
}

/** Fields editable on an existing citation — `NewSourceFields` plus the
 * source's `PLAC` (not part of `NewSourceFields`; a new source gets it via
 * the site extras), the citation-local `page` and (when known) the specific
 * `OBJE` its resolved `url` came from, so a `url` edit retargets only that
 * page's file. `repoXref` is the source's `REPO` link: an xref sets it, `""`
 * removes it, and `undefined` leaves whatever the record has untouched. */
export type EditSourceFields = NewSourceFields & { place?: string; page?: string; objeXref?: string; repoXref?: string };

/**
 * Update the `index`th `SOUR` citation on `node` (an event node, or a
 * top-level INDI/FAM record) in place. For a citation pointing at a shared
 * `SOUR` record, the bibliographic fields (title/author/.../note) are written
 * to that record — affecting every other citation of the same source, which
 * is correct since they describe the source itself, not this citation of it.
 * `page` is citation-local. `url` retargets `fields.objeXref` (the specific
 * page image this citation resolved to) when known, the source's sole `OBJE`
 * when it has exactly one, or otherwise creates a new `OBJE` for this page —
 * never touching another page's file. For an inline (plain-text) citation,
 * only its own value/page can change (there's no shared record).
 */
export function updateSourceCitation(records: GedNode[], node: GedNode, index: number, fields: EditSourceFields, notes?: SharedNoteCtx): void {
  const citation = sourceCitationNodes(node)[index];
  if (!citation) return;

  const page = fields.page?.trim();
  citation.children = citation.children.filter((c) => c.tag !== "PAGE");
  if (page) citation.children.push({ level: citation.level + 1, tag: "PAGE", value: page, children: [] });

  const sourceXref = citation.value?.trim();
  if (!sourceXref || !isPointer(sourceXref)) {
    const title = fields.title?.trim();
    if (title) citation.value = title;
    return;
  }

  const sourceNode = records.find((r) => r.tag === "SOUR" && r.xref === sourceXref);
  if (!sourceNode) return;
  setSourceRecordFields(records, sourceNode, fields, notes);
}

/**
 * Write the bibliographic fields of a `SOUR` record itself — shared by
 * {@link updateSourceCitation} (which reaches the record through a citation)
 * and the Tools → Sources panel (which edits the record directly, no citation
 * involved). `page` is citation-local and ignored here. `url` retargets
 * `fields.objeXref` (or the record's sole `OBJE`), or creates a new `OBJE`.
 */
export function setSourceRecordFields(records: GedNode[], sourceNode: GedNode, fields: EditSourceFields, notes?: SharedNoteCtx): void {
  const setChild = (tag: string, value: string | undefined) => {
    sourceNode.children = sourceNode.children.filter((c) => c.tag !== tag);
    const trimmed = value?.trim();
    if (trimmed) sourceNode.children.push({ level: sourceNode.level + 1, tag, value: trimmed, children: [] });
  };
  setChild("TITL", fields.title);
  setChild("AUTH", fields.author);
  setChild("PERI", fields.periodical);
  setChild("PUBL", fields.publisher);
  setChild("AGNC", fields.agency);
  setChild("PLAC", fields.place);
  setChild("FILN", fields.filingNumber);
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

  if (fields.repoXref !== undefined) {
    const repoXref = fields.repoXref.trim();
    const existingRepo = sourceNode.children.find((c) => c.tag === "REPO");
    if (!repoXref) {
      sourceNode.children = sourceNode.children.filter((c) => c.tag !== "REPO");
    } else if (existingRepo) {
      existingRepo.value = repoXref;
    } else {
      insertGrouped(sourceNode, { level: sourceNode.level + 1, tag: "REPO", value: repoXref, children: [] }, ["CHAN", "CREA"]);
    }
  }

  const url = fields.url?.trim();
  const soleObjeXref = sourceNode.children.filter((c) => c.tag === "OBJE" && c.value).length === 1
    ? firstChild(sourceNode, "OBJE")?.value?.trim()
    : undefined;
  const objeXref = fields.objeXref ?? soleObjeXref;

  if (objeXref) {
    const objeNode = records.find((r) => r.tag === "OBJE" && r.xref === objeXref);
    if (objeNode && url) {
      const fileChild = firstChild(objeNode, "FILE");
      if (fileChild) fileChild.value = url;
      else objeNode.children.unshift({ level: objeNode.level + 1, tag: "FILE", value: url, children: [] });
      bumpSourceCacheVersion(records);
    } else if (objeNode && !url) {
      // Cleared: unlink this page's OBJE from the source, prune it if it's now orphaned.
      sourceNode.children = sourceNode.children.filter((c) => !(c.tag === "OBJE" && c.value?.trim() === objeXref));
      const stillReferenced = records.some((r) => r.tag === "SOUR" && r.children.some((c) => c.tag === "OBJE" && c.value?.trim() === objeXref));
      if (!stillReferenced) {
        const oi = records.findIndex((r) => r.tag === "OBJE" && r.xref === objeXref);
        if (oi !== -1) records.splice(oi, 1);
      }
      bumpSourceCacheVersion(records);
    }
  } else if (url) {
    const obje = createMediaRecord(records, url);
    insertGrouped(
      sourceNode,
      { level: sourceNode.level + 1, tag: "OBJE", value: obje.xref, children: [] },
      SOUR_TRAILING_TAGS,
    );
  }
}

/**
 * Write a `REPO` record's own fields (Tools → Sources repository edit).
 * A cleared field removes its line; `NAME` stays the first child and `WWW`
 * follows it, the shape the site-repo creator writes.
 */
export function setRepoRecordFields(repoNode: GedNode, fields: { name?: string; url?: string }): void {
  const set = (tag: string, value: string | undefined, position: number) => {
    const trimmed = value?.trim();
    const existing = repoNode.children.find((c) => c.tag === tag);
    if (existing) {
      if (trimmed) existing.value = trimmed;
      else repoNode.children = repoNode.children.filter((c) => c !== existing);
    } else if (trimmed) {
      repoNode.children.splice(position, 0, { level: repoNode.level + 1, tag, value: trimmed, children: [] });
    }
  };
  set("NAME", fields.name, 0);
  set("WWW", fields.url, repoNode.children.findIndex((c) => c.tag === "NAME") + 1);
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
  const objeChildren = childrenByTag(sourceNode, "OBJE").filter((c) => c.value);
  const objeXref = objeChildren.length === 1 ? objeChildren[0].value!.trim() : undefined;
  const objeNode = objeXref ? records.find((r) => r.tag === "OBJE" && r.xref === objeXref) : undefined;
  const noteVal = text("NOTE");
  return {
    title: text("TITL"),
    author: text("AUTH"),
    periodical: text("PERI"),
    publisher: text("PUBL"),
    agency: text("AGNC"),
    place: text("PLAC"),
    filingNumber: text("FILN"),
    note: noteVal && isPointer(noteVal) ? getMediaAndSourceCtx(records).noteIndex.get(noteVal)?.text.trim() : noteVal,
    url: objeNode ? objeInfoOf(objeNode).url : undefined,
    objeXref,
    // "" (not undefined) when there is no REPO link: the dialog's dropdown
    // shows the explicit no-repository choice and a save writes it back as-is.
    repoXref: text("REPO") ?? "",
  };
}

/**
 * Remove the `index`th `SOUR` citation from `record` (an event node, or a
 * top-level INDI/FAM record), then delete the cited `SOUR`/`OBJE` records if
 * nothing else in the dataset still references them.
 */
export function removeSourceCitationAtIndex(dataset: Dataset, record: GedNode, index: number): void {
  const node = sourceCitationNodes(record)[index];
  if (!node) return;
  const i = record.children.indexOf(node);
  if (i !== -1) record.children.splice(i, 1);
  const sourceXref = node.value?.trim();
  if (sourceXref) pruneUnreferencedSource(dataset, sourceXref);
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
