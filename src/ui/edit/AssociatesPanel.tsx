import { useState } from "react";
import type { Association, Dataset, GedNode, Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { eventDisplayLabel, indiEventNodes } from "../../gedcom/eventTags";
import { firstChild } from "../../gedcom/node";
import { dateToSortKey, parseDate } from "../../gedcom/date";
import type { AssocRef } from "../../gedcom/assoc";
import { EventAssociates, RecordLink, roleLabel } from "./EventAssociates";
import { useAssoc } from "./AssocContext";

/**
 * The events a record-level association could be filed under instead, named and
 * in the order a life happened in. Read off the raw tree, not the typed event
 * list: that one skips change-stamp `EVEN` nodes, so the two do not line up and
 * the move would land on the wrong event.
 */
export function assocMoveTargets(eventNodes: GedNode[], t: Translate): { node: GedNode; label: string }[] {
  return eventNodes
    .map((node) => {
      const label = eventDisplayLabel(node.tag, t);
      const date = parseDate(firstChild(node, "DATE")?.value ?? "");
      // Undated last: `dateToSortKey`'s unknown sentinel would sort it first
      // (see `AssocRef.sortKey`).
      const sortKey = date?.year == null ? Number.POSITIVE_INFINITY : dateToSortKey(date);
      return { node, label: date?.year ? `${label} ${date.year}` : label, sortKey };
    })
    .sort((a, b) => a.sortKey - b.sortKey);
}

/**
 * The associations a record carries itself, rather than under one of its events:
 * what a 5.5.x file has to write, since that dialect defines `ASSO` nowhere else
 * (see `gedcom/edit/assoc.ts`), and the honest home in any dialect for a
 * connection no single event accounts for.
 *
 * `canAdd` is the dialect's answer for this kind of record, so the panel offers
 * only what the file can actually hold. Associations already there are always
 * shown, `canAdd` or not — nothing a file says should be invisible.
 */
export function RecordAssociates({
  record,
  ownerId,
  associations,
  canAdd,
  moveTargets,
  t,
}: {
  /** The `INDI` or `FAM` record node the associations hang under. */
  record: GedNode;
  /** That record's id — the edit commits against it. */
  ownerId: string;
  associations: Association[];
  /** Whether this dialect can write one here at all. */
  canAdd: boolean;
  /** Events one of these could be filed under instead. */
  moveTargets?: { node: GedNode; label: string }[];
  t: Translate;
}) {
  const api = useAssoc();
  const [adding, setAdding] = useState(false);
  const offerAdd = !!api && canAdd;
  if (!associations.length && !offerAdd) return null;

  return (
    <>
      <div className="edit-assoc-head">
        {t("assoc.heading")}
        {offerAdd && !adding && (
          <button
            type="button"
            className="edit-assoc-add"
            title={t("assoc.addOnRecordTip")}
            onClick={() => setAdding(true)}
          >
            {t("assoc.addOnRecord")}
          </button>
        )}
      </div>
      {(associations.length > 0 || adding) && (
        <ul className="edit-assoc-list">
          <li className="edit-assoc-row">
            <span className="edit-assoc-context">{t("assoc.onTheRecord")}</span>
            {/* The same chips as on an event's row, with the record itself as
                the container. */}
            <EventAssociates
              associations={associations}
              container={record}
              ownerId={ownerId}
              t={t}
              picking={adding}
              onDonePicking={() => setAdding(false)}
              moveTargets={moveTargets}
              removeTitle={t("assoc.removeFromRecord")}
            />
          </li>
        </ul>
      )}
    </>
  );
}

/**
 * A person's association views: the ones on their own record, and the other side
 * of every association pointing at them.
 *
 * The people an event names are edited on the event's own row (see
 * `EventAssociates`), where they belong. **Where this person is named** has no
 * event to sit on: associations are stored once, on the naming record, so this is
 * a view over the file-wide index, never a second entry to keep in step.
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

  return (
    <div className="edit-assoc">
      <RecordAssociates
        record={person.raw}
        ownerId={person.id}
        associations={onRecord}
        // Every dialect carries `ASSO` on an `INDI` record — 5.5.1 has it there
        // and nowhere else — so a person is the one place always offered.
        canAdd
        moveTargets={assocMoveTargets(indiEventNodes(person.raw), t)}
        t={t}
      />
      {!!namedBy?.length && (
        <>
          <div className="edit-assoc-head">{t("assoc.namedByHeading")}</div>
          <ul className="edit-assoc-list">
            {namedBy.map((ref, i) => {
              // "Marriage 1899" — the year says which one, the couple below says
              // whose; the event's name alone said neither.
              const name = ref.eventTag ? eventDisplayLabel(ref.eventTag, t) : t("assoc.onTheRecord");
              const label = ref.year ? `${name} ${ref.year}` : name;
              return (
                <li key={i} className="edit-assoc-row">
                  <span className="edit-assoc-context">{label}</span>
                  {/* The role is what *this* person was at that event, so the
                      word agrees with them, not with the record naming them. */}
                  <span className="edit-assoc-role">{roleLabel(ref.assoc, t, person.sex)}</span>
                  {/* A marriage is named by its couple: the record carrying the
                      association is a family, whose xref said nothing about
                      whose wedding this person witnessed. */}
                  <RecordLink dataset={dataset} id={ref.fromId} fallback={ref.fromId} onNavigate={navigate} />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
