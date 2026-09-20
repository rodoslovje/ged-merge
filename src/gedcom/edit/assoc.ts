/**
 * Writing associations (`ASSO`) — see `gedcom/assoc.ts` for reading them and
 * for the role vocabulary.
 *
 * *Where* an association may be written is the dialect's decision, not ours:
 *
 *  - **7.0** carries `ASSO` in three places: under an `INDI` record, under a
 *    `FAM` record, and inside every event's `EVENT_DETAIL`. The event is the
 *    best of them — it says *which* baptism the godparent attended — so that is
 *    where the editor puts one when the file allows it.
 *  - **5.5.1** defines `ASSO` in exactly one place: a substructure of `INDI`,
 *    pointing at an `INDI`, with a required free-text `RELA`. There is no
 *    event-level form and no family-level form. So in a 5.5.x file an
 *    association is written on the person's own record, and a family's is not
 *    offered at all: a marriage witness goes on a spouse's record, which is what
 *    the dialect has. {@link canWriteEventAssociation} and
 *    {@link canWriteFamilyAssociation} are the questions the UI asks.
 *  - **An associate the file does not record as a person** is written `@VOID@`
 *    plus a `PHRASE` naming them, which is 7.0-only. A 5.5.x file has no such
 *    form, so only an association to an existing record can be written there —
 *    {@link canWriteNameOnly} says which case a file is in.
 *
 * `TYPE` is deliberately absent from the 5.5.x output. 5.5 had it, because its
 * `ASSO` could point at any record; 5.5.1 dropped both the freedom and the tag,
 * and the spec's own example is a bare `ASSO @I2@` / `RELA Godfather`. It is
 * written only for an association pointing at a family, where it is the one
 * thing that says so.
 */
import type { AssocRole, GedcomVersion, GedNode } from "../types";
import { ROLE_TO_RELA, VOID_XREF } from "../assoc";
import { EVENT_CHILD_ORDER, INDI_CHILD_ORDER, FAM_CHILD_ORDER, insertOrdered } from "./shared";

/** What the editor asks for; the dialect decides how it is written. */
export interface AssociationSpec {
  /** The associate's record. Absent = a name-only (`@VOID@`) association. */
  targetId?: string;
  /** The associate's name, for a name-only association. */
  name?: string;
  role: AssocRole;
  /** Wording to keep instead of the role's own name — a `RELA` value in 5.5.1,
   *  a `PHRASE` under `ROLE` in 7.0. */
  roleText?: string;
  /** What kind of record the pointer names, where the file said so. The editor
   *  only ever points at a person, but a 5.5-era file's `ASSO @F14@` / `TYPE FAM`
   *  must keep saying "family" when its role is rewritten. */
  targetKind?: "INDI" | "FAM";
}

/** Whether this file's dialect can name an associate it holds no record for. */
export function canWriteNameOnly(version: GedcomVersion): boolean {
  return version === "7.0";
}

/**
 * Whether this dialect can hang an association under an event — 7.0's
 * `EVENT_DETAIL` can, 5.5.1 has no such place. Where it cannot, the association
 * belongs on the record instead, and the event rows offer none.
 *
 * An unrecognised version counts as the older dialect, like
 * {@link canWriteNameOnly}: the narrower form is the one every reader
 * understands.
 */
export function canWriteEventAssociation(version: GedcomVersion): boolean {
  return version === "7.0";
}

/**
 * Whether this dialect can hang an association on a `FAM` record — 7.0 added it,
 * 5.5.1 knows associations only on a person.
 */
export function canWriteFamilyAssociation(version: GedcomVersion): boolean {
  return version === "7.0";
}

function child(node: GedNode, tag: string, value?: string): GedNode {
  const created: GedNode = { level: node.level + 1, tag, children: [] };
  if (value !== undefined) created.value = value;
  node.children.push(created);
  return created;
}

/**
 * Fill an `ASSO` node from a spec, replacing whatever it said before. The
 * node's own `PHRASE`/`ROLE`/`RELA`/`TYPE` children are rewritten; anything
 * else it carries (a `NOTE`, a `SOUR`, a vendor's own sub-tag) is left alone,
 * so editing a role never quietly drops the evidence for it.
 */
export function writeAssociation(node: GedNode, spec: AssociationSpec, version: GedcomVersion): void {
  const nameOnly = !spec.targetId;
  node.value = nameOnly ? VOID_XREF : spec.targetId;
  node.children = node.children.filter(
    (c) => c.tag !== "PHRASE" && c.tag !== "ROLE" && c.tag !== "RELA" && c.tag !== "TYPE",
  );

  if (version === "7.0") {
    if (nameOnly && spec.name?.trim()) child(node, "PHRASE", spec.name.trim());
    const role = child(node, "ROLE", spec.role);
    // A wording of the file's own goes on the ROLE's PHRASE. The enumeration
    // has no room for "botra", and OTHER without a phrase says nothing at all.
    if (spec.roleText?.trim()) child(role, "PHRASE", spec.roleText.trim());
    return;
  }

  // 5.5.x: a pointer and the role as free text. `TYPE` only where it still says
  // something — a pointer at a family (see the note at the top of the file).
  if (spec.targetKind === "FAM") child(node, "TYPE", "FAM");
  child(node, "RELA", spec.roleText?.trim() || ROLE_TO_RELA[spec.role] || "other");
}

/** The child order the container sorts by. */
function orderFor(container: GedNode): string[] {
  if (container.tag === "INDI") return INDI_CHILD_ORDER;
  if (container.tag === "FAM") return FAM_CHILD_ORDER;
  return EVENT_CHILD_ORDER;
}

/** Add an association to an event node (or, for a record-level one, to the
 *  record itself). Returns the node written, for a caller that wants to focus it. */
export function addAssociation(container: GedNode, spec: AssociationSpec, version: GedcomVersion): GedNode {
  const node: GedNode = { level: container.level + 1, tag: "ASSO", children: [] };
  writeAssociation(node, spec, version);
  insertOrdered(container, node, orderFor(container));
  return node;
}

/** Remove one association from its container. */
export function removeAssociation(container: GedNode, node: GedNode): void {
  const i = container.children.indexOf(node);
  if (i !== -1) container.children.splice(i, 1);
}

/**
 * Move an association from one container to another — in practice off the
 * record and onto the event it belongs to, which is the only way to say *which*
 * baptism a 5.5.1 file's godparent attended.
 *
 * The node travels whole: its role, its date, its notes and its citations are
 * the same claim wherever it hangs. Only the levels are restated, since it has
 * changed depth.
 */
export function moveAssociation(from: GedNode, to: GedNode, node: GedNode): void {
  const i = from.children.indexOf(node);
  if (i === -1 || from === to) return;
  from.children.splice(i, 1);
  restack(node, to.level + 1);
  insertOrdered(to, node, orderFor(to));
}

/** Restate a subtree's levels after it moves to a new depth. */
function restack(node: GedNode, level: number): void {
  node.level = level;
  for (const child of node.children) restack(child, level + 1);
}
