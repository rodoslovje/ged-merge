import type { Dataset } from "../gedcom/types";
import { datesTooltipOf, lifespanOf } from "../gedcom/lifespan";
import { lifespanAge } from "../gedcom/age";
import { lifespanLine } from "../chart/nodeDisplay";
import { xrefLabel } from "../gedcom/nameDisplay";
import { useNameOf, useSettings } from "./SettingsContext";
import { sexClass } from "./sex";

interface Props {
  dataset: Dataset;
  /** Record xref to navigate to and look up. */
  id: string;
  /** Label shown when `id` is not an individual (e.g. a family) or is missing. */
  fallback: string;
  onNavigate: (id: string) => void;
  /**
   * Show the record id even when the global "Show record IDs" preference is off.
   * For views whose whole job is telling look-alike records apart (the
   * duplicate finder), where the id is the disambiguator, not decoration.
   */
  forceXref?: boolean;
}

/**
 * A clickable person reference styled like everywhere else in the app: the name
 * in its sex colour followed by a muted lifespan. Falls back to a plain label
 * for non-individual (family) or unresolved records.
 */
export function PersonLink({ dataset, id, fallback, onNavigate, forceXref = false }: Props) {
  const nameOf = useNameOf();
  const { settings } = useSettings();
  const indi = dataset.individuals.get(id);
  if (!indi) {
    return (
      <button className="tools-issue-link" onClick={() => onNavigate(id)} title={id}>
        {fallback}
      </button>
    );
  }
  // The global "Show ages" preference folds the age into the lifespan,
  // matching person headers and chart titles ("1810–1881 (71)").
  const lifespan = lifespanLine(
    { showLifespan: true, showAge: settings.showAge },
    { years: lifespanOf(indi), age: lifespanAge(indi) },
  );
  return (
    <button
      className="tools-issue-link person-ref"
      onClick={() => onNavigate(id)}
      title={datesTooltipOf(indi)}
    >
      <span className={`person-name ${sexClass(indi.sex)}`}>{nameOf(indi)}</span>
      {(settings.showXref || forceXref) && <span className="person-xref gm-data">{xrefLabel(indi.id)}</span>}
      {lifespan && <span className="person-years gm-data">{lifespan}</span>}
    </button>
  );
}
