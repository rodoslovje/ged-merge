import type { Association, Dataset, Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { eventDisplayLabel } from "../../gedcom/eventTags";
import { isVoidAssociation, type AssocRef } from "../../gedcom/assoc";
import { PersonLink } from "../PersonLink";

/** The role in words: the file's own wording where it has one, else the
 *  translated name of the role it was read as. */
export function roleLabel(assoc: Association, t: Translate): string {
  return assoc.roleText?.trim() || t(`assoc.role.${assoc.role}`);
}

/** One line: "Baptism 1958 · godmother — Jožefa Pezdirc (1900–1943)". */
function AssociateLine({
  dataset,
  t,
  navigate,
  assoc,
  context,
}: {
  dataset: Dataset;
  t: Translate;
  navigate: (id: string) => void;
  assoc: Association;
  context: string;
}) {
  return (
    <li className="edit-assoc-row">
      <span className="edit-assoc-context">{context}</span>
      <span className="edit-assoc-role">{roleLabel(assoc, t)}</span>
      {isVoidAssociation(assoc) ? (
        // Named, but recorded as nobody: there is no record to open, and
        // dressing the text up as a link would promise one.
        <span className="edit-assoc-name-only" title={t("assoc.nameOnlyTip")}>
          {assoc.name || t("assoc.unnamed")}
        </span>
      ) : (
        <PersonLink dataset={dataset} id={assoc.targetId} fallback={assoc.name || assoc.targetId} onNavigate={navigate} />
      )}
    </li>
  );
}

/**
 * The people this person's record names — godparents, witnesses, the priest who
 * officiated — and, the other way round, the records that name this person.
 *
 * Associations are stored on one side only (see `gedcom/assoc.ts`), so the
 * second list is a view over the whole file's index rather than anything the
 * record itself holds.
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
  const own: { assoc: Association; context: string }[] = [];
  for (const assoc of person.associations ?? []) {
    own.push({ assoc, context: t("assoc.onTheRecord") });
  }
  for (const event of person.events) {
    for (const assoc of event.associations ?? []) {
      const year = event.date?.year;
      const label = eventDisplayLabel(event.tag, t);
      own.push({ assoc, context: year ? `${label} ${year}` : label });
    }
  }

  if (!own.length && !namedBy?.length) return null;

  return (
    <div className="edit-assoc">
      {own.length > 0 && (
        <>
          <div className="edit-assoc-head">{t("assoc.heading")}</div>
          <ul className="edit-assoc-list">
            {own.map((entry, i) => (
              <AssociateLine
                key={i}
                dataset={dataset}
                t={t}
                navigate={navigate}
                assoc={entry.assoc}
                context={entry.context}
              />
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
