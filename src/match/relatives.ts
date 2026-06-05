import type { Dataset, GedEvent, Individual, PersonName } from "../gedcom/types";

/** The individual's primary name (first NAME record), if any. */
export function primaryName(indi: Individual): PersonName | undefined {
  return indi.names[0];
}

/** A short display label for an individual. */
export function label(indi: Individual): string {
  const n = primaryName(indi);
  const name = n?.full || [n?.given, n?.surname].filter(Boolean).join(" ") || "(unnamed)";
  const birth = findEvent(indi, "BIRT")?.date?.year;
  return birth ? `${name} (b. ${birth})` : name;
}

export function findEvent(indi: Individual, tag: string): GedEvent | undefined {
  return indi.events.find((e) => e.tag === tag);
}

/** Parents resolved via the families where this person is a child. */
export function parentNames(indi: Individual, ds: Dataset): PersonName[] {
  const names: PersonName[] = [];
  for (const famId of indi.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    pushName(names, fam.husband, ds);
    pushName(names, fam.wife, ds);
  }
  return names;
}

/** Spouses resolved via the families where this person is a parent. */
export function partnerNames(indi: Individual, ds: Dataset): PersonName[] {
  const names: PersonName[] = [];
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const otherId = fam.husband === indi.id ? fam.wife : fam.husband;
    pushName(names, otherId, ds);
  }
  return names;
}

function pushName(into: PersonName[], id: string | undefined, ds: Dataset): void {
  if (!id) return;
  const n = ds.individuals.get(id)?.names[0];
  if (n) into.push(n);
}
