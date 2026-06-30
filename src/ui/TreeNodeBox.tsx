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
  truncate,
} from "../tree/treeLayout";
import { ALL_DISPLAY, nodeDisplay, type NodeDisplayOptions } from "../tree/nodeDisplay";
import { lineageClass, type Lineage } from "../match/kinship";
import { collectFirstFilePath, TreeNodePhoto } from "./PersonPhotos";
import { useMediaFolder } from "./MediaFolderContext";
import type { PhotoRefContext } from "./PhotoViewer";
import { sexColorVar } from "./sex";

export interface NodePhotoSource {
  raw: GedNode;
  records: GedNode[];
  refCtx?: PhotoRefContext;
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
  /** Master photo source; the thumbnail shows only when a file is actually
   *  present — a person without a photo leaves no reserved gap (text goes hard left). */
  photo?: NodePhotoSource;
  /** SVG badges to overlay, given the resolved text geometry. */
  badges?: (ctx: { yearsY: number; textX: number }) => ReactNode;
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
 * row beneath it, plus the person's first photo. The Chart-settings toggles (and
 * the privacy redaction of living people) are applied via {@link nodeDisplay}.
 * Returns the inner SVG only — render it inside a positioned `<g transform>` that
 * owns the selection class and click handling.
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
  const photoPath = disp.showPhoto && photo && folderName ? collectFirstFilePath(photo.raw, photo.records) : null;
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
      <text className="tree-node-name" x={textX} y={23} style={{ fill: sexColorVar(sex) ?? "#fff" }}>
        {truncate(disp.name, 24)}
      </text>
      {rows.map((r, i) => (
        <text key={r.cls} className={`${r.cls} gm-data`} x={textX} y={DETAIL_ROW_TOP + i * DETAIL_ROW_H}>
          {r.text}
        </text>
      ))}
      {photoPath && photo && (
        <TreeNodePhoto
          node={{ master: { raw: photo.raw } }}
          masterRecords={photo.records}
          masterRefCtx={photo.refCtx}
          x={PHOTO_X}
          y={photoY}
          size={PHOTO_SIZE}
        />
      )}
      {badges?.({ yearsY: DETAIL_ROW_TOP, textX })}
    </>
  );
}
