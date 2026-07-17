import { lineageClass, type Lineage } from "../match/kinship";

// The shared chart-page title: root person's name in their sex colour, the
// lifespan (with age when the Age display toggle is on — the caller builds
// the string via lifespanLine), the kinship-to-start chip, and the page-kind
// label. One component so every hub page (pedigree trees, timeline, map,
// report) renders the identical header.

interface Props {
  name: string;
  /** Sex CSS class from sexClass(); empty string when unknown. */
  sexCls?: string;
  /** Lifespan (+ age) line, already formatted by lifespanLine. */
  years?: string;
  /** Kinship-to-start label; omitted when kinship display is off. */
  kinship?: string;
  lineage?: Lineage;
  /** Page-kind label ("Ancestors Fan Chart", "Places Map", …). */
  kind: string;
}

export function ChartRootTitle({ name, sexCls = "", years, kinship, lineage, kind }: Props) {
  return (
    <>
      <span className={`tree-title-name ${sexCls}`}>{name}</span>
      {years && <span className="tree-title-years gm-data">{years}</span>}
      <span className="tree-title-break" aria-hidden="true" />
      {kinship && <span className={`tree-title-kinship ${lineageClass(lineage)}`}>{kinship}</span>}
      <span className="tree-title-kind">{kind}</span>
    </>
  );
}
