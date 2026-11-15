import type { NegativeAssertion } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { eventDisplayLabel, UNMARRIED_UNION_GLYPH } from "../../gedcom/eventTags";
import { AddEventSelect } from "./AddEventSelect";
import { DropdownMenu } from "../DropdownMenu";
import { MergeChip, type MergeChipActions } from "./MergeChip";

const REMOVE = "remove";

/** The event's name led by a mark that says it did not happen — not the
 *  event's own, which would say it did: the never-married couple's ⚯ (as the
 *  charts and reports draw it), else the struck-through ⊘. */
function deniedLabel(tag: string, t: Translate) {
  return (
    <span className="edit-event-label-lead">
      <span className="event-glyph" aria-hidden="true">{tag === "MARR" ? UNMARRIED_UNION_GLYPH : "⊘"}</span>
      {eventDisplayLabel(tag, t)}
    </span>
  );
}

/** What a statement says: "did not happen", and over which period when it is
 *  limited to one. */
function NoEventText({ a, t }: { a: NegativeAssertion; t: Translate }) {
  return (
    <span className="edit-no-event-text" title={a.note}>
      {t("edit.noEvent.add")}
      {a.date?.raw && <span className="edit-no-event-date"> ({a.date.raw})</span>}
    </span>
  );
}

/**
 * The events a record states did *not* happen (GEDCOM 7 `NO`), ahead of the
 * events it holds: one row per statement, laid out as an event row — the
 * event's mark and name, whose ▾ menu withdraws the statement, and beside it
 * "Did not happen". Renders nothing when there are none.
 */
export function NoEventsRow({
  assertions,
  t,
  onRemove,
  merge,
}: {
  assertions: NegativeAssertion[];
  t: Translate;
  onRemove: (tag: string) => void;
  /** Statements a confirmed match will add beside these. */
  merge?: { assertions: NegativeAssertion[] } & MergeChipActions;
}) {
  if (!assertions.length && !merge?.assertions.length) return null;
  return (
    <div className="edit-no-events">
      {assertions.map((a) => (
        <div key={a.tag} className="edit-event edit-no-event-row">
          <div className="edit-event-main">
            <div className="edit-event-type-row">
              <DropdownMenu
                className="edit-event-label edit-event-label--select"
                title={t("edit.noEvent.remove", { event: eventDisplayLabel(a.tag, t) })}
                groups={[{ items: [{ value: REMOVE, label: t("edit.removeEvent") }] }]}
                onSelect={() => onRemove(a.tag)}
                trigger={
                  <>
                    {deniedLabel(a.tag, t)}
                    <span className="edit-event-type-caret" aria-hidden="true">▾</span>
                  </>
                }
              />
            </div>
            <NoEventText a={a} t={t} />
          </div>
        </div>
      ))}
      {merge?.assertions.map((a) => (
        <div key={`merge-${a.tag}`} className="edit-event edit-no-event-row">
          <div className="edit-event-main">
            <div className="edit-event-type-row">
              <div className="edit-event-label">{deniedLabel(a.tag, t)}</div>
            </div>
            <MergeChip className="edit-no-event" t={t} onTake={merge.onTake} onSkip={merge.onSkip}>
              <NoEventText a={a} t={t} />
            </MergeChip>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The events a record may state did not happen: `offer` less the ones already
 * stated and the ones the record actually holds — saying a recorded marriage
 * never happened is a contradiction the health check reports, not something
 * to offer.
 */
export function deniableTags(assertions: NegativeAssertion[], offer: readonly string[], recordedTags: Set<string>): string[] {
  const stated = new Set(assertions.map((a) => a.tag));
  return offer.filter((tag) => !stated.has(tag) && !recordedTags.has(tag));
}

/** "+ Did not happen" — the menu of {@link deniableTags}. */
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
  return (
    <AddEventSelect
      tags={deniableTags(assertions, offer, recordedTags)}
      label={t("edit.noEvent.add")}
      tooltip={tooltip}
      t={t}
      onAdd={onAdd}
      className="edit-name-chip edit-name-chip-add"
    />
  );
}
