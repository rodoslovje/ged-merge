import { useTranslation } from "react-i18next";
import type { FamilyStats } from "../../calendar/stats";
import type { Sex } from "../../gedcom/types";

// "The family in numbers" as a page's picture: big numbers under their labels,
// then small charts that take the room that is left — the known ancestors of
// every generation, the most common surnames, the centuries the family was
// born in — and the oldest known ancestor. Labels sit above their number, so
// no word has to agree with it.

interface Props {
  stats: FamilyStats;
  /** How to name the oldest ancestor, and their sex for the wording. */
  nameOf: (id: string) => string;
  sexOf: (id: string) => Sex | undefined;
}

/** Upright bars, one per generation or century: the count above, the tick below. */
function Columns({ title, bars }: { title: string; bars: [tick: string, n: number][] }) {
  const max = Math.max(1, ...bars.map(([, n]) => n));
  return (
    <div className="cal-stats-chart">
      <div className="cal-stat-label">{title}</div>
      <div className="cal-bars">
        {bars.map(([tick, n], i) => (
          <div key={i} className="cal-bar-col">
            <div style={{ flex: `${1 - n / max} 1 0` }} />
            <div className="cal-bar-num">{n.toLocaleString()}</div>
            <div className="cal-bar" style={{ flex: `${n / max} 1 0` }} />
            <div className="cal-bar-tick">{tick}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatsCard({ stats, nameOf, sexOf }: Props) {
  const { t } = useTranslation();
  const tiles: [string, number][] = [];
  stats.descendantsByGen.forEach((n, i) =>
    tiles.push([i < 4 ? t(`calendar.stats.gen${i + 1}`) : t("calendar.stats.genN", { n: i + 1 }), n]),
  );
  if (stats.descendantsByGen.length > 1) tiles.push([t("calendar.stats.descendants"), stats.descendants]);
  if (stats.ancestors) {
    tiles.push([t("calendar.stats.ancestors"), stats.ancestors]);
    tiles.push([t("calendar.stats.ancestorGens"), stats.ancestorGens]);
  }
  tiles.push([t("calendar.stats.blood"), stats.bloodRelatives]);
  tiles.push([t("calendar.stats.living"), stats.livingBloodRelatives]);
  const oldest = stats.oldestAncestor;
  const sex = oldest && sexOf(oldest.id);
  // A chart of one bar says nothing its number has not said.
  const byGen = stats.ancestorsByGen.length > 1;
  const surnames = stats.topSurnames.length > 1;
  const byCentury = stats.birthsByCentury.length > 1;
  const topCount = stats.topSurnames[0]?.count ?? 1;
  return (
    <div className="cal-stats">
      <div className="cal-stats-title">{t("calendar.stats.title")}</div>
      <div className="cal-stats-grid">
        {tiles.map(([label, n], i) => (
          <div key={i} className="cal-stat">
            <div className="cal-stat-label">{label}</div>
            <div className="cal-stat-num">{n.toLocaleString()}</div>
          </div>
        ))}
      </div>
      {(byGen || surnames || byCentury) && (
        <div className="cal-stats-charts">
          {byGen && <Columns title={t("calendar.stats.byGen")} bars={stats.ancestorsByGen.map((n, i) => [String(i + 1), n])} />}
          {surnames && (
            <div className="cal-stats-chart">
              <div className="cal-stat-label">{t("calendar.stats.surnames")}</div>
              <div className="cal-rows">
                {stats.topSurnames.map((s) => (
                  <div key={s.name} className="cal-row">
                    <div className="cal-row-name">{s.name}</div>
                    <div className="cal-row-track"><div className="cal-row-bar" style={{ width: `${(100 * s.count) / topCount}%` }} /></div>
                    <div className="cal-bar-num">{s.count.toLocaleString()}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {byCentury && <Columns title={t("calendar.stats.byCentury")} bars={stats.birthsByCentury.map((c) => [String(c.century), c.count])} />}
        </div>
      )}
      {oldest && (
        <div className="cal-stats-lines">
          {t("calendar.stats.oldest", { name: nameOf(oldest.id), year: oldest.year, context: sex === "M" || sex === "F" ? sex : undefined })}
        </div>
      )}
    </div>
  );
}
