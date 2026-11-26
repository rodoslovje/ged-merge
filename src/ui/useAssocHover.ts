import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { AssocRole, Association, Dataset, Individual } from "../gedcom/types";
import { associationsIn, buildAssociationIndex, isVoidAssociation, type AssociationIndex, type AssocRef } from "../gedcom/assoc";
import { isPresumedLiving } from "../gedcom/lifespan";
import type { Translate } from "../locales/i18n";
import { useChartSettings } from "./ChartSettingsContext";
import { useDatasetDerivations } from "./DatasetDerivations";
import { roleLabel } from "./edit/EventAssociates";
import { useNameOf } from "./SettingsContext";
import { hiddenName, useLivingNameOf } from "./useLivingName";

// What a chart's hover card says about a person's godparents and witnesses —
// the people a parish register ties them to who are not their family, and so
// stand nowhere near them on a chart of kin. Two lines at most: who their own
// record names ("godfather Janez Koren, godmother Marina"), and how often
// other records name them ("godfather 15×, witness 2×").

/** The associates a card names before it trails off. */
const NAMED = 4;

/** Who names whom in `ds`, built on first use: the main file's index is the
 *  shared derivation, any other dataset's (a Compare tree's incoming side) is
 *  built here once. */
export function useAssociationIndex(ds: Dataset): () => AssociationIndex {
  const derived = useDatasetDerivations();
  const own = useRef<{ ds: Dataset; index: AssociationIndex } | null>(null);
  return useCallback(() => {
    if (derived?.dataset === ds) return derived.associationIndex();
    if (own.current?.ds !== ds) own.current = { ds, index: buildAssociationIndex(ds) };
    return own.current.index;
  }, [derived, ds]);
}

const capital = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/** The hover lines for `indi`: `namedBy` is their entry in the file's
 *  association index, `nameOf` a person's name as the chart may show it. */
export function assocHoverLines(
  t: Translate,
  ds: Dataset,
  indi: Individual,
  namedBy: AssocRef[] | undefined,
  nameOf: (indi: Individual) => string,
): string[] {
  const lines: string[] = [];

  // Their own associates, record-level first, then event by event.
  const own: Association[] = associationsIn(indi.raw);
  for (const child of indi.raw.children) {
    if (child.tag !== "ASSO" && child.tag !== "_ASSO") own.push(...associationsIn(child));
  }
  const named: string[] = [];
  const seen = new Set<string>();
  for (const assoc of own) {
    const who = isVoidAssociation(assoc) ? undefined : ds.individuals.get(assoc.targetId);
    const name = who ? nameOf(who) : assoc.name;
    if (!name) continue;
    // "Other" says nothing a name does not; the file's own wording does.
    const role = assoc.role === "OTHER" && !assoc.roleText ? "" : roleLabel(assoc, t, who?.sex);
    const text = role ? `${role} ${name}` : name;
    if (seen.has(text)) continue;
    seen.add(text);
    named.push(text);
  }
  if (named.length) lines.push(capital(named.slice(0, NAMED).join(", ")) + (named.length > NAMED ? ", …" : ""));

  // Where they are named, counted by role, the commonest first.
  const counts = new Map<AssocRole, number>();
  for (const ref of namedBy ?? []) counts.set(ref.assoc.role, (counts.get(ref.assoc.role) ?? 0) + 1);
  const context = indi.sex === "M" || indi.sex === "F" ? indi.sex : undefined;
  const roles = [...counts].sort((a, b) => b[1] - a[1]).map(([role, n]) => `${t(`assoc.role.${role}`, { context })} ${n}×`);
  if (roles.length) lines.push(capital(roles.join(", ")));

  return lines;
}

/** The hover lines for a person of `ds`, with the names the privacy setting
 *  hides written as a chart writes them. Empty for a person it hides. */
export function useAssocHover(ds: Dataset): (indi: Individual | undefined) => string[] | undefined {
  const { t } = useTranslation();
  const { settings } = useChartSettings();
  const nameOf = useNameOf();
  const livingNameOf = useLivingNameOf();
  const index = useAssociationIndex(ds);
  return useCallback(
    (indi) => {
      if (!indi) return undefined;
      const shown = (who: Individual) =>
        hiddenName(t, settings.privacyLiving, livingNameOf, who, isPresumedLiving(who, ds)) ?? nameOf(who);
      const lines = assocHoverLines(t, ds, indi, index().get(indi.id), shown);
      return lines.length ? lines : undefined;
    },
    [t, settings.privacyLiving, nameOf, livingNameOf, index, ds],
  );
}
