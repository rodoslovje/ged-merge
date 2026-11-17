import { lazy, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { pubId } from "../publish/hydrate";
import { personMapOf } from "../ui/map/personMap";
import { FanIcon, RelationIcon, TimelineIcon } from "../ui/icons/ChartKindIcons";
import { routeHash } from "./route";

const MiniPlaceMap = lazy(() => import("../ui/map/MiniPlaceMap"));

/**
 * A person's charts, offered beside their name: the fan of ancestors and
 * descendants, their places on a small map, the path to the start person, and
 * their family's timeline. Each opens that chart drawn for them; the map is a
 * true preview, the rest are named by their glyph.
 */
export function PersonCharts({ ds, id, startId, kinship, timeline }: {
  ds: Dataset;
  id: string;
  startId?: string;
  /** How they are related to the start person, for the relationship's tooltip. */
  kinship?: string;
  /** Whether the timeline has anything of theirs to draw. */
  timeline: boolean;
}) {
  const { t } = useTranslation();
  const map = useMemo(() => personMapOf(ds, id, t), [ds, id, t]);
  const href = (kind: string) => routeHash({ page: "charts", id: pubId(id), kind });
  const relation = startId && startId !== id;

  return (
    <nav className="site-charts" aria-label={t("charts.kind.label")}>
      {map && (
        // The map speaks for itself: no caption, no tooltip — only its name for
        // a screen reader.
        <a className="site-chart site-chart-map" href={href("map")} aria-label={t("map.button")}>
          {/* A picture of the map: the link above it takes the clicks. */}
          <span className="site-chart-preview" aria-hidden="true">
            <Suspense fallback={null}>
              <MiniPlaceMap pins={map.pins} path={map.path} fitKey={id} />
            </Suspense>
          </span>
        </a>
      )}
      <a className="site-chart" href={href("fan")} title={t("tree.settings.type.fan")}>
        {/* A half disc: drawn larger, so it reads as large as the others. */}
        <span className="site-chart-glyph"><FanIcon size={32} /></span>
        <span className="site-chart-label">{t("tree.settings.type.fan")}</span>
      </a>
      {timeline && (
        <a className="site-chart" href={href("timeline")} title={t("timeline.button")}>
          <span className="site-chart-glyph"><TimelineIcon size={26} /></span>
          <span className="site-chart-label">{t("timeline.button")}</span>
        </a>
      )}
      {relation && (
        <a className="site-chart" href={href("relationship")} title={kinship ?? t("relpath.button")}>
          <span className="site-chart-glyph"><RelationIcon size={26} /></span>
          <span className="site-chart-label">{t("relpath.button")}</span>
        </a>
      )}
    </nav>
  );
}
