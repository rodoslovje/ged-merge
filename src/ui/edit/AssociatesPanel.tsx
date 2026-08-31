import type { Dataset, Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { eventDisplayLabel } from "../../gedcom/eventTags";
import { isVoidAssociation, type AssocRef } from "../../gedcom/assoc";
import { PersonLink } from "../PersonLink";
import { roleLabel } from "./EventAssociates";

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

  return (
    <div className="edit-assoc">
      {onRecord.length > 0 && (
        <>
          <div className="edit-assoc-head">{t("assoc.heading")}</div>
          <ul className="edit-assoc-list">
            {onRecord.map((assoc, i) => (
              <li key={i} className="edit-assoc-row">
                <span className="edit-assoc-context">{t("assoc.onTheRecord")}</span>
                <span className="edit-assoc-role">{roleLabel(assoc, t)}</span>
                {isVoidAssociation(assoc) ? (
                  <span className="edit-assoc-name-only" title={t("assoc.nameOnlyTip")}>
                    {assoc.name || t("assoc.unnamed")}
                  </span>
                ) : (
                  <PersonLink
                    dataset={dataset}
                    id={assoc.targetId}
                    fallback={assoc.name || assoc.targetId}
                    onNavigate={navigate}
                  />
                )}
              </li>
            ))}
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
