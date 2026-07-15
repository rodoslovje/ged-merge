import type { Dataset } from "../gedcom/types";
import { walkNodes } from "./walk";
import { inferSourceFormat } from "../gedcom/source";
import { LINK_TAGS } from "../gedcom/builder";
import { looksLikeUrl } from "../gedcom/uri";
import {
  baptismTargetTag,
  detectCitationPlacement,
  detectPageMediaStyle,
  hasSourcePageMedia,
  prefersDoubledLinks,
} from "../tools/sourceReshape";
import { detectLinkLangs } from "./links";
import {
  collectLayoutValues,
  dateLayoutFromValues,
  detectDatePlaceholder,
  detectPlaceLayout,
  detectUnknownNameToken,
  inferNameLayout,
} from "./profile";
import type { FormatOverrides } from "./formatOverrides";

/**
 * What "Auto (detected)" currently resolves to for each Format-tab dimension,
 * as override-value strings — shown as the example beside the dropdowns while
 * a main file is loaded. Undefined = the file gives no signal (no dates, no
 * alternate names, no page media, …), so there is nothing to show.
 */
export function detectFormatDefaults(dataset: Dataset): Partial<Record<keyof FormatOverrides, string>> {
  const { dateValues, placeValues, addrCount } = collectLayoutValues(dataset);
  const links: string[] = [];
  walkNodes(dataset.records, (node) => {
    if (node.value !== undefined && LINK_TAGS.has(node.tag) && looksLikeUrl(node.value)) links.push(node.value);
  });
  const linkLangs = detectLinkLangs(links);
  const placeLayout = detectPlaceLayout(placeValues, addrCount);
  const nameLayout = inferNameLayout(dataset);
  const sourceLayout = inferSourceFormat(dataset.records).layout;
  const out: Partial<Record<keyof FormatOverrides, string>> = {
    date: dateLayoutFromValues(dateValues),
    datePlaceholder: dateValues.length ? (detectDatePlaceholder(dateValues) ?? "none") : undefined,
    place: placeLayout === "unknown" ? undefined : placeLayout,
    names: nameLayout === "none" ? undefined : nameLayout,
    unknownName: detectUnknownNameToken(dataset) ?? "blank",
    sourceLayout: sourceLayout === "unknown" ? undefined : sourceLayout,
    citations: detectCitationPlacement(dataset.records),
    pageMedia: hasSourcePageMedia(dataset.records) ? detectPageMediaStyle(dataset.records) : undefined,
    baptism: baptismTargetTag(dataset.records),
    doubledLinks: prefersDoubledLinks(dataset.records) ? "keep" : "fold",
    matriculaLang: linkLangs.matricula,
    geneanetLang: linkLangs.geneanet,
  };
  for (const k of Object.keys(out) as (keyof FormatOverrides)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** A concrete sample date rendered in a pattern string, e.g. "DD.MM.YYYY" →
 *  "15.06.1879" and "D Mmm YYYY" → "15 Jun 1879". */
export function sampleDateFor(pattern: string): string {
  return pattern
    .replace(/YYYY/g, "1879")
    .replace(/MMMM/g, "JUNE")
    .replace(/Mmmm/g, "June")
    .replace(/mmmm/g, "june")
    .replace(/MMM/g, "JUN")
    .replace(/Mmm/g, "Jun")
    .replace(/mmm/g, "jun")
    .replace(/MM/g, "06")
    .replace(/M(?![a-z])/g, "6")
    .replace(/DD/g, "15")
    .replace(/D(?![a-z])/g, "15");
}
