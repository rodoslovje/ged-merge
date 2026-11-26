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
  placeFit,
  placeRowChars,
  truncate,
  wrapAddress,
} from "../chart/treeLayout";
import { ageStandalone, ALL_DISPLAY, familyCountsText, livingLabelFor, nodeDisplay, type FamilyCounts, type NodeDisplayOptions } from "../chart/nodeDisplay";
import { lineageClass, type Lineage } from "../match/kinship";
import { collectFirstFilePath, TreeNodePhoto } from "./PersonMedia";
import { useMediaFolder } from "./MediaFolderContext";
import type { MediaRefContext } from "./MediaViewer";
import { sexColorVar } from "./sex";
import { YearsText } from "./YearsText";
import type { YearsApprox } from "../gedcom/lifespan";

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
  badge: { status: string; letter: string; title?: string } | undefined,
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
        {badge && <NodeBadge x={badgeX} y={yearsY - 4} cls={`tree-node-decision ${badge.status}`} letter={badge.letter} title={badge.title} />}
        {modified && <NodeBadge x={modX} y={yearsY - 4} fill="var(--node-minor)" textFill="var(--bg)" letter={modifiedLetter} />}
      </>
    );
  };
}

/** Glyph width of the counts' 10px monospace digits, and the room an icon takes. */
const COUNT_CHAR_W = 6;
const COUNT_ICON = 10;

/**
 * The sibling and child counts at the end of the lifespan row: each an icon
 * and a number, laid out from the box's right edge. The sibling icon is two
 * people hanging from one bracket — children of the same parents; the child
 * icon one person above the two that hang from them.
 */
function FamilyCountMarks({ parts, title }: { parts: { kind: keyof FamilyCounts; n: number }[]; title: string }) {
  let right = NODE_W - 12;
  const placed = [...parts].reverse().map(({ kind, n }) => {
    const text = String(n);
    const x = right - text.length * COUNT_CHAR_W - 3 - COUNT_ICON;
    right = x - 8;
    return { kind, text, x };
  });
  return (
    <g className="tree-node-counts">
      <title>{title}</title>
      {placed.map(({ kind, text, x }) => (
        <g key={kind} transform={`translate(${x},${DETAIL_ROW_TOP - 9})`}>
          {kind === "siblings" ? (
            <>
              <path className="tree-node-counts-line" d="M5,0 V2.5 M2,5 V2.5 H8 V5" />
              <circle cx={2} cy={7.4} r={1.9} />
              <circle cx={8} cy={7.4} r={1.9} />
            </>
          ) : (
            <>
              <circle cx={5} cy={2} r={1.9} />
              <path className="tree-node-counts-line" d="M5,4 V5.5 M2,7 V5.5 H8 V7" />
              <circle cx={2} cy={8.5} r={1.4} />
              <circle cx={8} cy={8.5} r={1.4} />
            </>
          )}
          <text className="tree-node-place gm-data" x={COUNT_ICON + 3} y={9}>{text}</text>
        </g>
      ))}
    </g>
  );
}

interface Props {
  name: string;
  years?: string;
  /** Which of `years` stand on an approximate date — set in italics. */
  yearsApprox?: YearsApprox;
  /** Whole-years age, folded into the lifespan line when the Age toggle is on. */
  age?: number;
  /** First-available place (last residence → birth → death); shown on its own row when enabled. */
  place?: string;
  /** The person's address, written on the place row when the Address toggle is on. */
  address?: string;
  /** Sibling and child counts, written at the end of the lifespan row when shown. */
  familyCounts?: FamilyCounts;
  sex?: Sex | string;
  /** State colour for the border and the tinted fill. */
  color: string;
  strokeWidth?: number;
  /** Fill strength (percent of the colour in the panel); a Color axis in
   *  force asks for more than the plain chart's 16. */
  tint?: number;
  /** Kinship label; shown on its own row beneath the lifespan and place. */
  kinship?: string;
  /** Blood lineage of the kinship, for colour-coding the kinship row. */
  kinshipLineage?: Lineage;
  /** The start person's direct line (ancestor or descendant): name and kinship are bold. */
  kinshipDirect?: boolean;
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
  /** The name a redacted person keeps (see `NodeDisplayInput.livingName`). */
  livingName?: string;
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
  yearsApprox,
  age,
  place,
  address,
  familyCounts,
  sex,
  color,
  strokeWidth = 2.5,
  tint = 16,
  kinship,
  kinshipLineage,
  kinshipDirect,
  photo,
  badges,
  display = ALL_DISPLAY,
  living = false,
  livingName,
  nodeH = NODE_H,
}: Props) {
  const { t } = useTranslation();
  const { folderName } = useMediaFolder();
  const disp = nodeDisplay(display, { name, years, yearsApprox, age, ageText: age !== undefined ? ageStandalone(t, sex, age) : undefined, place, address, familyCounts, kinship, kinshipLineage, kinshipDirect, living, livingLabel: livingLabelFor(t, sex), livingName });
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
  // Lifespan, then address and place, then kinship — each on its own row beneath the name.
  const rows: { text: string; cls: string; approx?: YearsApprox; fit?: ReturnType<typeof placeFit> }[] = [];
  const placeChars = placeRowChars(textX);
  // The counts stand at the end of the lifespan row, which they keep for
  // themselves when the person has no years to write there.
  const counts = familyCountsText(t, disp.familyCounts);
  if (disp.years || counts) rows.push({ text: disp.years ?? "", cls: "tree-node-year", approx: disp.yearsApprox });
  for (const text of disp.address ? wrapAddress(disp.address, display.addressLines === 2 ? 2 : 1, placeChars) : []) {
    rows.push({ text, cls: "tree-node-place tree-node-address", fit: placeFit(text, textX) });
  }
  if (disp.place) {
    const text = truncate(disp.place, placeChars);
    rows.push({ text, cls: "tree-node-place", fit: placeFit(text, textX) });
  }
  if (disp.kinship) rows.push({ text: disp.kinship, cls: `tree-node-kinship ${lineageClass(disp.kinshipLineage, disp.kinshipDirect)}` });
  return (
    <>
      <rect
        width={NODE_W}
        height={nodeH}
        rx={10}
        ry={10}
        fill={`color-mix(in srgb, ${color} ${tint}%, var(--panel))`}
        stroke={color}
        strokeWidth={strokeWidth}
      />
      <text className={`tree-node-name${disp.kinshipDirect ? " kinship-direct" : ""}`} x={textX} y={23} style={{ fill: sexColorVar(sex) ?? "#fff" }} {...nameFit(disp.name, textX)}>
        {disp.name}
      </text>
      {rows.map((r, i) => (
        <text key={i} className={`${r.cls} gm-data`} x={textX} y={DETAIL_ROW_TOP + i * DETAIL_ROW_H} {...r.fit}>
          <YearsText text={r.text} approx={r.approx} svg />
        </text>
      ))}
      {counts && <FamilyCountMarks parts={counts.parts} title={counts.full} />}
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
