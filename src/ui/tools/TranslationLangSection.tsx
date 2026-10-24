import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { UNDETERMINED, untaggedTranslations, type UntaggedTranslation } from "../../tools/fixTranslationLang";
import { ConfirmDialog } from "../ConfirmDialog";
import { PickerMenu } from "../PickerMenu";
import { useLanguageItems } from "./languageItems";

/**
 * GEDCOM 7 translations with no `LANG` (see `tools/fixTranslationLang`): one
 * row per name, a language picker per part, pre-filled from the spelling.
 * A row is written on its own, or all rows at once with the languages chosen,
 * or all of them as undetermined.
 *
 * The two whole-file buttons sit with the health check's other quick fixes
 * (`fix`), the per-name rows down with the findings (`list`); both read the
 * same picks.
 */
export function useTranslationLang({
  dataset,
  freshness,
  needed,
  onApply,
  onApplied,
}: {
  dataset: Dataset;
  /** Changes whenever the health check re-runs — the list is re-derived then. */
  freshness: unknown;
  /** The health check reported such a line; without one there is nothing to scan for. */
  needed: boolean;
  onApply: (choices: Map<string, string[]>) => number;
  onApplied: () => void;
}): { fix: ReactNode; list: ReactNode } {
  const { t } = useTranslation();
  const groups = useMemo(
    () => (needed ? untaggedTranslations(dataset) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, freshness, needed],
  );
  // The user's own picks, by group key; a group not in it keeps its suggestion.
  const [picked, setPicked] = useState<Map<string, string[]>>(() => new Map());
  const [pending, setPending] = useState<"chosen" | "und" | null>(null);
  const [done, setDone] = useState<number | null>(null);
  useEffect(() => {
    setPicked(new Map());
    setPending(null);
    setDone(null);
  }, [dataset]);

  const langItems = useLanguageItems(useMemo(() => groups.flatMap((g) => g.suggested), [groups]));

  const doneNote = done !== null && (
    <p className="tools-clean tools-clean--ok">{t("tools.validate.tranLang.done", { count: done })}</p>
  );
  if (groups.length === 0) return { fix: doneNote || null, list: null };

  const langsOf = (g: UntaggedTranslation) => picked.get(g.key) ?? g.suggested;
  const lines = groups.reduce((n, g) => n + g.count, 0);

  function apply(choices: Map<string, string[]>) {
    setPending(null);
    setDone(onApply(choices));
    onApplied();
  }
  const choose = (g: UntaggedTranslation, part: number, lang: string) =>
    setPicked((prev) => new Map(prev).set(g.key, langsOf(g).map((l, i) => (i === part ? lang : l))));

  const fix = (
    <>
      {doneNote}
      <ul className="tools-fix-list">
        <li className="tools-fix-item">
          <span className="tools-tran-actions">
            <button className="nav-btn primary tools-run" onClick={() => setPending("chosen")}>
              {t("tools.validate.tranLang.apply", { count: lines })}
            </button>
            <button className="nav-btn tools-run" onClick={() => setPending("und")}>
              {t("tools.validate.tranLang.und", { count: lines })}
            </button>
          </span>
          <span className="tools-fix-hint">{t("tools.validate.tranLang.fixHint")}</span>
        </li>
      </ul>
      {pending !== null && (
        <ConfirmDialog
          message={
            pending === "chosen"
              ? `${t("tools.validate.tranLang.apply", { count: lines })}\n\n${t("tools.validate.tranLang.applyHint")}`
              : `${t("tools.validate.tranLang.und", { count: lines })}\n\n${t("tools.validate.tranLang.undHint")}`
          }
          confirmLabel={t("tools.validate.applyFix")}
          busy
          onConfirm={() =>
            apply(new Map(groups.map((g) => [g.key, pending === "chosen" ? langsOf(g) : g.parts.map(() => UNDETERMINED)])))
          }
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );

  const list = (
    <div className="tools-struct">
      <div className="tools-examples-title">{t("tools.validate.tranLang.title")}</div>
      <p className="tools-fix-hint">{t("tools.validate.tranLang.hint")}</p>
      <ul className="tools-issues">
        {groups.slice(0, 200).map((g, i) => {
          const langs = langsOf(g);
          const split = new Set(langs).size;
          return (
            <li key={g.key} className={`tools-issue sev-warning${i % 2 ? " zebra" : ""}`}>
              <span className="tools-tran-parts">
                {g.parts.map((part, j) => (
                  <span key={j} className="tools-tran-part">
                    <span className="tools-tran-name">{part}</span>
                    <PickerMenu
                      items={langItems}
                      value={langs[j]}
                      onChange={(lang) => choose(g, j, lang)}
                      label={t("tools.validate.tranLang.langOf", { name: part })}
                    />
                  </span>
                ))}
              </span>
              {split > 1 && <span className="tools-issue-detail">{t("tools.validate.tranLang.split", { count: split })}</span>}
              <span className="tools-chip-count">{g.count}</span>
              <button
                className="tools-issue-fix sets"
                title={t("tools.validate.tranLang.applyHint")}
                onClick={() => apply(new Map([[g.key, langs]]))}
              >
                {t("tools.validate.tranLang.writeOne")}
              </button>
            </li>
          );
        })}
      </ul>
      {groups.length > 200 && <p className="tools-fix-hint">{t("tools.geocode.more", { count: groups.length - 200 })}</p>}
    </div>
  );

  return { fix, list };
}
