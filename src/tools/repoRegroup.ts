import type { GedNode } from "../gedcom/types";
import { childText, childrenByTag, cloneNode, firstChild } from "../gedcom/node";

import { buildObjeIndex, prefersSourceRepos, looseKey, writesCallNumbers } from "../gedcom/source";
import { createSiteRepo, fsRepoCountry, repoCountryFacet, repoNameTail } from "./sourceReshape";

// Gather the FamilySearch sources of one country under that country's
// repository.
//
// FamilySearch publishes in collections, and a file that made a repository
// per collection ends up with a record per register set — a dozen of them
// saying "FamilySearch.org - …" and nothing else. A repository is meant to be
// the place the records are kept, so the grouping this tool proposes is the
// country the records are from: the source's own PLAC, else the jurisdiction
// its title opens with, else the one its present repository's name gives.
//
// The collection is not lost by the move — it is the source's own title,
// which is where it belonged all along.

/** One source the regroup would re-point, and where it hangs now. */
export interface RepoRegroupMove {
  sourceXref: string;
  title: string;
  /** The repository it is linked to today; absent when it has none. */
  fromXref?: string;
  fromName?: string;
}

/** Every FamilySearch source of one country, and the repository they join. */
export interface RepoRegroupGroup {
  /** The country facet — the group's identity and React key. */
  id: string;
  /** What the country's repository is (or would be) called. */
  repoName: string;
  /** The file's existing repository for this country, when it has one; the
   *  apply creates the record when it does not. */
  targetXref?: string;
  moves: RepoRegroupMove[];
  /** Repositories the moves would leave cited by nothing — removed with them. */
  emptied: { xref: string; name: string }[];
}

export interface RepoRegroupReport {
  groups: RepoRegroupGroup[];
  /** Sources across every group — the tab's badge count. */
  total: number;
}

/** Whether a `REPO` record is FamilySearch's: by its website, or by a name
 *  that opens with the site's own. */
function isFsRepo(rec: GedNode): boolean {
  const www = childText(rec, "WWW") ?? "";
  const name = childText(rec, "NAME") ?? "";
  return /familysearch\.org/i.test(www) || looseKey(name).startsWith("familysearch");
}

/** Whether a `SOUR` record is a FamilySearch one: it hangs off the site's
 *  repository, or — for a source filed nowhere — its own website or one of
 *  its page links is on the site. A source already filed at some *other*
 *  repository is never claimed: a register held by a physical archive keeps
 *  its archive however many of its scans happen to be FamilySearch links —
 *  claiming it would move it off the real archive and, with the archive's
 *  last source gone, delete the archive's record. */
function isFsSource(rec: GedNode, fsRepos: Set<string>, objeUrl: (xref: string) => string | undefined): boolean {
  const repo = firstChild(rec, "REPO")?.value?.trim();
  if (repo) return fsRepos.has(repo);
  if (/familysearch\.org/i.test(childText(rec, "WWW") ?? "")) return true;
  return childrenByTag(rec, "OBJE").some((o) => {
    const url = o.value?.trim() ? objeUrl(o.value.trim()) : undefined;
    return url !== undefined && /familysearch\.org/i.test(url);
  });
}

/**
 * Where a source belongs — the same reading the Add Source dialog makes for a
 * new one, so both agree on which record holds what: the place it covers and
 * the title it carries, and failing those the name of the repository it hangs
 * off today, read past the site's own name ("FamilySearch.org - Croatia Church
 * Books 1516-1994" states its country only in what follows it).
 */
function sourceCountry(rec: GedNode, repoName: string | undefined): { facet: string; name: string } | undefined {
  const place = childText(rec, "PLAC")?.trim();
  const title = childText(rec, "TITL") ?? "";
  return fsRepoCountry({ place, title }) ?? fsRepoCountry({ title: repoNameTail(repoName ?? "") });
}

/**
 * Which FamilySearch sources would move, and to whose repository — the review
 * list behind the Organize sources tool's Repositories section. A source is
 * left alone when nothing says which country it covers, and when it already
 * hangs off that country's own repository.
 *
 * A source with no repository at all joins one only in a file that hangs
 * sources off repositories at all; where the habit is not to, the regroup
 * does not introduce it.
 */
