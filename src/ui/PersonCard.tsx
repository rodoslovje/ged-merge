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
  /** Called when the empty placeholder is clicked, to add a new relative. */
  onAdd?: () => void;
  /** Called to detach this relative; shows a × button on card hover. */
  onRemove?: () => void;
  /** Tooltip for the × detach button. */
  removeTooltip?: string;
  /** Kinship label relative to the home person, e.g. "Son", "Spouse". */
  kinship?: string;
  /** Long-form tooltip for the kinship badge, e.g. "Son of Luka Renko". */
  kinshipTooltip?: string;
  /** Merge-decision status ("confirmed" | "rejected" | "deferred") for this relative's own match, if any. */
  decisionStatus?: "confirmed" | "rejected" | "deferred";
  /** Single letter shown in the status chip, e.g. "C" for confirmed (already localized). */
  decisionLetter?: string;
  /** Tooltip for the status chip, e.g. "Confirmed". */
  decisionTooltip?: string;
}

/** A clickable card for a relative (parent/partner/child) in the Edit-mode person layout. */
export function PersonCard({ individual, roleLabel, placeholder, onSelect, onAdd, onRemove, removeTooltip, kinship, kinshipTooltip, decisionStatus, decisionLetter, decisionTooltip }: Props) {
  if (!individual) {
    return (
      <div className="person-card-wrap">
        {roleLabel && <div className="person-card-role">{roleLabel}</div>}
        {onAdd ? (
          <button className="person-card empty person-card-add" onClick={onAdd}>
            <span className="muted">{placeholder}</span>
          </button>
        ) : (
          <div className="person-card empty">
            <span className="muted">{placeholder}</span>
          </div>
        )}
      </div>
    );
  }

  const lifespan = lifespanOf(individual);
  return (
    <div className="person-card-wrap">
      {roleLabel && <div className="person-card-role">{roleLabel}</div>}
      <div className="person-card-row">
        <button
          className={`person-card ${sexClass(individual.sex)}`}
          title={datesTooltipOf(individual)}
          onClick={() => onSelect?.(individual.id)}
        >
          <div className={`person-label ${sexClass(individual.sex)}`}>
            <span className="person-name">{displayName(primaryName(individual))}</span>
            {(lifespan || kinship || decisionStatus) && (
              <div className="person-card-meta">
                {lifespan && <span className="person-years gm-data">{lifespan}</span>}
                {decisionStatus && (
                  <span className={`status-chip ${decisionStatus}`} title={decisionTooltip}>
                    {decisionLetter}
                  </span>
                )}
                {kinship && <span className="person-kinship" title={kinshipTooltip}>{kinship}</span>}
              </div>
            )}
          </div>
        </button>
        {onRemove && (
          <button type="button" className="person-card-detach" title={removeTooltip} onClick={onRemove}>
            ×
          </button>
        )}
      </div>
    </div>
  );
}
