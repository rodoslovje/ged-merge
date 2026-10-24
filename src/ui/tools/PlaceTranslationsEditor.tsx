import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Translation } from "../../gedcom/types";
import { suggestLanguage, UNDETERMINED } from "../../tools/fixTranslationLang";
import { placeTranslationSets } from "../../tools/placeTranslations";
import { PickerMenu } from "../PickerMenu";
import { useLanguageItems } from "./languageItems";

/** One line of the draft: the name, its language, and whether the language was
 *  picked by hand — until it is, it follows what the name's spelling suggests. */
interface DraftLine {
  value: string;
  lang: string;
  picked: boolean;
}

const same = (a: Translation[], b: Translation[]) =>
  a.length === b.length && a.every((x, i) => x.value === b[i].value && (x.lang ?? "") === (b[i].lang ?? ""));

/**
 * A place's other names (GEDCOM 7 `TRAN` + `LANG`), edited under the places
 * tree's rename box. The row stands for one or more place values; writing gives
 * every `PLAC` with one of them the same list (see `tools/placeTranslations`).
 */
export function PlaceTranslationsEditor({
  dataset,
  values,
  onWrite,
}: {
  dataset: Dataset;
  /** The place values the row stands for. */
  values: ReadonlySet<string>;
  onWrite: (list: Translation[]) => void;
}) {
  const { t } = useTranslation();
  // Read once as the box opens: what the places carry now, most-written first.
  const sets = useMemo(() => placeTranslationSets(dataset, values), [dataset, values]);
  const total = sets.reduce((n, s) => n + s.n, 0);
  const start = sets.find((s) => s.list.length)?.list ?? [];
  const [draft, setDraft] = useState<DraftLine[]>(() =>
    start.map((tr) => ({ value: tr.value, lang: tr.lang ?? UNDETERMINED, picked: true })),
  );
  const langItems = useLanguageItems(useMemo(() => draft.map((d) => d.lang), [draft]));

  const list: Translation[] = draft
    .filter((d) => d.value.trim())
    .map((d) => ({ value: d.value.trim(), lang: d.lang }));
  // Nothing to write when every place already carries exactly this list.
  const unchanged = sets.length === 1 && same(sets[0].list, list);

  const update = (i: number, next: Partial<DraftLine>) =>
    setDraft((prev) =>
      prev.map((d, j) => {
        if (j !== i) return d;
        const line = { ...d, ...next };
        if (next.value !== undefined && !line.picked) line.lang = suggestLanguage(line.value.trim()) ?? UNDETERMINED;
        return line;
      }),
    );

  return (
    <div className="tools-place-tran">
      <div className="tools-place-tran-head">
        <span className="tools-place-tran-title">{t("tools.places.tran.title")}</span>
        <span className="tools-place-rename-hint">{t("tools.places.tran.scope", { count: total })}</span>
      </div>
      {sets.length > 1 && <p className="tools-place-rename-hint">{t("tools.places.tran.differ")}</p>}
      {draft.map((d, i) => (
        <div key={i} className="tools-place-tran-line">
          <input
            className="tools-place-rename-input tools-place-tran-input"
            value={d.value}
            placeholder={t("tools.places.tran.placeholder")}
            aria-label={t("tools.places.tran.name")}
            autoFocus={!d.value && i === draft.length - 1}
            onChange={(e) => update(i, { value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !unchanged) onWrite(list);
            }}
          />
          <PickerMenu
            items={langItems}
            value={d.lang}
            onChange={(lang) => update(i, { lang, picked: true })}
            label={t("tools.validate.tranLang.langOf", { name: d.value || "…" })}
          />
          <button
            type="button"
            className="tools-place-edit-btn"
            title={t("tools.places.tran.remove")}
            aria-label={t("tools.places.tran.remove")}
            onClick={() => setDraft((prev) => prev.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="tools-place-tran-actions">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setDraft((prev) => [...prev, { value: "", lang: UNDETERMINED, picked: false }])}
        >
          {t("tools.places.tran.add")}
        </button>
        <button type="button" className="nav-btn primary" disabled={unchanged} onClick={() => onWrite(list)}>
          {t("tools.places.tran.write")}
        </button>
      </div>
    </div>
  );
}
