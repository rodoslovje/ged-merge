import type { ReactNode } from "react";
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
} from "../tree/treeLayout";
import { ALL_DISPLAY, nodeDisplay, type NodeDisplayOptions } from "../tree/nodeDisplay";
import { lineageClass, type Lineage } from "../match/kinship";
import { collectFirstFilePath, TreeNodePhoto } from "./PersonPhotos";
import { useMediaFolder } from "./MediaFolderContext";
import type { PhotoRefContext } from "./PhotoViewer";
import { sexColorVar } from "./sex";

/** Photo source for a node box — either side of a compare pair (master first).
 *  Mirrors {@link TreeNodePhoto}'s props; single-file views pass master only. */
export interface NodePhotoSource {
  node: { master?: { raw: GedNode }; incoming?: { raw: GedNode } };
  masterRecords: GedNode[];
  compareRecords?: GedNode[];
  masterRefCtx?: PhotoRefContext;
  compareRefCtx?: PhotoRefContext;
}

/** The small letter-in-a-circle status badge (decision / modified / import),
 *  shared by the layered node boxes and the fan segments. Colour comes from
 *  `cls` (a themed `.tree-node-decision <status>` class) or explicit fills. */
export function NodeBadge({
  x,
  y,
  letter,
  cls,
  fill,
  textFill,
}: {
  x: number;
  y: number;
  letter: string;
  cls?: string;
  fill?: string;
  textFill?: string;
}) {
  return (
    <g className={cls ?? "tree-node-decision"} transform={`translate(${x},${y})`}>
      <circle r={7} fill={fill} />
      <text textAnchor="middle" dominantBaseline="central" x={0} y={0.5} fontSize={9} fontWeight={700} fill={textFill}>
        {letter}
      </text>
    </g>
  );
}

interface Props {
  name: string;
  years?: string;
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
  /** Localized "Living" placeholder for a redacted living person without a kinship. */
  livingLabel?: string;
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
  livingLabel = "Living",
  nodeH = NODE_H,
}: Props) {
  const { folderName } = useMediaFolder();
  const disp = nodeDisplay(display, { name, years, place, kinship, kinshipLineage, living, livingLabel });
  // Master side first, then incoming — the same order TreeNodePhoto resolves.
  const photoPath =
    disp.showPhoto && photo && folderName
      ? (photo.node.master && collectFirstFilePath(photo.node.master.raw, photo.masterRecords)) ||
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
          masterRecords={photo.masterRecords}
          compareRecords={photo.compareRecords}
          masterRefCtx={photo.masterRefCtx}
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
