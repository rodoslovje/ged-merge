/**
 * Writing associations (`ASSO`) — see `gedcom/assoc.ts` for reading them and
 * for the role vocabulary.
 *
 * Two decisions are baked in here:
 *
 *  - **Associations are written under the event they belong to**, in both
 *    dialects. 5.5.1 formally allows `ASSO` only at record level, but putting a
 *    baptism's godparents there throws away *which* event they attended — the
 *    very thing one vendor's `RELA Witness at event _EVN 29` free text exists to
 *    smuggle back in. Readers tolerate the event-level form; the lost event is
 *    not recoverable.
 *  - **An associate the file does not record as a person is written `@VOID@`
 *    plus a `PHRASE` naming them**, which is 7.0-only. In a 5.5.1 file there is
 *    no such form, so only an association to an existing record can be written
 *    there — {@link canWriteNameOnly} says which case a file is in.
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
}

/** Whether this file's dialect can name an associate it holds no record for. */
export function canWriteNameOnly(version: GedcomVersion): boolean {
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

  // 5.5.1: a pointer, the kind of record it names, and the role as free text.
  child(node, "TYPE", "INDI");
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
