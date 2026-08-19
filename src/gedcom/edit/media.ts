import { clearObjeNodeCache, isPointer, objeInfoOf, type CropRegion } from "../source";
import { childrenByTag, firstChild, removeChildren } from "../node";
import { mediaContainerOf, type MediaAddress } from "../media";
import type { Dataset, GedNode } from "../types";
import { FAM_CHILD_ORDER, INDI_CHILD_ORDER, insertOrdered, insertRecord, nextXref } from "./shared";
import { bumpSourceCacheVersion, getMediaAndSourceCtx } from "./cache";
import { linkKey } from "../../normalize/links";

/** The `FORM` value for a `FILE` — the extension's own token where the name
 *  carries one, `htm` for a web page. Undefined for an extensionless local
 *  file, whose format nothing states. */
function fileFormOf(file: string): string | undefined {
  const ext = /\.(jpe?g|png|gif|tiff?|bmp|pdf|wav|mp[34]|webp)(?:[?#]|$)/i.exec(file)?.[1].toLowerCase();
  if (ext) return ext === "jpeg" ? "jpg" : ext === "tif" ? "tiff" : ext;
  return /^https?:\/\//i.test(file) ? "htm" : undefined;
}

/** Whether the file's own media records state their `FILE`'s `FORM` — the
 *  spec asks for one, so only a file whose habit is clearly FORM-less (the
 *  majority of its FILEs bare) keeps new media bare too. */
function prefersFileForm(records: GedNode[]): boolean {
  let withForm = 0;
  let without = 0;
  for (const rec of records) {
    if (rec.tag !== "OBJE" || !rec.xref) continue;
    for (const file of childrenByTag(rec, "FILE")) {
      if (firstChild(file, "FORM")) withForm++;
      else without++;
    }
  }
  return withForm >= without;
}

/** Create a new top-level `OBJE` record whose `FILE` is `url`/`file` (with an
 * optional `TITL`), and add it to `records`. The `FILE` carries the `FORM`
 * the spec asks for, unless the file's own habit is to omit it. */
export function createMediaRecord(records: GedNode[], url: string, title?: string): GedNode {
  const fileNode: GedNode = { level: 1, tag: "FILE", value: url, children: [] };
  const form = prefersFileForm(records) ? fileFormOf(url) : undefined;
  if (form) fileNode.children.push({ level: 2, tag: "FORM", value: form, children: [] });
  const raw: GedNode = {
    level: 0,
    xref: nextXref(records, "O"),
    tag: "OBJE",
    children: [fileNode],
  };
  const trimmedTitle = title?.trim();
  if (trimmedTitle) raw.children.push({ level: 1, tag: "TITL", value: trimmedTitle, children: [] });
  insertRecord(records, raw);
  bumpSourceCacheVersion(records);
  clearObjeNodeCache(records);
  return raw;
}

// ── Record media (OBJE) ─────────────────────────────────────────────────────
//
// Edit-mode helpers for attaching/removing/reordering a record's media — the
// record is a person (`INDI`) or a family (`FAM`). The inline-vs-shared choice
// (whether to write an inline `1 OBJE`/`2 FILE` block or a `1 OBJE @O@` pointer
// to a top-level record) is the caller's, driven by the main file's detected
// `MediaMode`; these helpers just realize whichever the caller picks.

/** Build an `OBJE` node (a `FILE` plus an optional `TITL`) at `level`. */
function buildObjeNode(level: number, file: string, title?: string): GedNode {
  const node: GedNode = { level, tag: "OBJE", children: [{ level: level + 1, tag: "FILE", value: file, children: [] }] };
  const trimmedTitle = title?.trim();
  if (trimmedTitle) node.children.push({ level: level + 1, tag: "TITL", value: trimmedTitle, children: [] });
  return node;
}

/** The first top-level shared `OBJE` whose `FILE` equals `file` (case-insensitive),
 * so adding a photo already on file reuses its record instead of duplicating it. */
export function findSharedMediaByFile(records: GedNode[], file: string): GedNode | undefined {
  const target = file.trim().toLowerCase();
  if (!target) return undefined;
  for (const rec of records) {
    if (rec.tag !== "OBJE" || !rec.xref) continue;
    const f = firstChild(rec, "FILE")?.value?.trim().toLowerCase();
    if (f === target) return rec;
  }
  return undefined;
}

/** Append a new `OBJE` node after the record's last existing `OBJE` (so a
 * just-added photo is reliably last among the photos, regardless of where the
 * existing ones sit in the record), or at the canonical position if it's the
 * first. Mirrors `addEventNode`'s "after the last same-tag node" placement. */
function appendMediaNode(raw: GedNode, node: GedNode): GedNode {
  const objes = childrenByTag(raw, "OBJE");
  if (objes.length > 0) {
    const lastIdx = raw.children.indexOf(objes[objes.length - 1]);
    raw.children.splice(lastIdx + 1, 0, node);
  } else {
    insertOrdered(raw, node, raw.tag === "FAM" ? FAM_CHILD_ORDER : INDI_CHILD_ORDER);
  }
  return node;
}

/** Add an inline `1 OBJE`/`2 FILE` photo block to an `INDI`/`FAM` record (inline mode). */
export function attachInlineMedia(raw: GedNode, file: string, title?: string): GedNode {
  return appendMediaNode(raw, buildObjeNode(raw.level + 1, file, title));
}

/** Add a `1 OBJE @O@` pointer to a top-level shared media record (shared mode). */
export function attachMediaPointer(raw: GedNode, objeXref: string): GedNode {
  return appendMediaNode(raw, { level: raw.level + 1, tag: "OBJE", value: objeXref, children: [] });
}

/**
 * Remove the `OBJE` at `addr` from a record — on the record itself or under
 * one of its events (see {@link MediaAddress}). If it was a pointer to a
 * top-level shared record, prune that record when nothing else in the dataset
 * still references it.
 */
export function removeMediaAt(dataset: Dataset, raw: GedNode, addr: MediaAddress): void {
  const container = mediaContainerOf(raw, addr);
  const node = container && childrenByTag(container, "OBJE")[addr.objeIndex];
  if (!container || !node) return;
  const i = container.children.indexOf(node);
  if (i !== -1) container.children.splice(i, 1);
  const ptr = node.value?.trim();
  if (ptr && isPointer(ptr)) pruneUnreferencedMedia(dataset, ptr);
}

/**
 * Remove `container`'s own direct `OBJE` children (pointer or inline) whose
 * media resolves to `url` — the removal behind a media-link chip (see
 * GedEvent.mediaLinks). Every matching child goes (duplicates left by older
 * versions included), and a pointed-to shared record nothing else references
 * is pruned along with its last pointer.
 */
export function removeMediaLinkByUrl(dataset: Dataset, container: GedNode, url: string): void {
  const key = linkKey(url);
  const { media } = getMediaAndSourceCtx(dataset.records);
  const matches = (c: GedNode) => {
    if (c.tag !== "OBJE") return false;
    const v = c.value?.trim();
    if (v && isPointer(v)) return (media.get(v) ?? []).some((u) => linkKey(u) === key);
    const inlineUrl = objeInfoOf(c).url;
    return !!inlineUrl && linkKey(inlineUrl) === key;
  };
  const removedPtrs = container.children
    .filter((c) => !!c.value && isPointer(c.value.trim()) && matches(c))
    .map((c) => c.value!.trim());
  container.children = container.children.filter((c) => !matches(c));
  for (const ptr of new Set(removedPtrs)) pruneUnreferencedMedia(dataset, ptr);
}

/**
 * Rewrite the URL behind `container`'s media link `oldUrl` (see
 * GedEvent.mediaLinks) to `newUrl` — on the pointed-to shared record's
 * matching `FILE` line (a shared-record edit, visible from every referrer,
 * the same semantics as editing a source's fields), or on an inline `OBJE`
 * child's own `FILE`. Only the first matching link is rewritten — one chip
 * stands for one link.
 */
export function setMediaLinkUrl(dataset: Dataset, container: GedNode, oldUrl: string, newUrl: string): void {
  const key = linkKey(oldUrl);
  for (const c of container.children) {
    if (c.tag !== "OBJE") continue;
    const v = c.value?.trim();
    const target = v && isPointer(v) ? dataset.records.find((r) => r.tag === "OBJE" && r.xref === v) : c;
    if (!target) continue;
    // A CONT-wrapped FILE value carries a line break that is a wrap artifact,
    // not content (see collectLinks) — strip it for the comparison.
    const file = childrenByTag(target, "FILE").find(
      (f) => f.value && linkKey(f.value.trim().replace(/\n/g, "")) === key,
    );
    if (!file) continue;
    file.value = newUrl;
    bumpSourceCacheVersion(dataset.records); // an OBJE's FILE changed in place
    return;
  }
}

/**
 * Move a record's `OBJE` child from position `from` to `to` (0-based among
 * its `OBJE` children), leaving every non-`OBJE` child in place — so a tray
 * reorder doesn't disturb the rest of the record's field order.
 */
export function reorderMedia(raw: GedNode, from: number, to: number): void {
  const slots = raw.children.map((c, i) => (c.tag === "OBJE" ? i : -1)).filter((i) => i >= 0);
  const objes = slots.map((i) => raw.children[i]);
  if (from === to || from < 0 || to < 0 || from >= objes.length || to >= objes.length) return;
  const [moved] = objes.splice(from, 1);
  objes.splice(to, 0, moved);
  slots.forEach((slotIdx, k) => { raw.children[slotIdx] = objes[k]; });
}

/** Editable descriptive fields of a photo (`OBJE`). Each maps to a sub-tag;
 *  an empty/blank value removes that tag. `undefined` leaves it unchanged. */
export interface MediaInfoFields {
  /** Caption — `TITL`. */
  title?: string;
  /** The date the media depicts — `DATE`. */
  date?: string;
  /** Place depicted — `PLAC`. */
  place?: string;
  /** Free-text description — `_DSCR` (the `NOTE` fallback is dropped). */
  description?: string;
}

/**
 * Write a photo's descriptive fields onto its `OBJE` node — either an inline
 * block or a shared top-level record. `TITL`/`DATE`/`PLAC` are normalized to the
 * `OBJE` level (any `TITL` nested on the `FILE` child is removed so it can't go
 * stale), and `description` is stored as `_DSCR` (dropping a `NOTE` that
 * `objeInfoOf` would otherwise read as the description). Blank values clear the
 * tag; omitted fields are left untouched.
 */
export function setMediaInfo(objeNode: GedNode, fields: MediaInfoFields): void {
  const fileNode = firstChild(objeNode, "FILE");
  const set = (tag: string, value: string) => {
    objeNode.children = objeNode.children.filter((c) => c.tag !== tag);
    if (fileNode) fileNode.children = fileNode.children.filter((c) => c.tag !== tag);
    const v = value.trim();
    if (v) objeNode.children.push({ level: objeNode.level + 1, tag, value: v, children: [] });
  };
  if (fields.title !== undefined) set("TITL", fields.title);
  if (fields.date !== undefined) set("DATE", fields.date);
  if (fields.place !== undefined) set("PLAC", fields.place);
  if (fields.description !== undefined) {
    // Only an *inline* NOTE is the legacy description home — a `NOTE @N1@`
    // pointer is a shared note in its own right (not shown as the
    // description) and must survive a description edit.
    const isSharedNote = (c: GedNode) => c.tag === "NOTE" && !!c.value && isPointer(c.value.trim());
    objeNode.children = objeNode.children.filter((c) => (c.tag !== "_DSCR" && c.tag !== "NOTE") || isSharedNote(c));
    const v = fields.description.trim();
    if (v) objeNode.children.push({ level: objeNode.level + 1, tag: "_DSCR", value: v, children: [] });
  }
}

/**
 * Write (or clear, with `null`) the GEDCOM 7 `CROP` region on an `OBJE` *link*
 * node — the rectangle of a group photo that depicts the linking record. It
 * lives on the link, not the shared media record, so two people can mark
 * different regions of the same image. Values are rounded to integers per the
 * spec; zero `TOP`/`LEFT` are written explicitly so the region is unambiguous.
 */
export function setCropRegion(linkNode: GedNode, crop: CropRegion | null): void {
  removeChildren(linkNode, "CROP");
  if (!crop || crop.width <= 0 || crop.height <= 0) return;
  const node: GedNode = { level: linkNode.level + 1, tag: "CROP", children: [] };
  const push = (tag: string, value: number) =>
    node.children.push({ level: linkNode.level + 2, tag, value: String(Math.max(0, Math.round(value))), children: [] });
  push("TOP", crop.top);
  push("LEFT", crop.left);
  push("WIDTH", crop.width);
  push("HEIGHT", crop.height);
  linkNode.children.push(node);
}

/**
 * Delete the top-level `OBJE` record `objeXref` if no pointer anywhere in the
 * dataset (on an `INDI`, `FAM`, or `SOUR`) still references it. Mirrors
 * `pruneUnreferencedSource` — a shared photo also cited as a source-page image,
 * or still attached to another person, is left intact.
 */
export function pruneUnreferencedMedia(dataset: Dataset, objeXref: string): void {
  if (referencedObjeXrefs(dataset.records, new Set([objeXref])).size > 0) return; // still referenced
  const i = dataset.records.findIndex((r) => r.tag === "OBJE" && r.xref === objeXref);
  if (i !== -1) dataset.records.splice(i, 1);
  bumpSourceCacheVersion(dataset.records);
  clearObjeNodeCache(dataset.records);
}

/**
 * The subset of `candidates` still referenced by an `OBJE` pointer anywhere in
 * the dataset (on an `INDI`, `FAM`, or `SOUR`, at any depth), found in one
 * pass — so pruning several candidates at once doesn't rescan the whole tree
 * per xref. A definition record (xref set, no value) never counts as a
 * reference to itself. Stops early once every candidate has been seen.
 */
export function referencedObjeXrefs(records: GedNode[], candidates: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  if (candidates.size === 0) return found;
  const stack: GedNode[] = [...records];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.tag === "OBJE") {
      const ptr = node.value?.trim();
      if (ptr && candidates.has(ptr)) {
        found.add(ptr);
        if (found.size === candidates.size) return found;
      }
    }
    for (const child of node.children) stack.push(child);
  }
  return found;
}
