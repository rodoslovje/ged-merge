import type { PubEvent, PublishedTree } from "./model";

/**
 * The family website's data as it is written into the page: each distinct
 * place — its text, street address and coordinate — once, in `places`, and
 * every event pointing at its place by number (`pl`). Of a tree's events most
 * have a place, and the same few hundred places recur (29 000 events, 1400
 * places): a third less to download where nothing compresses (the page opened
 * from disk), and to parse on a phone. A family names its husband, wife and
 * children by their number in `people` too, not by id: ids are random to a
 * compressor, short numbers are not. In memory the tree keeps its plain shape
 * (`unpackTree`), so the viewer reads it as ever; a page written before
 * either, with no `places` and ids in its families, reads as it is.
 */

/** One place of the table: what an event's place fields hold. */
export interface PackedPlace {
  place?: string;
  address?: string;
  lat?: number;
  lon?: number;
}

type PackedEvent = Omit<PubEvent, "place" | "address" | "lat" | "lon"> & { pl?: number };

export interface PackedTree extends Omit<PublishedTree, "people" | "families"> {
  places?: PackedPlace[];
  people: (Omit<PublishedTree["people"][number], "events"> & { events?: PackedEvent[] })[];
  families: (Omit<PublishedTree["families"][number], "events" | "husband" | "wife" | "children"> & {
    events?: PackedEvent[];
    /** A person's number in `people`, or their id where they are not there. */
    husband?: number | string;
    wife?: number | string;
    children?: (number | string)[];
  })[];
}

const hasPlace = (e: PubEvent) => e.place !== undefined || e.address !== undefined || e.lat !== undefined || e.lon !== undefined;

/** The tree with its places in a table, ready to write into the page. */
export function packTree(tree: PublishedTree): PackedTree {
  const places: PackedPlace[] = [];
  const index = new Map<string, number>();
  const packEvent = (e: PubEvent): PackedEvent => {
    if (!hasPlace(e)) return e;
    const { place, address, lat, lon, ...rest } = e;
    const key = JSON.stringify([place, address, lat, lon]);
    let at = index.get(key);
    if (at === undefined) {
      const entry: PackedPlace = {};
      if (place !== undefined) entry.place = place;
      if (address !== undefined) entry.address = address;
      if (lat !== undefined) entry.lat = lat;
      if (lon !== undefined) entry.lon = lon;
      at = places.length;
      places.push(entry);
      index.set(key, at);
    }
    return { ...rest, pl: at };
  };
  const people = tree.people.map((p) => (p.events ? { ...p, events: p.events.map(packEvent) } : p));
  const at = new Map(tree.people.map((p, i) => [p.id, i]));
  const ref = (id: string) => at.get(id) ?? id;
  const families = tree.families.map((f) => {
    const out: PackedTree["families"][number] = f.events ? { ...f, events: f.events.map(packEvent) } : { ...f };
    if (f.husband !== undefined) out.husband = ref(f.husband);
    if (f.wife !== undefined) out.wife = ref(f.wife);
    if (f.children) out.children = f.children.map(ref);
    return out;
  });
  return places.length ? { ...tree, places, people, families } : { ...tree, people, families };
}

/** The tree as the viewer reads it: every event with its own place fields. */
export function unpackTree(packed: PackedTree): PublishedTree {
  const { places, ...rest } = packed;
  const unpackEvent = (e: PackedEvent): PubEvent => {
    if (e.pl === undefined || !places) return e;
    const { pl, ...event } = e;
    return { ...event, ...places[pl] };
  };
  const id = (r: number | string) => (typeof r === "number" ? rest.people[r].id : r);
  return {
    ...rest,
    people: rest.people.map((p) => (p.events ? { ...p, events: p.events.map(unpackEvent) } : p)),
    families: rest.families.map((f) => {
      const out = { ...f, ...(f.events ? { events: f.events.map(unpackEvent) } : {}) };
      if (f.husband !== undefined) out.husband = id(f.husband);
      if (f.wife !== undefined) out.wife = id(f.wife);
      if (f.children) out.children = f.children.map(id);
      return out;
    }),
  } as PublishedTree;
}
