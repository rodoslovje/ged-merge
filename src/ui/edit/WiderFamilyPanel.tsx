import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { lifespanTooltipOf, lifespanWithAge } from "../../gedcom/age";
import { kinshipLabelFor } from "../../match/kinship";
import { widerFamily, type WiderGroup, type WiderRelative, type WiderSide } from "../../chart/widerFamily";
import { useNameOf, useSetSettings, useSettingsSlice, WIDER_FAMILY_LIMITS, type WiderFamilySettings } from "../SettingsContext";
import { sexClass } from "../sex";
import { YearsText } from "../YearsText";
import { lifespanApproxOf } from "../../gedcom/lifespan";
import { unionMark } from "../../gedcom/union";
import { GearIcon } from "../icons/GearIcon";

/** The preferences this file reads — subscribed field by field. */
const SETTINGS_KEYS = ["widerFamily", "showAge"] as const;

type DepthKey = keyof typeof WIDER_FAMILY_LIMITS;
const DEPTHS: DepthKey[] = ["ancestors", "descendants", "others"];

/**
 * The Edit view's right-hand rail: the person's relatives beyond the cards —
 * grandparents, uncles and aunts, cousins, nephews, grandchildren — grouped by
 * relationship, nearest first, each one click from their own page. Three
 * steppers set how far it reaches (see {@link widerFamily}). The toggle under
 * Edit's Back button opens and closes it; closed, it computes nothing.
 */
