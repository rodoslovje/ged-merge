/**
 * Single source of truth for GEDCOM event-bearing tags and their canonical
 * life-cycle ordering. The tag sets and display/serialization orders used by
 * the parser lift (`builder`), Edit-mode child ordering (`edit`), CHAN/CREA
 * stamping (`chanCrea`), the edit report (`editReport`) and the review/edit
 * UIs all derive from these lists — add a new event tag here and every
 * consumer picks it up together.
 */

/** Individual event tags in canonical life-cycle order (birth → … → death).
 *  Includes the GEDCOM attribute tags (TITL, DSCR, RELI, …) — the app models
 *  attributes as value-bearing events, like OCCU — and the Brother's Keeper
 *  vendor events (_MILT military, _MEDC medical, _FNRL funeral, _INTE
 *  interment), which carry the same DATE/PLAC substructure. */
export const INDI_EVENT_TAG_ORDER = [
  "BIRT", "BAPM", "CHR", "CONF", "ADOP", "FCOM",
  "OCCU", "EDUC", "GRAD", "RETI", "_MILT", "_MILI",
  "TITL", "DSCR", "RELI", "NATI", "RACE", "NCHI", "NOBI", "LATR", "DEED", "_MEDC", "ILL",
  "RESI", "EMIG", "IMMI", "NATU", "CENS",
  "WILL", "PROB",
  "EVEN", "FACT", "REFN",
  "DEAT", "_FNRL", "BURI", "_INTE", "CREM",
];

/** Family event tags in canonical order. `_MSTAT` is the canonical
 *  partnership-status tag (Brother's Keeper vocabulary — "Partners", …) that
 *  normalization consolidates the other vendor encodings into. */
export const FAM_EVENT_TAG_ORDER = ["MARR", "ENGA", "SEPA", "MARB", "MARL", "DIV", "_MSTAT"];

/** Event-bearing INDI children lifted into the typed `events` array. Includes
 *  MARR: some exports write a marriage event directly on the individual. */
export const INDI_EVENT_TAGS: Set<string> = new Set([...INDI_EVENT_TAG_ORDER, "MARR"]);

/** Event-bearing FAM children lifted into the typed `events` array. */
export const FAM_EVENT_TAGS: Set<string> = new Set(FAM_EVENT_TAG_ORDER);

/** Every event-bearing tag on either record kind. */
export const ALL_EVENT_TAGS: Set<string> = new Set([...INDI_EVENT_TAGS, ...FAM_EVENT_TAGS]);

/** Family events Edit mode can create and edit (MARB/MARL are preserved on
 *  load/save but not surfaced), and therefore the ones the edit report diffs. */
export const EDITABLE_FAM_EVENT_TAGS = ["MARR", "ENGA", "SEPA", "DIV", "_MSTAT"];

/** Event tags that carry a direct text value on the tag line
 *  (e.g. `1 OCCU Farmer`, `1 _MSTAT Partners`) — shown/edited as an inline
 *  value field and compared as a `.value` row. */
export const VALUE_EVENT_TAGS: Set<string> = new Set([
  "OCCU", "EDUC", "RETI",
  "TITL", "DSCR", "RELI", "NATI", "RACE", "NCHI", "NOBI", "LATR", "DEED", "ILL", "REFN",
  "_MILT", "_MILI", "_MEDC",
  "_MSTAT",
]);
