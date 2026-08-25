import type { Translate } from "../../locales/i18n";

/** The GEDCOM data-quality values, best evidence first — the order the menus
 *  offer them in, and the order the guide explains them in. */
export const QUAY_VALUES = ["3", "2", "1", "0"] as const;

/**
 * The choices of a citation-quality menu: the four `QUAY` values, each shown
 * with what it means, above an empty choice that leaves the citation without
 * one. `fallback` is the value that applies when this menu is left empty (the
 * Organize sources tool's per-reference menus sit under a group-wide choice)
 * — named in the empty choice's label, so a reader can see what "unset" will
 * write. One list for every place the app asks the question, so the four
 * meanings cannot drift apart between the dialogs and the tool.
 */
export function quayOptions(t: Translate, fallback?: string): { value: string; label: string }[] {
  return [
    {
      value: "",
      label: fallback
        ? `${fallback} – ${t(`tools.sources.reshapeQuay.${fallback}`)}`
        : t("tools.sources.reshapeQuay.none"),
    },
    ...QUAY_VALUES.map((q) => ({ value: q, label: `${q} – ${t(`tools.sources.reshapeQuay.${q}`)}` })),
  ];
}
