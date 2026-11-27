import type { GedNode } from "../gedcom/types";
import { retagEvent } from "../gedcom/edit/shared";
import { standardConversionTarget } from "../gedcom/eventTags";
import { isPrivacyMarker, setPrivateFlag } from "../gedcom/private";
import { VENDOR_TAG_ALIASES, vendorTagInfo } from "../gedcom/vendorTags";
import { allowsChild } from "./conformance/allows";

/**
 * A program's own tag restated as the standard structure that says the same —
 * the health check's "Convert to standard" on a custom-tag row, in place of
 * removing the tag:
 *
 *  - **event** — a vendor event on a person or a family (MacFamilyTree's
 *    `ILL`, `LATR`, `DEED`, `NOBI`, `MISE`; `_MILT`…): its standard
 *    equivalent where it has one, else a `FACT` (a state of the person) or an
 *    `EVEN`, named by a `TYPE`. Everything beneath the line is kept;
 *  - **privacy** — the bare `PRIV` marker: `RESN`, in the version's spelling;
 *  - **given** — `SECG`, a name's second given name: joined to its `GIVN`;
 *  - **note** — `_DSCR`, a media description: a `NOTE` on the media;
 *  - **publication** — `EDTN`, a source's edition: part of its `PUBL`.
 */
export type StandardHome = "event" | "privacy" | "given" | "note" | "publication";

const HOMES: Record<string, StandardHome> = { PRIV: "privacy", SECG: "given", _DSCR: "note", EDTN: "publication" };

/** The standard home of `tag`, when it has one. */
export function standardHomeOf(tag: string): StandardHome | undefined {
  return HOMES[tag] ?? (vendorTagInfo(tag)?.category === "event" ? "event" : undefined);
}

/** The tag whose name types a converted event: `MISE` is `_MILT` by another
 *  spelling, and is named as it is. */
export function eventNameTag(tag: string): string {
  return VENDOR_TAG_ALIASES[tag] ?? tag;
}

/** The tag an event `tag` becomes on a `record`, or undefined where the
 *  version has no line for it there. A `FACT` states something, so a line
 *  without text — and a record the version gives no `FACT` — takes `EVEN`. */
function eventTarget(tag: string, record: string, hasText: boolean, version: "5.5.1" | "7.0"): string | undefined {
  const target = standardConversionTarget(tag);
  const fits = (t: string) => allowsChild(version, [record], t);
  if (target === "FACT" && (!hasText || !fits("FACT"))) return fits("EVEN") ? "EVEN" : undefined;
  return fits(target) ? target : undefined;
}

/** What a row says `tag` becomes: `EVEN` for an event, else the home's tag. */
export function standardTargetTag(tag: string, version: "5.5.1" | "7.0"): string | undefined {
  switch (standardHomeOf(tag)) {
    case "event": return eventTarget(tag, "INDI", true, version) ?? eventTarget(tag, "FAM", true, version);
    case "privacy": return "RESN";
    case "given": return "GIVN";
    case "note": return "NOTE";
    case "publication": return "PUBL";
    default: return undefined;
  }
}

const fold = (v: string | undefined) => (v ?? "").trim().toLowerCase();
const words = (v: string | undefined) => fold(v).split(/\s+/).filter(Boolean);

/**
 * Restate every `tag` line of `rec` as its standard structure. `label` is the
 * word the result carries where the tag itself was the meaning: an event's
 * `TYPE`, the edition's name in a `PUBL`. A line whose standard field already
 * says something else stays. Returns how many lines it settled.
 */
export function vendorTagToStandard(rec: GedNode, tag: string, version: "5.5.1" | "7.0", label: string | undefined): number {
  const home = standardHomeOf(tag);
  let n = 0;
  if (home === "event") {
    if (rec.tag !== "INDI" && rec.tag !== "FAM") return 0;
    for (const node of rec.children) {
      if (node.tag !== tag) continue;
      const target = eventTarget(tag, rec.tag, !!node.value?.trim(), version);
      if (!target) continue;
      const generic = target === "EVEN" || target === "FACT";
      // A generic event is only what its TYPE says it is.
      if (generic && !label && !node.children.some((c) => c.tag === "TYPE")) continue;
      retagEvent(node, target, label);
      n++;
    }
    return n;
  }
  const visit = (node: GedNode) => {
    const lines = node.children.filter((c) => c.tag === tag);
    if (lines.length) {
      if (home === "privacy") {
        if (lines.some(isPrivacyMarker)) {
          setPrivateFlag(node, true, "RESN", version);
          // Where the version takes no RESN the marker is the `_PRIV` extension.
          n += lines.length;
        }
      } else if (home === "given" && node.tag === "NAME") {
        for (const line of lines) {
          const second = line.value?.trim();
          const given = node.children.find((c) => c.tag === "GIVN");
          const said = (text: string | undefined) => words(second).every((w) => words(text).includes(w));
          if (!second) continue;
          if (given) {
            if (!said(given.value)) given.value = `${given.value?.trim() ?? ""} ${second}`.trim();
          } else if (!said(node.value?.replace(/\/.*$/, ""))) {
            continue; // nowhere says it, and there is no GIVN to join
          }
          node.children = node.children.filter((c) => c !== line);
          n++;
        }
      } else if (home === "note" && node === rec && rec.tag === "OBJE") {
        for (const line of lines) {
          const text = line.value?.trim();
          if (text && node.children.some((c) => c.tag === "NOTE" && c.value?.trim() === text)) {
            node.children = node.children.filter((c) => c !== line);
          } else {
            line.tag = "NOTE";
          }
          n++;
        }
      } else if (home === "publication" && node === rec && rec.tag === "SOUR") {
        for (const line of lines) {
          const edition = line.value?.trim();
          if (!edition || !label) continue;
          const text = `${label}: ${edition}`;
          const publ = node.children.find((c) => c.tag === "PUBL");
          if (!publ) {
            line.tag = "PUBL";
            line.value = text;
          } else {
            if (!fold(publ.value).includes(fold(text))) publ.value = [publ.value?.trim(), text].filter(Boolean).join(", ");
            node.children = node.children.filter((c) => c !== line);
          }
          n++;
        }
      }
    }
    for (const c of node.children) visit(c);
  };
  visit(rec);
  return n;
}
