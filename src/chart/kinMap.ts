import type { Dataset, Individual } from "../gedcom/types";
import { personPoints, type MapPoint } from "../geo/points";
import type { KinPerson } from "./kinshipWheel";

// The Contemporaries chart's third layout: the same blood relatives, each at
// one place on a map. Pure data like the wheel and the bars — the React/Leaflet
// layer draws it.
//
// One dot per person, at one *anchor* place. The map answers "where did my kin
// come from", so the anchor is the birth (BIRT first, then a christening),
// failing that the earliest dated event with coordinates, then the death or
// burial, and last an undated event. Nobody is placed by guesswork: a relative
// with no coordinated event at all is listed, not drawn at a parent's village,
// because on this chart a guessed dot would look exactly like a real one.

/** A relative and the map point they stand at. */
export interface KinPlaced {
  person: KinPerson;
  /** The anchor event, attributed to this person alone — a marriage anchors
   *  each spouse separately, so clustering counts people, not events. */
  point: MapPoint;
}

export interface KinMapData {
  placed: KinPlaced[];
  /** Relatives with a place written on some event, but no coordinates on any —
   *  the ones geocoding would put on the map. */
  noCoords: KinPerson[];
  /** Relatives with no place at all. */
  noPlace: KinPerson[];
}

/** How good a point is as the person's anchor: lower wins, ties go to the
 *  earliest date. Dated mid-life events (residence, marriage…) outrank the
 *  death, which outranks the burial; an undated mid-life event comes last —
 *  it says where, but not where *first*. */
function anchorRank(p: MapPoint): number {
  if (p.tag === "BIRT") return 0;
  if (p.kind === "birth") return 1;
  if (p.kind === "death") return 3;
  if (p.kind === "burial") return 4;
  return p.dateKey !== undefined ? 2 : 5;
}

/** The one point a person is drawn at, out of their coordinated events. */
export function anchorPoint(points: readonly MapPoint[]): MapPoint | undefined {
  let best: MapPoint | undefined;
  let bestRank = Infinity;
  let bestKey = Infinity;
  for (const p of points) {
    const rank = anchorRank(p);
    const key = p.dateKey ?? Infinity;
    if (rank < bestRank || (rank === bestRank && key < bestKey)) {
      best = p;
      bestRank = rank;
      bestKey = key;
    }
  }
  return best;
}

/** Whether any event of the person's — their own, or of a family they are a
 *  spouse in — names a place at all. */
function hasAnyPlace(ds: Dataset, indi: Individual): boolean {
  if (indi.events.some((e) => e.place?.raw)) return true;
  for (const famId of indi.spouseOf) {
    if (ds.families.get(famId)?.events.some((e) => e.place?.raw)) return true;
  }
  return false;
}

/** Split the chart's people into those with an anchor and the two kinds of
 *  unplaced. Keeps the input order (closest first). */
export function placeKin(ds: Dataset, people: readonly KinPerson[]): KinMapData {
  const placed: KinPlaced[] = [];
  const noCoords: KinPerson[] = [];
  const noPlace: KinPerson[] = [];
  for (const person of people) {
    const anchor = anchorPoint(personPoints(ds, person.id));
    if (anchor) placed.push({ person, point: { ...anchor, personIds: [person.id] } });
    else if (hasAnyPlace(ds, person.indi)) noCoords.push(person);
    else noPlace.push(person);
  }
  return { placed, noCoords, noPlace };
}