export function scanRepoRegroup(records: GedNode[]): RepoRegroupReport {
  const objeIndex = buildObjeIndex(records);
  const objeUrl = (xref: string) => objeIndex.get(xref)?.url;
  const repoNodes = new Map<string, GedNode>();
  const fsRepos = new Set<string>();
  /** The country repository of each facet the file already keeps. */
  const countryRepo = new Map<string, GedNode>();
  for (const rec of records) {
    if (rec.tag !== "REPO" || !rec.xref) continue;
    repoNodes.set(rec.xref, rec);
    if (!isFsRepo(rec)) continue;
    fsRepos.add(rec.xref);
    const facet = repoCountryFacet(childText(rec, "NAME"));
    if (facet && !countryRepo.has(facet)) countryRepo.set(facet, rec);
  }

  const adoptRepoless = prefersSourceRepos(records);
  /** How many sources each repository holds, moving or not. */
  const held = new Map<string, number>();
  const groups = new Map<string, RepoRegroupGroup>();
  const leaving = new Map<string, number>();
  for (const rec of records) {
    if (rec.tag !== "SOUR" || !rec.xref) continue;
    const fromXref = firstChild(rec, "REPO")?.value?.trim() || undefined;
    if (fromXref) held.set(fromXref, (held.get(fromXref) ?? 0) + 1);
    if (!isFsSource(rec, fsRepos, objeUrl)) continue;
    if (!fromXref && !adoptRepoless) continue;
    const fromNode = fromXref ? repoNodes.get(fromXref) : undefined;
    const fromName = fromNode ? childText(fromNode, "NAME") : undefined;
    const where = sourceCountry(rec, fromName);
    if (!where) continue;
    const facet = where.facet;
    const target = countryRepo.get(facet);
    if (target && fromXref === target.xref) continue;
    let group = groups.get(facet);
    if (!group) {
      // The file's own record names the place as the file spells it; a place
      // only the sources name keeps their wording, or the world's.
      const name = (target ? childText(target, "NAME") : undefined) ?? `FamilySearch.org - ${where.name}`;
      group = { id: facet, repoName: name, targetXref: target?.xref, moves: [], emptied: [] };
      groups.set(facet, group);
    }
    group.moves.push({ sourceXref: rec.xref, title: childText(rec, "TITL") ?? rec.xref, fromXref, fromName });
    if (fromXref) leaving.set(fromXref, (leaving.get(fromXref) ?? 0) + 1);
  }

  // A repository every one of its sources leaves has nothing left to hold —
  // unless it is a country's own record, which the moves are joining.
  const targets = new Set([...groups.values()].map((g) => g.targetXref).filter(Boolean));
  for (const group of groups.values()) {
    const seen = new Set<string>();
    for (const move of group.moves) {
      const from = move.fromXref;
      if (!from || seen.has(from) || targets.has(from)) continue;
      seen.add(from);
      if ((leaving.get(from) ?? 0) >= (held.get(from) ?? 0)) {
        group.emptied.push({ xref: from, name: move.fromName ?? from });
      }
    }
  }

  const list = [...groups.values()].sort((a, b) => a.repoName.localeCompare(b.repoName));
  return { groups: list, total: list.reduce((n, g) => n + g.moves.length, 0) };
}

/**
 * Apply the regroup on a fresh clone of `records` — the input is never
 * mutated, so the caller can diff the two forests into one undoable step.
 * Each moved source keeps its call number; the country's repository is
 * created when the file has none, and a repository the moves emptied is
 * removed with them.
 */
export function regroupRepositories(
  records: GedNode[],
  groups: RepoRegroupGroup[],
): { records: GedNode[]; counts: { sourcesMoved: number; reposCreated: number; reposRemoved: number } } {
  const counts = { sourcesMoved: 0, reposCreated: 0, reposRemoved: 0 };
  if (groups.length === 0) return { records, counts };
  const callNumbers = writesCallNumbers(records);
  const clone = records.map(cloneNode);
  const byXref = new Map<string, GedNode>();
  for (const r of clone) if (r.xref) byXref.set(r.xref, r);

  const removed = new Set<string>();
  for (const group of groups) {
    let target = group.targetXref ? byXref.get(group.targetXref) : undefined;
    if (!target) {
      // Same record the Add Source dialog's "＋ …" choice writes: the site's
      // own address under the country's name.
      target = createSiteRepo(clone, "familysearch", "", undefined, undefined, group.repoName);
      if (!target?.xref) continue;
      byXref.set(target.xref, target);
      counts.reposCreated++;
    }
    for (const move of group.moves) {
      const source = byXref.get(move.sourceXref);
      if (!source || source.tag !== "SOUR") continue;
      const link = firstChild(source, "REPO");
      if (link) {
        link.value = target.xref;
      } else {
        const added: GedNode = { level: source.level + 1, tag: "REPO", value: target.xref, children: [] };
        // The archive's id goes in the one place this file states it: the
        // call number where the file writes those, else the FILN the source
        // already carries (see `writesCallNumbers`).
        const filn = callNumbers ? childText(source, "FILN") : undefined;
        if (filn) added.children.push({ level: added.level + 1, tag: "CALN", value: filn, children: [] });
        source.children.push(added);
      }
      counts.sourcesMoved++;
    }
    for (const empty of group.emptied) removed.add(empty.xref);
  }

  if (removed.size === 0) return { records: clone, counts };
  // Only a record nothing points at any more is dropped: a source left out of
  // the run may still cite one the rest of its group left behind.
  const stillCited = new Set<string>();
  for (const rec of clone) {
    if (rec.tag !== "SOUR") continue;
    const link = firstChild(rec, "REPO")?.value?.trim();
    if (link) stillCited.add(link);
  }
  const next = clone.filter((rec) => {
    const drop = rec.tag === "REPO" && rec.xref && removed.has(rec.xref) && !stillCited.has(rec.xref);
    if (drop) counts.reposRemoved++;
    return !drop;
  });
  return { records: next, counts };
}
