import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { GedNode, Sex } from "../gedcom/types";
import {
  DETAIL_ROW_H,
  DETAIL_ROW_TOP,
  NODE_H,
  NODE_W,
  PHOTO_SIZE,
  PHOTO_X,
  TEXT_X_PHOTO,
  TEXT_X_PLAIN,
  nameFit,
  truncate,
} from "../chart/treeLayout";
import { ageStandalone, ALL_DISPLAY, livingLabelFor, nodeDisplay, type NodeDisplayOptions } from "../chart/nodeDisplay";
import { lineageClass, type Lineage } from "../match/kinship";
import { collectFirstFilePath, TreeNodePhoto } from "./PersonMedia";
import { useMediaFolder } from "./MediaFolderContext";
import type { MediaRefContext } from "./MediaViewer";
import { sexColorVar } from "./sex";

/** Photo source for a node box — either side of a compare pair (main first).
 *  Mirrors {@link TreeNodePhoto}'s props; single-file views pass main only. */
export interface NodePhotoSource {
  node: { main?: { raw: GedNode }; incoming?: { raw: GedNode } };
  mainRecords: GedNode[];
  compareRecords?: GedNode[];
  mainRefCtx?: MediaRefContext;
  compareRefCtx?: MediaRefContext;
}

/** The small letter-in-a-circle status badge (decision / modified / import),
 *  shared by the layered node boxes and the fan segments. Colour comes from
 *  `cls` (a themed `.tree-node-decision <status>` class) or explicit fills.
 *  A multi-character label (the generation limit's "+12") stretches the circle
 *  into a pill so the count fits — everything else stays a dot. `compact` draws
 *  the marker at about two thirds size, for the fan's crowded outer rings. */
export function NodeBadge({
  x,
  y,
  letter,
  cls,
  fill,
  textFill,
  title,
  compact = false,
}: {
  x: number;
  y: number;
  letter: string;
  cls?: string;
  fill?: string;
  textFill?: string;
  /** Hover explanation for the badge; overrides the node's own tooltip. */
  title?: string;
  compact?: boolean;
}) {
  const r = compact ? 5 : 7;
  const fontSize = compact ? 7 : 9;
  // ~0.6px per character per font pixel at 700, plus the circle's own padding.
  const w = letter.length > 1 ? r + 2 + letter.length * fontSize * 0.6 : 0;
  return (
    <g className={cls ?? "tree-node-decision"} transform={`translate(${x},${y})`}>
      {title && <title>{title}</title>}
      {w ? (
        <rect x={-w / 2} y={-r} width={w} height={r * 2} rx={r} ry={r} fill={fill} />
      ) : (
        <circle r={r} fill={fill} />
      )}
      <text textAnchor="middle" dominantBaseline="central" x={0} y={0.5} fontSize={fontSize} fontWeight={700} fill={textFill}>
        {letter}
      </text>
    </g>
  );
}

/** The standard status-badges render-prop: the decision/import letter chip,
 *  then the modified "M", sitting just past the displayed lifespan. Undefined
 *  when there is nothing to draw, so the box skips the badges layer entirely.
 *  Shared by the layered TreeSvg and the relationship chart's boxes. */
export function nodeStatusBadges(
  badge: { status: string; letter: string } | undefined,
  modified: boolean,
  modifiedLetter: string,
): ((ctx: { yearsY: number; textX: number; years?: string }) => ReactNode) | undefined {
  if (!badge && !modified) return undefined;
  return ({ yearsY, textX, years }) => {
    // Estimate the displayed years label width (~6.5px/char) so badges sit just
    // past it; the decision badge comes first, the M steps right when both show.
    const badgeX = textX + (years ? years.length * 6.5 + 8 : 0) + 7;
    const modX = badge ? badgeX + 18 : badgeX;
    return (
      <>
        {badge && <NodeBadge x={badgeX} y={yearsY - 4} cls={`tree-node-decision ${badge.status}`} letter={badge.letter} />}
        {modified && <NodeBadge x={modX} y={yearsY - 4} fill="var(--node-minor)" textFill="var(--bg)" letter={modifiedLetter} />}
      </>
    );
  };
}

