import type { Translate } from "../../locales/i18n";

/**
 * A name's translations (GEDCOM 7 `TRAN`, 5.5.1 `ROMN`/`FONE` — see
 * `gedcom/translation`) as read-only chips under the name row, each with its
 * language. They are kept through every edit of the name itself; search finds
 * the person by any of them.
 */
export function TranslationChips({ items, t }: { items: { text: string; lang?: string }[]; t: Translate }) {
  if (!items.length) return null;
  return (
    <div className="edit-other-names">
      <div className="edit-other-names-row">
        <span className="edit-no-events-label">{t("edit.nameTranslations")}</span>
        {items.map((item, i) => (
          <span
            key={i}
            className="edit-name-chip"
            title={item.lang ? t("edit.translationTooltip", { lang: item.lang }) : undefined}
          >
            {item.text}
            {item.lang && <span className="muted"> ({item.lang})</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
