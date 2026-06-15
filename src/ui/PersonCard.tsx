import type { Individual } from "../gedcom/types";
import { datesTooltipOf, lifespanOf } from "../gedcom/lifespan";
import { displayName, primaryName } from "../match/relatives";
import { sexClass } from "./sex";

interface Props {
  individual?: Individual;
  /** "Father", "Mother", "Partner"… — shown above the card, omitted for children. */
  roleLabel?: string;
  /** Shown instead of a name when `individual` is undefined. */
  placeholder?: string;
  onSelect?: (id: string) => void;
}

/** A clickable card for a relative (parent/partner/child) in the Edit-mode person layout. */
export function PersonCard({ individual, roleLabel, placeholder, onSelect }: Props) {
  if (!individual) {
    return (
      <div className="person-card-wrap">
        {roleLabel && <div className="person-card-role">{roleLabel}</div>}
        <div className="person-card empty">
          <span className="muted">{placeholder}</span>
        </div>
      </div>
    );
  }

  const lifespan = lifespanOf(individual);
  return (
    <div className="person-card-wrap">
      {roleLabel && <div className="person-card-role">{roleLabel}</div>}
      <button
        className={`person-card ${sexClass(individual.sex)}`}
        title={datesTooltipOf(individual)}
        onClick={() => onSelect?.(individual.id)}
      >
        <div className={`person-label ${sexClass(individual.sex)}`}>
          <span className="person-name">{displayName(primaryName(individual))}</span>
          {lifespan && <span className="person-years gm-data">{lifespan}</span>}
        </div>
      </button>
    </div>
  );
}
