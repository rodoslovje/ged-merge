import type { Dataset, Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { INDI_EVENT_TAGS, eventDisplayLabel, isChangeStampEvent } from "../../gedcom/eventTags";
import { firstChild } from "../../gedcom/node";
import { parseDate } from "../../gedcom/date";
import type { AssocRef } from "../../gedcom/assoc";
import { PersonLink } from "../PersonLink";
import { EventAssociates, roleLabel } from "./EventAssociates";

/**
 * The association views that are *not* about one event.
 *
 * The people an event names are edited on the event's own row (see
 * `EventAssociates`), where they belong. Two things have no event to sit on:
 *
 *  - **Where this person is named** — the other side of every association
 *    pointing at them. Associations are stored once, on the naming event, so
 *    this is a view over the file-wide index, never a second entry to keep in
 *    step.
 *  - **Record-level associations** — what a 5.5.1 file writes, the dialect
 *    having no event-level form. They are shown so nothing is invisible, and
 *    they stay where the file put them.
 */
export function AssociatesPanel({
  person,
  dataset,
  namedBy,
  t,
  navigate,
}: {
  person: Individual;
  dataset: Dataset;
  /** This person's entry in the file-wide association index. */
  namedBy: AssocRef[] | undefined;
  t: Translate;
  navigate: (id: string) => void;
}) {
  const onRecord = person.associations ?? [];
  if (!onRecord.length && !namedBy?.length) return null;

  // Where a record-level association could go instead. Read off the raw tree,
  // not `person.events`: the typed list skips change-stamp `EVEN` nodes, so the
  // two do not line up and the move would land on the wrong event.
  const moveTargets = person.raw.children
    .filter((c) => INDI_EVENT_TAGS.has(c.tag) && !isChangeStampEvent(c))
    .map((node) => {
      const label = eventDisplayLabel(node.tag, t);
      const year = parseDate(firstChild(node, "DATE")?.value ?? "")?.year;
      return { node, label: year ? `${label} ${year}` : label };
    });

  return (
    <div className="edit-assoc">
      {onRecord.length > 0 && (
        <>
          <div className="edit-assoc-head">{t("assoc.heading")}</div>
          <ul className="edit-assoc-list">
            <li className="edit-assoc-row">
              <span className="edit-assoc-context">{t("assoc.onTheRecord")}</span>
              {/* Editable like the ones on an event — the same chips, with the
                  record itself as the container. They are not offered anywhere
                  new: an association written here belongs to no event, which is
                  a 5.5.1 file's only option, not a shape to spread. */}
              <EventAssociates
                associations={onRecord}
                container={person.raw}
                ownerId={person.id}
                t={t}
                picking={false}
                onDonePicking={() => {}}
                moveTargets={moveTargets}
              />
            </li>
          </ul>
        </>
      )}
      {!!namedBy?.length && (
        <>
          <div className="edit-assoc-head">{t("assoc.namedByHeading")}</div>
          <ul className="edit-assoc-list">
            {namedBy.map((ref, i) => {
              const label = ref.eventTag ? eventDisplayLabel(ref.eventTag, t) : t("assoc.onTheRecord");
              return (
                <li key={i} className="edit-assoc-row">
                  <span className="edit-assoc-context">{label}</span>
                  <span className="edit-assoc-role">{roleLabel(ref.assoc, t)}</span>
                  <PersonLink dataset={dataset} id={ref.fromId} fallback={ref.fromId} onNavigate={navigate} />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
