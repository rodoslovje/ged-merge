import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { lifespanTooltipOf, lifespanWithAge } from "../../gedcom/age";
import { kinshipLabelFor } from "../../match/kinship";
import { widerFamily, type WiderGroup, type WiderRelative, type WiderSide } from "../../chart/widerFamily";
import { useNameOf, useSetSettings, useSettingsSlice, WIDER_FAMILY_LIMITS, type WiderFamilySettings } from "../SettingsContext";
import { sexClass } from "../sex";

/** The preferences this file reads — subscribed field by field. */
const SETTINGS_KEYS = ["widerFamily", "showAge"] as const;

/** A group longer than this folds the rest behind "+N more". */
const GROUP_CAP = 6;

type DepthKey = keyof typeof WIDER_FAMILY_LIMITS;
const DEPTHS: DepthKey[] = ["ancestors", "descendants", "others"];

/**
 * The Edit view's right-hand rail: the person's relatives beyond the cards —
 * grandparents, uncles and aunts, cousins, nephews, grandchildren — grouped by
 * relationship, nearest first, each one click from their own page. Three
 * steppers set how far it reaches (see {@link widerFamily}); folded, it is a
 * narrow tab and computes nothing.
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
  // Groups unfolded past the cap, per person: another person starts folded.
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());

  if (!cfg.open) {
    return (
      <button
        type="button"
        className="edit-wider-tab"
        aria-expanded={false}
        title={t("edit.wider.show")}
        onClick={() => update({ open: true })}
      >
        <span aria-hidden="true">«</span>
        <span className="edit-wider-tab-label">{t("edit.wider.title")}</span>
      </button>
    );
  }

  const total = groups.reduce((n, g) => n + g.members.length, 0);
  return (
    <aside className="edit-wider" aria-labelledby="edit-wider-title">
      <div className="edit-wider-head">
        <div className="edit-wider-title">
          <strong id="edit-wider-title">{t("edit.wider.title")}</strong>
          <span className="edit-wider-count gm-data">{total}</span>
          <button
            type="button"
            className="edit-wider-fold"
            aria-expanded={true}
            title={t("edit.wider.hide")}
            onClick={() => update({ open: false })}
          >
            »
          </button>
        </div>
        <div className="edit-wider-depths">
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
      </div>
      <div className="edit-wider-body">
        {groups.length === 0 && <p className="edit-wider-empty muted">{t("edit.wider.empty")}</p>}
        {groups.map((g) => {
          const key = `${personId}|${g.up}:${g.down}`;
          return (
            <WiderGroupBlock
              key={key}
              group={g}
              dataset={dataset}
              navigate={navigate}
              showAge={settings.showAge}
              unfolded={unfolded.has(key)}
              onUnfold={() => setUnfolded((prev) => new Set(prev).add(key))}
            />
          );
        })}
      </div>
    </aside>
  );
});

function WiderGroupBlock({ group, dataset, navigate, showAge, unfolded, onUnfold }: {
  group: WiderGroup;
  dataset: Dataset;
  navigate: (id: string) => void;
  showAge: boolean;
  unfolded: boolean;
  onUnfold: () => void;
}) {
  const { t } = useTranslation();
  const formatName = useNameOf();
  const male = kinshipLabelFor(group.up, group.down, "M", t);
  const female = kinshipLabelFor(group.up, group.down, "F", t);
  const heading = male === female ? male : `${male} · ${female}`;
  const members = unfolded ? group.members : group.members.slice(0, GROUP_CAP);
  const hidden = group.members.length - members.length;

  const chip = (r: WiderRelative) => {
    const indi = dataset.individuals.get(r.id);
    if (!indi) return null;
    const partnerOf = r.partnerOf ? dataset.individuals.get(r.partnerOf) : undefined;
    const lifespan = lifespanWithAge(indi, showAge);
    const kin = partnerOf
      ? t("edit.wider.partnerOf", { name: formatName(partnerOf) })
      : kinshipLabelFor(r.up, r.down, indi.sex, t);
    return (
      <button
        key={r.id}
        type="button"
        className={`edit-wider-person ${sexClass(indi.sex)}${partnerOf ? " in-law" : ""}`}
        title={[kin, lifespanTooltipOf(indi, showAge, t)].filter(Boolean).join(" · ")}
        onClick={() => navigate(r.id)}
      >
        <span className="edit-wider-person-name person-name">{formatName(indi)}</span>
        {lifespan && <span className="person-years gm-data">{lifespan}</span>}
        {partnerOf && <span className="edit-wider-person-kin">{kin}</span>}
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
        const list = members.filter((r) => r.side === side);
        if (!list.length) return null;
        return (
          <div key={side} className="edit-wider-side">
            {side !== "own" && (
              <div className={`edit-wider-side-label ${side === "father" ? "paternal" : "maternal"}`}>
                {t(side === "father" ? "edit.wider.fatherSide" : "edit.wider.motherSide")}
              </div>
            )}
            {list.map(chip)}
          </div>
        );
      })}
      {hidden > 0 && (
        <button type="button" className="edit-wider-more" onClick={onUnfold}>
          {t("edit.wider.more", { count: hidden })}
        </button>
      )}
    </section>
  );
}
