import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { Translate } from "../locales/i18n";

/** The tooltip naming the incoming records one was merged from. */
export function consolidatedTitle(t: Translate, ids: string[]): string {
  return t("compare.consolidated.title", { ids: ids.map((x) => x.replace(/@/g, "")).join(", ") });
}

/**
 * ⧉ beside an Incoming column header — the Matches list's mark — when the incoming
 * record is one the matcher assembled from several copies of the person
 * (`Dataset.consolidatedFrom`); the tooltip names them. Nothing otherwise.
 */
export function ConsolidatedBadge({ compareDs, id }: { compareDs: Dataset; id: string | undefined }) {
  const { t } = useTranslation();
  const from = id ? compareDs.consolidatedFrom?.get(id) : undefined;
  if (!from) return null;
  return (
    <span className="rel-tree-badge consolidated-badge" data-tip={consolidatedTitle(t, from)} aria-label={consolidatedTitle(t, from)}>
      ⧉
    </span>
  );
}
