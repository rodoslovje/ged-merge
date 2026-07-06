import type { SourceCitation } from "../gedcom/types";
import { sourceCitationKey } from "../gedcom/source";
import type { Translate } from "../locales/i18n";
import { linkHref } from "./FieldValue";

/**
 * Source citation references. When only `mainSources` is given, renders that
 * side's citations plainly (used for a single column or a read-only list).
 * When `incomingSources` is also given, any incoming citation the main
 * lacks is highlighted as new — so an event both sides agree on shows one
 * compact reference per source rather than duplicating it for each side.
 *
 * `compareAgainst` is for the opposite case: rendering one side's own list
 * (not unioned with the other side's) while still flagging which of its
 * citations the other side lacks — used to mark a side-by-side incoming
 * column's citations as new without pulling in the main's own citations.
 */
export function SourceRefs({
  t,
  mainSources,
  incomingSources,
  compareAgainst,
  onEdit,
}: {
  t: Translate;
  mainSources?: SourceCitation[];
  incomingSources?: SourceCitation[];
  compareAgainst?: SourceCitation[];
  /** When given (Edit mode, no `incomingSources`), clicking an icon opens an
   * edit dialog for it, keyed by its position in `mainSources`, instead of
   * opening the link directly. */
  onEdit?: (index: number) => void;
}) {
  const ms = mainSources ?? [];
  const cs = incomingSources ?? [];
  const mainKeys = new Set(ms.map(sourceCitationKey));
  const newOnes = cs.filter((c) => !mainKeys.has(sourceCitationKey(c)));
  const all = compareAgainst
    ? (() => {
        const otherKeys = new Set(compareAgainst.map(sourceCitationKey));
        return ms.map((c, i) => ({ c, isNew: !otherKeys.has(sourceCitationKey(c)), index: i }));
      })()
    : [
        ...ms.map((c, i) => ({ c, isNew: false, index: i })),
        ...newOnes.map((c) => ({ c, isNew: true, index: -1 })),
      ];
  if (all.length === 0) return null;

  return (
    <span className="source-refs">
      {all.map(({ c, isNew, index }, i) => (
        <SourceRefItem
          key={i}
          t={t}
          citation={c}
          isNew={isNew}
          onEdit={onEdit && index !== -1 ? () => onEdit(index) : undefined}
        />
      ))}
    </span>
  );
}

function SourceRefItem({ t, citation, isNew, onEdit }: { t: Translate; citation: SourceCitation; isNew: boolean; onEdit?: () => void }) {
  const pageText = citation.page ? t("source.page", { page: citation.page }) : undefined;
  const tooltip = [citation.title, citation.agency, citation.filingNumber ? `#${citation.filingNumber}` : undefined, pageText]
    .filter(Boolean)
    .join("\n");
  // A title means there's something worth describing; otherwise the citation
  // is just a bare link, so the icon tells the two apart at a glance.
  const hasDescription = Boolean(citation.title);
  const icon = hasDescription ? "📖" : "🔗";
  const cls = [
    "source-ref",
    // 📖 renders noticeably smaller than 🔗 at the same font-size, so it
    // gets its own modifier to size up and match.
    hasDescription ? "source-ref--book" : "",
    citation.url ? (citation.exact ? "" : "source-ref--fallback") : "source-ref--nolink",
    isNew ? "source-ref--new" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const title = tooltip || t("source.untitled");
  // Edit mode: clicking opens the edit dialog (which has its own explicit
  // Open/Save/Remove actions) rather than navigating straight to the link —
  // this also removes the old hover-revealed × badge that sat on the icon's
  // corner and was too easy to hit by mistake while reaching for the link.
  if (onEdit) {
    return (
      <button type="button" className={cls} title={title} onClick={onEdit}>
        {icon}
      </button>
    );
  }
  return citation.url ? (
    <a className={cls} href={linkHref(citation.url)} target="_blank" rel="noopener noreferrer" title={title}>
      {icon}
    </a>
  ) : (
    <span className={cls} title={title}>
      {icon}
    </span>
  );
}
