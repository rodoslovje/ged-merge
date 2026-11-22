import { useTranslation } from "react-i18next";
import type { FamilyStats } from "../../calendar/stats";
import type { Sex } from "../../gedcom/types";

// "The family in numbers" as a page's picture: big numbers under their labels,
// then the oldest known ancestor and the most common surname. Labels sit above
// their number, so no word has to agree with it.

interface Props {
  stats: FamilyStats;
  /** How to name the oldest ancestor, and their sex for the wording. */
  nameOf: (id: string) => string;
  sexOf: (id: string) => Sex | undefined;
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
      {(oldest || stats.commonSurname) && (
        <div className="cal-stats-lines">
          {oldest && <div>{t("calendar.stats.oldest", { name: nameOf(oldest.id), year: oldest.year, context: sex === "M" || sex === "F" ? sex : undefined })}</div>}
          {stats.commonSurname && <div>{t("calendar.stats.surname", { name: stats.commonSurname.name })}</div>}
        </div>
      )}
    </div>
  );
}