export const WiderFamilyPanel = memo(function WiderFamilyPanel({ dataset, personId, navigate, relationsGen }: {
  dataset: Dataset;
  personId: string;
  navigate: (id: string) => void;
  /** Bumped on structural edits — the walk reads the whole family graph. */
  relationsGen: number;
}) {
  const { t } = useTranslation();
  const settings = useSettingsSlice(SETTINGS_KEYS);
  const setSettings = useSetSettings();
  const cfg = settings.widerFamily;
  const update = (patch: Partial<WiderFamilySettings>) => setSettings({ widerFamily: { ...cfg, ...patch } });

  const groups = useMemo(
    () => (cfg.open ? widerFamily(dataset, personId, cfg) : []),
    // relationsGen stands in for edits that keep the dataset's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg, dataset, personId, relationsGen],
  );

  if (!cfg.open) return null;

  const total = groups.reduce((n, g) => n + g.members.length, 0);
  return (
    <aside className="edit-wider" id="edit-wider" aria-labelledby="edit-wider-title">
      <div className="edit-wider-head">
        <div className="edit-wider-title">
          <strong id="edit-wider-title">{t("edit.wider.title")}</strong>
          <span className="edit-wider-count gm-data">{total}</span>
          <button
            type="button"
            className={`edit-wider-gear${cfg.controls ? " active" : ""}`}
            aria-expanded={cfg.controls}
            aria-controls="edit-wider-depths"
            aria-label={t("edit.wider.controls")}
            title={t("edit.wider.controls")}
            onClick={() => update({ controls: !cfg.controls })}
          >
            <GearIcon size={14} />
          </button>
        </div>
        {cfg.controls && (
        <div className="edit-wider-depths" id="edit-wider-depths">
          {DEPTHS.map((k) => {
            const [lo, hi] = WIDER_FAMILY_LIMITS[k];
            return (
              <div key={k} className="edit-wider-depth">
                <span className="edit-wider-depth-label" title={t(`edit.wider.${k}.hint`)}>{t(`edit.wider.${k}`)}</span>
                <div className="chart-settings-segmented chart-settings-stepper">
                  <button
                    type="button"
                    disabled={cfg[k] <= lo}
                    aria-label={`${t(`edit.wider.${k}`)}: ${t("tree.settings.generations.fewer")}`}
                    title={t("tree.settings.generations.fewer")}
                    onClick={() => update({ [k]: cfg[k] - 1 })}
                  >
                    −
                  </button>
                  <span className="chart-settings-value" aria-live="polite">{cfg[k]}</span>
                  <button
                    type="button"
                    disabled={cfg[k] >= hi}
                    aria-label={`${t(`edit.wider.${k}`)}: ${t("tree.settings.generations.more")}`}
                    title={t("tree.settings.generations.more")}
                    onClick={() => update({ [k]: cfg[k] + 1 })}
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })}
          <label className="edit-wider-partners">
            <input type="checkbox" checked={cfg.partners} onChange={(e) => update({ partners: e.target.checked })} />
            {t("edit.wider.partners")}
          </label>
        </div>
        )}
      </div>
      <div className="edit-wider-body">
        {groups.length === 0 && <p className="edit-wider-empty muted">{t("edit.wider.empty")}</p>}
        {groups.map((g) => (
          <WiderGroupBlock
            key={`${g.up}:${g.down}`}
            group={g}
            dataset={dataset}
            navigate={navigate}
            showAge={settings.showAge}
          />
        ))}
      </div>
    </aside>
  );
});

function WiderGroupBlock({ group, dataset, navigate, showAge }: {
  group: WiderGroup;
  dataset: Dataset;
  navigate: (id: string) => void;
  showAge: boolean;
}) {
  const { t } = useTranslation();
  const formatName = useNameOf();
  // Every word the group's relatives go by — a mother's brother is named apart
  // from a father's in Slovenian (ujec / stric).
  const lines = [...new Set(group.members.filter((r) => !r.partnerOf).map((r) => r.side))];
  const heading = [...new Set((["M", "F"] as const).flatMap((sex) =>
    (lines.length ? lines : [undefined]).map((side) => kinshipLabelFor(group.up, group.down, sex, t, side)),
  ))].filter(Boolean).join(" · ");

  const chip = (r: WiderRelative) => {
    const indi = dataset.individuals.get(r.id);
    if (!indi) return null;
    const partnerOf = r.partnerOf ? dataset.individuals.get(r.partnerOf) : undefined;
    const lifespan = lifespanWithAge(indi, showAge);
    // The couple's family says how they were joined, and whether that ended.
    const union = partnerOf
      ? unionMark(indi.spouseOf.map((f) => dataset.families.get(f)).find((f) => f?.husband === partnerOf.id || f?.wife === partnerOf.id))
      : undefined;
    const kin = partnerOf
      ? [
          t("edit.wider.partnerOf", { name: formatName(partnerOf) }),
          union?.ended && t(union.ended === "divorced" ? "event.DIV" : "event.SEPA"),
        ].filter(Boolean).join(" · ")
      : kinshipLabelFor(r.up, r.down, indi.sex, t, r.side);
    return (
      <button
        key={r.id}
        type="button"
        className={`edit-wider-person ${sexClass(indi.sex)}${partnerOf ? " in-law" : ""}`}
        title={[kin, lifespanTooltipOf(indi, showAge, t)].filter(Boolean).join(" · ")}
        onClick={() => navigate(r.id)}
      >
        <span className="edit-wider-person-name person-name">
          {union && <span className="edit-wider-marriage" aria-hidden="true">{union.glyph}</span>}
          {formatName(indi)}
        </span>
        {lifespan && <span className="person-years gm-data"><YearsText text={lifespan} approx={lifespanApproxOf(indi)} /></span>}
      </button>
    );
  };

  // Sub-headed by side only where the group runs through one parent's line.
  const sides: WiderSide[] = ["father", "mother", "own"];
  return (
    <section className="edit-wider-group">
      <h3>
        {heading}
        <span className="edit-wider-count gm-data">{group.members.length}</span>
      </h3>
      {sides.map((side) => {
        const list = group.members.filter((r) => r.side === side);
        if (!list.length) return null;
        return (
          <div key={side} className="edit-wider-side">
            {side !== "own" && (
              <div className="edit-wider-side-label">
                {t(side === "father" ? "edit.wider.fatherSide" : "edit.wider.motherSide")}
              </div>
            )}
            {list.map(chip)}
          </div>
        );
      })}
    </section>
  );
}
