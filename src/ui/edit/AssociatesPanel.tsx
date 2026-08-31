import { useState } from "react";
import type { Association, Dataset, GedNode, Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { INDI_EVENT_TAGS, eventDisplayLabel, isChangeStampEvent } from "../../gedcom/eventTags";
import { firstChild } from "../../gedcom/node";
import { parseDate } from "../../gedcom/date";
import {
  EDITABLE_ASSOC_ROLES,
  associationsIn,
  isVoidAssociation,
  parseAssociation,
  type AssocRef,
} from "../../gedcom/assoc";
import {
  addAssociation,
  canWriteNameOnly,
  removeAssociation,
  writeAssociation,
  type AssociationSpec,
} from "../../gedcom/edit";
import { PersonLink } from "../PersonLink";
import { RelativePickerCard } from "./RelativePickerCard";

/** The role in words: the file's own wording where it has one, else the
 *  translated name of the role it was read as. */
export function roleLabel(assoc: Association, t: Translate): string {
  return assoc.roleText?.trim() || t(`assoc.role.${assoc.role}`);
}

/** One association, with the event it belongs to and the node that holds it. */
interface OwnEntry {
  assoc: Association;
  /** The event node the ASSO hangs under; the record itself for a 5.5.1
   *  record-level association. */
  container: GedNode;
  context: string;
}

/** The events an association can be added to, most-used first. Baptisms and
 *  marriages are where parish registers name people, so they lead. */
const PREFERRED_EVENT_TAGS = ["BAPM", "CHR", "MARR", "BIRT", "DEAT", "BURI"];

function eventRank(tag: string): number {
  const i = PREFERRED_EVENT_TAGS.indexOf(tag);
  return i === -1 ? PREFERRED_EVENT_TAGS.length : i;
}

/** "Baptism 1958" — the event named the way the rest of Edit names it. */
function eventContext(node: GedNode, t: Translate): string {
  const label = eventDisplayLabel(node.tag, t);
  const year = parseDate(firstChild(node, "DATE")?.value ?? "")?.year;
  return year ? `${label} ${year}` : label;
}

export function AssociatesPanel({
  person,
  dataset,
  namedBy,
  t,
  navigate,
  commit,
}: {
  person: Individual;
  dataset: Dataset;
  /** This person's entry in the file-wide association index. */
  namedBy: AssocRef[] | undefined;
  t: Translate;
  navigate: (id: string) => void;
  /** Mutate the person's raw record; the host turns it into an undoable patch. */
  commit: (mutate: () => void) => void;
}) {
  const [adding, setAdding] = useState<{ eventKey: number } | null>(null);
  const [editing, setEditing] = useState<Association | null>(null);

  // Read straight off the raw tree rather than pairing `person.events` with raw
  // children by position: the typed events skip change-stamp `EVEN` nodes, so
  // the two lists do not line up, and an association would be filed under the
  // wrong event's name.
  const own: OwnEntry[] = [];
  const eventNodes: GedNode[] = [];
  for (const child of person.raw.children) {
    if (child.tag === "ASSO" || child.tag === "_ASSO") {
      const assoc = parseAssociation(child);
      if (assoc) own.push({ assoc, container: person.raw, context: t("assoc.onTheRecord") });
      continue;
    }
    if (!INDI_EVENT_TAGS.has(child.tag) || isChangeStampEvent(child)) continue;
    eventNodes.push(child);
    for (const assoc of associationsIn(child)) {
      own.push({ assoc, container: child, context: eventContext(child, t) });
    }
  }

  // Which events an association can be attached to: the person's own, ordered
  // so a baptism is the first thing offered.
  const addTargets = eventNodes
    .map((node) => ({ node, label: eventContext(node, t) }))
    .sort((a, b) => eventRank(a.node.tag) - eventRank(b.node.tag));

  const nameOnlyAllowed = canWriteNameOnly(dataset.version);

  const applySpec = (container: GedNode, spec: AssociationSpec, existing?: Association) => {
    commit(() => {
      if (existing) writeAssociation(existing.raw, spec, dataset.version);
      else addAssociation(container, spec, dataset.version);
    });
    setAdding(null);
    setEditing(null);
  };

  const drop = (entry: OwnEntry) => {
    commit(() => removeAssociation(entry.container, entry.assoc.raw));
  };

  return (
    <div className="edit-assoc">
      <div className="edit-assoc-head">{t("assoc.heading")}</div>
      {own.length > 0 && (
        <ul className="edit-assoc-list">
          {own.map((entry, i) => (
            <li key={i} className="edit-assoc-row">
              <span className="edit-assoc-context">{entry.context}</span>
              <span className="edit-assoc-role">{roleLabel(entry.assoc, t)}</span>
              {isVoidAssociation(entry.assoc) ? (
                // Named, but recorded as nobody: there is no record to open, and
                // dressing the text up as a link would promise one.
                <span className="edit-assoc-name-only" title={t("assoc.nameOnlyTip")}>
                  {entry.assoc.name || t("assoc.unnamed")}
                </span>
              ) : (
                <PersonLink
                  dataset={dataset}
                  id={entry.assoc.targetId}
                  fallback={entry.assoc.name || entry.assoc.targetId}
                  onNavigate={navigate}
                />
              )}
              <button
                type="button"
                className="edit-assoc-action"
                title={t("assoc.editRole")}
                onClick={() => setEditing(entry.assoc)}
              >
                ✎
              </button>
              <button
                type="button"
                className="edit-assoc-action edit-assoc-remove"
                title={t("assoc.remove")}
                onClick={() => drop(entry)}
              >
                ✕
              </button>
              {editing === entry.assoc && (
                <RoleForm
                  t={t}
                  initial={entry.assoc}
                  onCancel={() => setEditing(null)}
                  onSave={(role, roleText) =>
                    applySpec(entry.container, {
                      targetId: isVoidAssociation(entry.assoc) ? undefined : entry.assoc.targetId,
                      name: entry.assoc.name,
                      role,
                      roleText,
                    }, entry.assoc)
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <AddAssociate
          dataset={dataset}
          person={person}
          t={t}
          targets={addTargets}
          nameOnlyAllowed={nameOnlyAllowed}
          eventKey={adding.eventKey}
          onEventKey={(eventKey) => setAdding({ eventKey })}
          onCancel={() => setAdding(null)}
          onAdd={(container, spec) => applySpec(container, spec)}
        />
      ) : (
        addTargets.length > 0 && (
          <button type="button" className="edit-assoc-add" onClick={() => setAdding({ eventKey: 0 })}>
            {t("assoc.add")}
          </button>
        )
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

/** Pick the role, and — for a role the vocabulary has no word for — the wording
 *  to keep instead. */
function RoleForm({
  t,
  initial,
  onSave,
  onCancel,
}: {
  t: Translate;
  initial?: Association;
  onSave: (role: Association["role"], roleText?: string) => void;
  onCancel: () => void;
}) {
  const [role, setRole] = useState<Association["role"]>(initial?.role ?? "GODP");
  const [text, setText] = useState(initial?.roleText ?? "");

  return (
    <span className="edit-assoc-roleform">
      <select
        className="edit-assoc-select"
        value={role}
        onChange={(e) => setRole(e.target.value as Association["role"])}
        aria-label={t("assoc.roleLabel")}
      >
        {EDITABLE_ASSOC_ROLES.map((r) => (
          <option key={r} value={r}>
            {t(`assoc.role.${r}`)}
          </option>
        ))}
      </select>
      {role === "OTHER" && (
        <input
          className="edit-assoc-input"
          value={text}
          placeholder={t("assoc.roleTextPlaceholder")}
          onChange={(e) => setText(e.target.value)}
          aria-label={t("assoc.roleTextLabel")}
        />
      )}
      <button type="button" className="edit-assoc-action" onClick={() => onSave(role, text.trim() || undefined)}>
        {t("assoc.save")}
      </button>
      <button type="button" className="edit-assoc-action" onClick={onCancel}>
        {t("assoc.cancel")}
      </button>
    </span>
  );
}

/** Choose the event, then the person, then the role. */
function AddAssociate({
  dataset,
  person,
  t,
  targets,
  nameOnlyAllowed,
  eventKey,
  onEventKey,
  onCancel,
  onAdd,
}: {
  dataset: Dataset;
  person: Individual;
  t: Translate;
  targets: { node: GedNode; label: string }[];
  nameOnlyAllowed: boolean;
  eventKey: number;
  onEventKey: (key: number) => void;
  onCancel: () => void;
  onAdd: (container: GedNode, spec: AssociationSpec) => void;
}) {
  const [picked, setPicked] = useState<{ targetId?: string; name?: string } | null>(null);
  const target = targets[eventKey] ?? targets[0];

  return (
    <div className="edit-assoc-add-form">
      <select
        className="edit-assoc-select"
        value={eventKey}
        onChange={(e) => onEventKey(Number(e.target.value))}
        aria-label={t("assoc.eventLabel")}
      >
        {targets.map((c, i) => (
          <option key={i} value={i}>
            {c.label}
          </option>
        ))}
      </select>
      {!picked ? (
        <RelativePickerCard
          roleLabel={t("assoc.pickLabel")}
          individuals={dataset.individuals}
          excludeId={person.id}
          onPickExisting={(id) => setPicked({ targetId: id })}
          // In a 7.0 file the extra row records the typed name on the
          // association itself (`@VOID@` + `PHRASE`) rather than minting a
          // person — the godparent is named, not researched. A 5.5.1 file has
          // no such form, so it offers only people the file already holds.
          onAddNew={nameOnlyAllowed ? (typed) => typed.trim() && setPicked({ name: typed.trim() }) : undefined}
          newLabel={t("assoc.nameOnly")}
          onCancel={onCancel}
          t={t}
        />
      ) : (
        <RoleForm
          t={t}
          onCancel={onCancel}
          onSave={(role, roleText) =>
            onAdd(target.node, { targetId: picked.targetId, name: picked.name, role, roleText })
          }
        />
      )}
    </div>
  );
}
