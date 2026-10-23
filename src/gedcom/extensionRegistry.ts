/**
 * The extension tags FamilySearch's GEDCOM registry documents, with the URI
 * each registration gives — what a GEDCOM 7 header's `HEAD.SCHMA` should
 * declare for the tag where the file uses it in the registered place.
 *
 * Transcribed from https://github.com/FamilySearch/GEDCOM-registries,
 * `structure/extension/*.yaml` at commit
 * e842894d37e770af8bba660d38d628f086daa79c (2026-10-21): the `uri:` of each
 * file that defines an `extension tags:` entry, and its `superstructures:` as
 * the places the registration covers. A same-named tag anywhere else is some
 * other program's and gets no registry URI — `_MSTAT` under a family is
 * Brother's Keeper's partnership status, not MagiKey's census marital status.
 *
 * Left out, because a schema only declares `_` tags: the registrations of
 * standard tags in new places (Ancestry's `PUBL.DATE`/`PUBL.PLAC`, MagiKey's
 * census `INDI`/`SEX`/`AGE`/`FATH`/`MOTH`).
 */

/** One place a registration allows its tag: under a parent with this tag. */
interface RegistryContext {
  /** The parent's tag. */
  parent: string;
  /** Where the parent sits: a level-0 record, or a substructure. Unset: either. */
  parentIs?: "record" | "substructure";
  /** The tag of the parent's own parent, where the registration names one. */
  grandparent?: string;
}

export interface RegistryEntry {
  tag: string;
  uri: string;
  /** Who registered it (the yaml's `change controller`, else its `used by`). */
  by: string;
  /** The places it is registered for; empty for a level-0 record. */
  contexts: RegistryContext[];
  /** Registered as a record (level 0) — MagiKey's shared census record. */
  record?: true;
}

/** The registry commit the table below is transcribed from. */
export const REGISTRY_COMMIT = "e842894d37e770af8bba660d38d628f086daa79c";

export const REGISTRY_ENTRIES: readonly RegistryEntry[] = [
  {
    // MagiKey_AGER.yaml — superstructure v5.5.1/AGE
    tag: "_AGER", uri: "https://armidalesoftware.com/issue/tags/AGER.htm", by: "Armidale Software (MagiKey)",
    contexts: [{ parent: "AGE" }],
  },
  {
    // MagiKey_CENR.yaml — under BIRT, INDI-CENS, INDI-NAME, OCCU
    tag: "_CENR", uri: "https://armidalesoftware.com/issue/tags/CENR.htm", by: "Armidale Software (MagiKey)",
    contexts: [
      { parent: "BIRT", grandparent: "INDI" },
      { parent: "CENS", grandparent: "INDI" },
      { parent: "NAME", grandparent: "INDI" },
      { parent: "OCCU", grandparent: "INDI" },
    ],
  },
  {
    // MagiKey_record_CENR.yaml — a record of its own
    tag: "_CENR", uri: "https://armidalesoftware.com/issue/tags/record-CENR.htm", by: "Armidale Software (MagiKey)",
    contexts: [], record: true,
  },
  {
    // MagiKey_MSTAT.yaml — under the census record's INDI (MagiKey_CENR_INDI)
    tag: "_MSTAT", uri: "https://armidalesoftware.com/issue/tags/MSTAT.htm", by: "Armidale Software (MagiKey)",
    contexts: [{ parent: "INDI", parentIs: "substructure", grandparent: "_CENR" }],
  },
  {
    // MagiKey_SCHD.yaml — under record-CENR
    tag: "_SCHD", uri: "https://armidalesoftware.com/issue/tags/SCHD.htm", by: "Armidale Software (MagiKey)",
    contexts: [{ parent: "_CENR", parentIs: "record" }],
  },
  {
    // _DATE.yaml — under v7/REPO, a source's repository citation
    tag: "_DATE", uri: "https://github.com/dthaler/gedcom-citations/_DATE", by: "gedcom-citations (prerelease)",
    contexts: [{ parent: "REPO", parentIs: "substructure" }],
  },
  {
    // _SOUR.yaml — under v7/PAGE and v7/record-SOUR
    tag: "_SOUR", uri: "https://github.com/dthaler/gedcom-citations/_SOUR", by: "gedcom-citations (prerelease)",
    contexts: [{ parent: "PAGE" }, { parent: "SOUR", parentIs: "record" }],
  },
];

/**
 * The registry entry for `tag` where it stands, given the tags of its
 * ancestors from the level-0 record down to its parent (`[]` for a record
 * itself). Undefined where no registration covers that place.
 */
export function registryEntry(tag: string, ancestors: readonly string[]): RegistryEntry | undefined {
  const upper = tag.toUpperCase();
  const parent = ancestors[ancestors.length - 1];
  const grandparent = ancestors[ancestors.length - 2];
  const parentIsRecord = ancestors.length === 1;
  return REGISTRY_ENTRIES.find((entry) => {
    if (entry.tag !== upper) return false;
    if (entry.record) return ancestors.length === 0;
    return entry.contexts.some((c) =>
      c.parent === parent &&
      (c.parentIs === undefined || (c.parentIs === "record") === parentIsRecord) &&
      (c.grandparent === undefined || c.grandparent === grandparent),
    );
  });
}
