import type { ScopedFacts } from "./scope";
import { mean, type Bucket, type Mean } from "./aggregate";

/**
 * The Research page: how well the scope's facts are backed by sources.
 */

/** One event type: how many of its events cite a source, and whose. */
export interface SourcedTag {
  /** The tag and whose events these are: RESI, CENS, EVEN, FACT and NCHI
   *  stand on people and families alike, and the two are counted apart. */
  key: string;
  tag: string;
  /** Events of this type, and those citing a source. */
  events: number;
  sourced: number;
  /** The records (people, or families for family events) with an event of this type
   *  citing no source — the ones a click lists. */
  missing: string[];
  families: boolean;
}

/** Event types shown, most common first. */
const TAG_LIMIT = 12;

export interface ResearchStats {
  byTag: SourcedTag[];
  /** All events, and those citing a source. */
  events: number;
  sourcedEvents: number;
  /** Source citations per person, in spans. */
  citations: Bucket[];
  citationsMean?: Mean;
  /** People with no event at all. */
  noEvents: string[];
}

export function researchStats(s: ScopedFacts): ResearchStats {
  const tags = new Map<string, SourcedTag>();
  const note = (id: string, eventTags: string[], sourcedTags: string[], families: boolean) => {
    const left = [...sourcedTags];
    for (const tag of eventTags) {
      const key = `${families ? "F" : "I"}:${tag}`;
      let t = tags.get(key);
      if (!t) tags.set(key, (t = { key, tag, events: 0, sourced: 0, missing: [], families }));
      t.events++;
      const at = left.indexOf(tag);
      if (at >= 0) {
        left.splice(at, 1);
        t.sourced++;
      } else if (t.missing[t.missing.length - 1] !== id) {
        t.missing.push(id);
      }
    }
  };
  for (const p of s.people) note(p.id, p.eventTags, p.sourcedTags, false);
  for (const f of s.families) note(f.id, f.eventTags, f.sourcedTags, true);
  const all = [...tags.values()];

  const spans: [string, number, number | undefined][] = [
    ["0", 0, 0], ["1", 1, 1], ["2", 2, 2], ["3", 3, 5], ["6", 6, 10], ["11", 11, undefined],
  ];
  const citations: Bucket[] = spans.map(([key, lo, hi]) => ({ key, lo, hi, count: 0, ids: [] }));
  for (const p of s.people) {
    const b = citations.find((x) => p.citations >= x.lo! && (x.hi === undefined || p.citations <= x.hi))!;
    b.count++;
    b.ids.push(p.id);
  }

  return {
    byTag: all.sort((a, b) => b.events - a.events || a.tag.localeCompare(b.tag)).slice(0, TAG_LIMIT),
    events: all.reduce((n, t) => n + t.events, 0),
    sourcedEvents: all.reduce((n, t) => n + t.sourced, 0),
    citations,
    citationsMean: mean(s.people.map((p) => p.citations)),
    noEvents: s.people.filter((p) => !p.eventTags.length).map((p) => p.id),
  };
}
