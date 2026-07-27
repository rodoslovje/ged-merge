import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { scanPlaceCoords } from "../../tools/placeCoords";

/**
 * Same place and same address, yet different coordinates — one location
 * described two ways, so no automatic fix: only the researcher knows which is
 * right. Different addresses in one settlement are *not* listed; those
 * legitimately differ, which is the whole point of keying by place + address.
 *
 * It lives on the geocode page rather than in the health check because that is
 * where coordinates are read, compared and written — the reader who can settle a
 * contradiction is already here, with the register and the maps at hand.
 */
export function CoordConflicts({ dataset }: { dataset: Dataset }) {
  const { t } = useTranslation();
  const conflicts = useMemo(() => scanPlaceCoords(dataset).conflicts, [dataset]);
  if (!conflicts.length) return null;

  return (
    <section className="tools-cleanup-section">
      <div className="tools-dup-kind-head">{t("tools.validate.coordConflict.title")}</div>
      <p className="tools-intro">{t("tools.validate.coordConflict.hint", { count: conflicts.length })}</p>
      <ul className="tools-issues">
        {conflicts.slice(0, 200).map((c, i) => (
          <li key={`${c.value}\u0000${c.address}`} className={`tools-issue sev-warning${i % 2 ? " zebra" : ""}`}>
            <span className="tools-issue-msg">{c.address ? `${c.value} · ${c.address}` : c.value}</span>
            <span className="gm-data">
              {c.coords.map((x) => `${x.coord.lat.toFixed(4)}, ${x.coord.lon.toFixed(4)} (${x.n})`).join("  ·  ")}
            </span>
          </li>
        ))}
      </ul>
      {conflicts.length > 200 && (
        <p className="tools-fix-hint">{t("tools.geocode.more", { count: conflicts.length - 200 })}</p>
      )}
    </section>
  );
}
