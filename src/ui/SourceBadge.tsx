import type { SourceCitation } from "../gedcom/types";
import { sourceCitationKey } from "../gedcom/source";
import type { Translate } from "../locales/i18n";
import { linkHref } from "./FieldValue";

/**
 * Source citation badges. When only `masterSources` is given, renders that
 * side's citations plainly (used for a single column or a read-only list).
 * When `incomingSources` is also given, any incoming citation the master
 * lacks is highlighted as new — so an event both sides agree on shows one
 * compact badge per source rather than duplicating it for each side.
 */
export function SourceBadges({
  t,
  masterSources,
  incomingSources,
}: {
  t: Translate;
  masterSources?: SourceCitation[];
  incomingSources?: SourceCitation[];
}) {
  const ms = masterSources ?? [];
  const cs = incomingSources ?? [];
  const masterKeys = new Set(ms.map(sourceCitationKey));
  const newOnes = cs.filter((c) => !masterKeys.has(sourceCitationKey(c)));
  const all = [...ms.map((c) => ({ c, isNew: false })), ...newOnes.map((c) => ({ c, isNew: true }))];
  if (all.length === 0) return null;

  return (
    <span className="source-badges">
      {all.map(({ c, isNew }, i) => (
        <SourceBadgeItem key={i} t={t} citation={c} isNew={isNew} />
      ))}
    </span>
  );
}

function SourceBadgeItem({ t, citation, isNew }: { t: Translate; citation: SourceCitation; isNew: boolean }) {
  const label = citation.title ? truncate(citation.title, 40) : t("source.untitled");
  const pageText = citation.page ? t("source.page", { page: citation.page }) : undefined;
  const tooltip = [citation.title, citation.agency, citation.filingNumber ? `#${citation.filingNumber}` : undefined, pageText]
    .filter(Boolean)
    .join("\n");
  const cls = [
    "source-badge",
    citation.url ? (citation.exact ? "" : "source-badge--fallback") : "source-badge--nolink",
    isNew ? "source-badge--new" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const text = <span className="source-badge-text">{pageText ? `${label}, ${pageText}` : label}</span>;
  return citation.url ? (
    <a className={cls} href={linkHref(citation.url)} target="_blank" rel="noopener noreferrer" title={tooltip}>
      {text}
    </a>
  ) : (
    <span className={cls} title={tooltip}>
      {text}
    </span>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
