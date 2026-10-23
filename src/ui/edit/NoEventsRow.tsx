import type { NegativeAssertion } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { eventDisplayLabel } from "../../gedcom/eventTags";
import { AddEventSelect } from "./AddEventSelect";

/**
 * The events a record states did *not* happen (GEDCOM 7 `NO`): one chip per
 * statement — the event's name, and the period when the statement is limited to
 * one — with a × that withdraws it. Renders nothing when there are none; the
 * menu that adds one is {@link AddNoEventSelect}, which sits with the record's
 * other "+ Add" chips.
 */
export function NoEventsRow({
  assertions,
  t,
  onRemove,
}: {
  assertions: NegativeAssertion[];
  t: Translate;
  onRemove: (tag: string) => void;
}) {
  if (!assertions.length) return null;
  return (
    <div className="edit-event-add-row edit-no-events">
      <span className="edit-no-events-label">{t("edit.noEvent.label")}</span>
      {assertions.map((a) => {
        const event = eventDisplayLabel(a.tag, t);
        return (
          <span key={a.tag} className="edit-name-chip edit-no-event" title={a.note}>
            <span aria-hidden="true">⊘</span> {event}
            {a.date?.raw && <span className="edit-no-event-date"> ({a.date.raw})</span>}
            <button
              type="button"
              className="edit-no-event-remove"
              title={t("edit.noEvent.remove", { event })}
              aria-label={t("edit.noEvent.remove", { event })}
              onClick={() => onRemove(a.tag)}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}

/**
 * "+ Did not happen" — the menu of events the record may state did not happen.
 * Leaves out the ones already stated and the ones the record actually holds:
 * saying a recorded marriage never happened is a contradiction the health check
 * reports, not something to offer.
 */
export function AddNoEventSelect({
  assertions,
  offer,
  recordedTags,
  t,
  tooltip,
  onAdd,
}: {
  assertions: NegativeAssertion[];
  /** Event tags this kind of record can deny. */
  offer: readonly string[];
  /** Tags the record already carries as events. */
  recordedTags: Set<string>;
  t: Translate;
  tooltip: string;
  onAdd: (tag: string) => void;
}) {
  const stated = new Set(assertions.map((a) => a.tag));
  return (
    <AddEventSelect
      tags={offer.filter((tag) => !stated.has(tag) && !recordedTags.has(tag))}
      label={t("edit.noEvent.add")}
      tooltip={tooltip}
      t={t}
      onAdd={onAdd}
      className="edit-name-chip edit-name-chip-add"
    />
  );
}
