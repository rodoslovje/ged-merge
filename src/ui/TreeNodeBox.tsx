import type { ReactNode } from "react";
import type { GedNode, Sex } from "../gedcom/types";
import {
  NODE_H,
  NODE_W,
  PHOTO_SIZE,
  PHOTO_X,
  PHOTO_Y,
  TEXT_X_PHOTO,
  TEXT_X_PLAIN,
  kinshipRowLayout,
  truncate,
} from "../tree/treeLayout";
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
  sex?: Sex | string;
  /** State colour for the border and the tinted fill. */
  color: string;
  strokeWidth?: number;
  /** Right-aligned kinship label; wraps onto its own row when it would collide with the years. */
  kinship?: string;
  /** Master photo source; the thumbnail shows only when a file is actually
   *  present — a person without a photo leaves no reserved gap (text goes hard left). */
  photo?: NodePhotoSource;
  /** Extra width reserved after the years for badges, so the kinship wrap accounts for them. */
  badgeWidth?: number;
  /** SVG badges to overlay, given the resolved text geometry. */
  badges?: (ctx: { yearsY: number; textX: number }) => ReactNode;
}

/**
 * The shared node-box contents for every full-page diagram (Edit Tree, Compare
 * Tree, Relationship chart): a rounded rect tinted by the state colour, the name
 * coloured by sex, the lifespan, an optional right-aligned kinship label (wrapping
 * to its own row on collision), and the person's first photo. Returns the inner
 * SVG only — render it inside a positioned `<g transform>` that owns the
 * selection class and click handling.
 */
export function TreeNodeBox({ name, years, sex, color, strokeWidth = 2.5, kinship, photo, badgeWidth = 0, badges }: Props) {
  const { folderName } = useMediaFolder();
  const photoPath = photo && folderName ? collectFirstFilePath(photo.raw, photo.records) : null;
  const textX = photoPath ? TEXT_X_PHOTO : TEXT_X_PLAIN;
  const { yearsY, kinshipY } = kinshipRowLayout(years, kinship, badgeWidth);
  return (
    <>
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={10}
        ry={10}
        fill={`color-mix(in srgb, ${color} 16%, var(--panel))`}
        stroke={color}
        strokeWidth={strokeWidth}
      />
      <text className="tree-node-name" x={textX} y={23} style={{ fill: sexColorVar(sex) ?? "#fff" }}>
        {truncate(name, 24)}
      </text>
      {years && (
        <text className="tree-node-year gm-data" x={textX} y={yearsY}>
          {years}
        </text>
      )}
      {kinship && (
        <text className="tree-node-kinship gm-data" x={NODE_W - 8} y={kinshipY} textAnchor="end">
          {kinship}
        </text>
      )}
      {photoPath && photo && (
        <TreeNodePhoto
          node={{ master: { raw: photo.raw } }}
          masterRecords={photo.records}
          masterRefCtx={photo.refCtx}
          x={PHOTO_X}
          y={PHOTO_Y}
          size={PHOTO_SIZE}
        />
      )}
      {badges?.({ yearsY, textX })}
    </>
  );
}
