import type { Translate } from "../../locales/i18n";
import { MergeChip, type MergeChipActions } from "./MergeChip";

type Item = { text: string; lang?: string };

/**
 * A name's translations (GEDCOM 7 `TRAN`, 5.5.1 `ROMN`/`FONE` — see
 * `gedcom/translation`) as read-only chips under the name row, each with its
 * language. They are kept through every edit of the name itself; search finds
 * the person by any of them. `merge` previews those a confirmed match will add.
 */
export function TranslationChips({ items, t, merge }: { items: Item[]; t: Translate; merge?: { items: Item[] } & MergeChipActions }) {
  if (!items.length && !merge?.items.length) return null;
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
        {merge?.items.map((item, i) => (
          <MergeChip key={`merge-${i}`} t={t} onTake={merge.onTake} onSkip={merge.onSkip}>
            {item.text}
            {item.lang && <span className="muted"> ({item.lang})</span>}
          </MergeChip>
        ))}
      </div>
    </div>
  );
}
