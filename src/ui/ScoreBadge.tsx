import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatFieldLabel } from "../review/fields";
import { formatScore, type Candidate } from "./matchView";
import { useScoreDetail } from "./scoreDetail";

/**
 * A match's score, coloured by its category, with the per-component breakdown
 * as its tooltip — fetched from the worker the first time it is hovered (see
 * `useScoreDetail`). The match list, the compare header and the Compare Tree's
 * person panel all show it the same way.
 */
export function ScoreBadge({ candidate, className }: { candidate: Candidate; className?: string }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const components = useScoreDetail(candidate.mainId, candidate.compareId, hovered);
  const tooltip = useMemo(
    () =>
      candidate.score === 1 || !components
        ? undefined
        : components
            .map((c) => {
              const label = t(`score.${c.key}`, { defaultValue: formatFieldLabel(t, c.key) });
              // Only a compared pair of values ("Stane ~ Stanislav") is worth
              // showing; the relatives' components carry just their own name.
              const detail = c.score !== 1 && c.detail?.includes("~") ? ` (${c.detail})` : "";
              const missing = c.missing ? ` ${t("score.missing")}` : "";
              return `${label}: ${Math.round(c.score * 100)}%${missing}${detail}`;
            })
            .join("\n"),
    [candidate.score, components, t],
  );
  return (
    <span
      className={`badge ${candidate.category}${className ? ` ${className}` : ""}`}
      title={tooltip}
      onMouseEnter={() => setHovered(true)}
    >
      {formatScore(candidate.score)}
    </span>
  );
}