interface Props {
  name: string;
  years?: string;
  /** Whole-years age, folded into the lifespan line when the Age toggle is on. */
  age?: number;
  /** First-available place (birth → residence → death); shown on its own row when enabled. */
  place?: string;
  sex?: Sex | string;
  /** State colour for the border and the tinted fill. */
  color: string;
  strokeWidth?: number;
  /** Kinship label; shown on its own row beneath the lifespan and place. */
  kinship?: string;
  /** Blood lineage of the kinship, for colour-coding the kinship row. */
  kinshipLineage?: Lineage;
  /** Photo source; the thumbnail shows only when a file is actually present —
   *  a person without a photo leaves no reserved gap (text goes hard left). */
  photo?: NodePhotoSource;
  /** SVG badges to overlay, given the resolved text geometry. `years` is the
   *  lifespan as actually displayed (absent when hidden or privacy-redacted),
   *  so badge offsets track the real text, not the raw data. */
  badges?: (ctx: { yearsY: number; textX: number; years?: string }) => ReactNode;
  /** Which fields to show; defaults to all-on. */
  display?: NodeDisplayOptions;
  /** Presumed living — redacted under the privacy toggle. */
  living?: boolean;
  /** Box height for the current display settings (grows per enabled detail row). */
  nodeH?: number;
}

/**
 * The shared node-box contents for every full-page diagram (Edit Tree, Compare
 * Tree, Relationship chart): a rounded rect tinted by the state colour, the name
 * coloured by sex, and the lifespan / place / kinship each on their own stacked
 * row beneath it, plus the person's first photo (from either side of a compare
 * pair). The Chart-settings toggles (and the privacy redaction of living people)
 * are applied via {@link nodeDisplay}. Returns the inner SVG only — render it
 * inside a positioned `<g transform>` that owns the selection class and click
 * handling.
 */
export function TreeNodeBox({
  name,
  years,
  age,
  place,
  sex,
  color,
  strokeWidth = 2.5,
  kinship,
  kinshipLineage,
  photo,
  badges,
  display = ALL_DISPLAY,
  living = false,
  nodeH = NODE_H,
}: Props) {
  const { t } = useTranslation();
  const { folderName } = useMediaFolder();
  const disp = nodeDisplay(display, { name, years, age, ageText: age !== undefined ? ageStandalone(t, sex, age) : undefined, place, kinship, kinshipLineage, living, livingLabel: livingLabelFor(t, sex) });
  // Main side first, then incoming — the same order TreeNodePhoto resolves.
  const photoPath =
    disp.showPhoto && photo && folderName
      ? (photo.node.main && collectFirstFilePath(photo.node.main.raw, photo.mainRecords)) ||
        (photo.node.incoming && photo.compareRecords
          ? collectFirstFilePath(photo.node.incoming.raw, photo.compareRecords)
          : null)
      : null;
  const textX = photoPath ? TEXT_X_PHOTO : TEXT_X_PLAIN;
  const photoY = (nodeH - PHOTO_SIZE) / 2;
  // Lifespan, then place, then kinship — each on its own row beneath the name.
  const rows: { text: string; cls: string }[] = [];
  if (disp.years) rows.push({ text: disp.years, cls: "tree-node-year" });
  if (disp.place) rows.push({ text: truncate(disp.place, 26), cls: "tree-node-place" });
  if (disp.kinship) rows.push({ text: disp.kinship, cls: `tree-node-kinship ${lineageClass(disp.kinshipLineage)}` });
  return (
    <>
      <rect
        width={NODE_W}
        height={nodeH}
        rx={10}
        ry={10}
        fill={`color-mix(in srgb, ${color} 16%, var(--panel))`}
        stroke={color}
        strokeWidth={strokeWidth}
      />
      <text className="tree-node-name" x={textX} y={23} style={{ fill: sexColorVar(sex) ?? "#fff" }} {...nameFit(disp.name, textX)}>
        {disp.name}
      </text>
      {rows.map((r, i) => (
        <text key={r.cls} className={`${r.cls} gm-data`} x={textX} y={DETAIL_ROW_TOP + i * DETAIL_ROW_H}>
          {r.text}
        </text>
      ))}
      {photoPath && photo && (
        <TreeNodePhoto
          node={photo.node}
          mainRecords={photo.mainRecords}
          compareRecords={photo.compareRecords}
          mainRefCtx={photo.mainRefCtx}
          compareRefCtx={photo.compareRefCtx}
          x={PHOTO_X}
          y={photoY}
          size={PHOTO_SIZE}
        />
      )}
      {badges?.({ yearsY: DETAIL_ROW_TOP, textX, years: disp.years })}
    </>
  );
}
