import type { SourceCitation } from "../gedcom/types";
import { sourceCitationKey } from "../gedcom/source";
import type { Translate } from "../locales/i18n";
import { linkHref } from "./FieldValue";

/**
 * Source citation references. When only `masterSources` is given, renders that
 * side's citations plainly (used for a single column or a read-only list).
 * When `incomingSources` is also given, any incoming citation the master
 * lacks is highlighted as new — so an event both sides agree on shows one
 * compact reference per source rather than duplicating it for each side.
 */
export function SourceRefs({
  t,
  masterSources,
  incomingSources,
  onRemove,
}: {
  t: Translate;
  masterSources?: SourceCitation[];
  incomingSources?: SourceCitation[];
  /** When given (Edit mode, no `incomingSources`), each icon shows a remove
   * button keyed by its position in `masterSources`. */
  onRemove?: (index: number) => void;
}) {
  const ms = masterSources ?? [];
  const cs = incomingSources ?? [];
  const masterKeys = new Set(ms.map(sourceCitationKey));
  const newOnes = cs.filter((c) => !masterKeys.has(sourceCitationKey(c)));
  const all = [
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
          onRemove={onRemove && index !== -1 ? () => onRemove(index) : undefined}
        />
      ))}
    </span>
  );
}

function SourceRefItem({ t, citation, isNew, onRemove }: { t: Translate; citation: SourceCitation; isNew: boolean; onRemove?: () => void }) {
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
  const removeBtn = onRemove && (
    <button type="button" className="source-ref-remove" title={t("edit.removeLink")} onClick={onRemove}>×</button>
  );
  const content = citation.url ? (
    <a className={cls} href={linkHref(citation.url)} target="_blank" rel="noopener noreferrer" title={tooltip || t("source.untitled")}>
      {icon}
    </a>
  ) : (
    <span className={cls} title={tooltip || t("source.untitled")}>
      {icon}
    </span>
  );
  return onRemove ? (
    <span className="source-ref-wrap">
      {content}
      {removeBtn}
    </span>
  ) : content;
}
