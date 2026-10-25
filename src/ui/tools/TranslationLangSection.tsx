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
 * A row is written on its own, or the selected rows at once with the
 * languages chosen, or as undetermined — selected the way the findings list
 * picks its rows.
 *
 * The selection bar (`actions`) and the per-name rows (`list`) sit
 * on the list's own chip page, and both read the same picks; the note that
 * the languages were written (`doneNote`) stays up after the chip is gone.
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
}): { actions: ReactNode; list: ReactNode; doneNote: ReactNode } {
  const { t } = useTranslation();
  const groups = useMemo(
    () => (needed ? untaggedTranslations(dataset) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, freshness, needed],
  );
  // The user's own language choices, by group key; a group not in it keeps
  // its suggestion.
  const [chosen, setChosen] = useState<Map<string, string[]>>(() => new Map());
  // The rows selected for one batch, by group key — as the findings list picks.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<"chosen" | "und" | null>(null);
  const [done, setDone] = useState<number | null>(null);
  useEffect(() => {
    setChosen(new Map());
    setPending(null);
    setDone(null);
  }, [dataset]);
  // A selection points at rows of the list it was made in.
  useEffect(() => { setSelected(new Set()); }, [groups]);

  const langItems = useLanguageItems(useMemo(() => groups.flatMap((g) => g.suggested), [groups]));

  const doneNote = done !== null && (
    <p className="tools-clean tools-clean--ok">{t("tools.validate.tranLang.done", { count: done })}</p>
  );
  if (groups.length === 0) return { actions: null, list: null, doneNote: doneNote || null };

  const langsOf = (g: UntaggedTranslation) => chosen.get(g.key) ?? g.suggested;
  const picked = groups.filter((g) => selected.has(g.key));
  const lines = picked.reduce((n, g) => n + g.count, 0);
  const allPicked = picked.length === groups.length;

  function apply(choices: Map<string, string[]>) {
    setPending(null);
    setSelected(new Set());
    setDone(onApply(choices));
    onApplied();
  }
  const choose = (g: UntaggedTranslation, part: number, lang: string) =>
    setChosen((prev) => new Map(prev).set(g.key, langsOf(g).map((l, i) => (i === part ? lang : l))));
  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const actions = (
    <>
      <div className="tools-pick-bar">
        <button className="nav-btn primary tools-run" onClick={() => setPending("chosen")} disabled={picked.length === 0}>
          {t("tools.validate.tranLang.apply", { count: lines })}
        </button>
        <button className="nav-btn tools-run" onClick={() => setPending("und")} disabled={picked.length === 0}>
          {t("tools.validate.tranLang.und", { count: lines })}
        </button>
        <button
          className="tools-issue-link"
          onClick={() => setSelected(new Set(groups.map((g) => g.key)))}
          disabled={allPicked}
        >
          {t("tools.validate.pickAll", { count: groups.length })}
        </button>
        <button className="tools-issue-link" onClick={() => setSelected(new Set())} disabled={picked.length === 0}>
          {t("tools.sources.dupSelectNone")}
        </button>
      </div>
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
            apply(new Map(picked.map((g) => [g.key, pending === "chosen" ? langsOf(g) : g.parts.map(() => UNDETERMINED)])))
          }
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );

  const list = (
    // No heading of its own: the chip above already names the list.
    <div className="tools-struct tools-tran-list">
      <p className="tools-fix-hint">{t("tools.validate.tranLang.hint")}</p>
      <ul className="tools-issues">
        {groups.slice(0, 200).map((g, i) => {
          const langs = langsOf(g);
          const split = new Set(langs).size;
          return (
            <li key={g.key} className={`tools-issue sev-warning${i % 2 ? " zebra" : ""}`}>
              <input
                type="checkbox"
                className="tools-pick"
                checked={selected.has(g.key)}
                onChange={() => toggle(g.key)}
                aria-label={t("tools.validate.pickOne")}
              />
              {/* Which kind of name it translates: a place's or a person's. */}
              <span className="tools-struct-rec"><span className="tools-struct-rec-tag">{g.place ? "PLAC" : "NAME"}</span></span>
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
              {/* The count reads as the grouped findings' does: "(294×)" after the row's text. */}
              <span className="tools-issue-msg">
                ({g.count}×)
                {split > 1 && <span className="tools-issue-detail"> {t("tools.validate.tranLang.split", { count: split })}</span>}
              </span>
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

  return { actions, list, doneNote: doneNote || null };
}
