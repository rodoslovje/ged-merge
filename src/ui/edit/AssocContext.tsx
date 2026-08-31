import { createContext, useContext } from "react";
import type { Dataset, GedNode, GedcomVersion } from "../../gedcom/types";
import type { AssociationSpec } from "../../gedcom/edit";

// An association belongs to the event that names it — the godparents to the
// baptism, the witnesses to the wedding — so it is edited on the event's own
// row. What that row needs (the file's people to search, the dialect to write,
// a way to open the person named) belongs to the Edit view, and this carries it
// there without drilling props through the event-list components in between,
// the way CoordShareContext carries the coordinate offer.

export interface AssocApi {
  /** The main file — the people to search, and what a person chip reads. */
  dataset: Dataset;
  /** The main file's dialect — it decides whether an associate can be named
   *  without a record of their own (see `canWriteNameOnly`). */
  version: GedcomVersion;
  /** Open a person's record. */
  navigate: (id: string) => void;
  // Each takes the record that owns the event — a person for an individual
  // event, a family for a marriage — so the edit is committed against the right
  // record whichever kind of row it came from.
  /** Add an association to `container` (the event node), as one undo step. */
  add: (ownerId: string, container: GedNode, spec: AssociationSpec) => void;
  /** Rewrite an existing association's target/role in place. */
  update: (ownerId: string, node: GedNode, spec: AssociationSpec) => void;
  /** Remove one association from its container. */
  remove: (ownerId: string, container: GedNode, node: GedNode) => void;
  /** Move one off the record and onto the event it belongs to. */
  move: (ownerId: string, from: GedNode, to: GedNode, node: GedNode) => void;
}

const AssocContext = createContext<AssocApi | null>(null);

export const AssocProvider = AssocContext.Provider;

/** null outside the Edit view — the merge's read-only event rows have no
 *  editing to offer, and render the associations as plain text. */
export function useAssoc(): AssocApi | null {
  return useContext(AssocContext);
}
