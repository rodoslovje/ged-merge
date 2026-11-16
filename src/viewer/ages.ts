import { ageBetween, coupleAgesDisplay, fullAgeBetween, type AgeBadge } from "../gedcom/age";
import { isSameSexCouple } from "../gedcom/couple";
import { parseDate } from "../gedcom/date";
import { birthDateOf } from "../gedcom/lifespan";
import type { Dataset, Family, Individual } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import type { PubEvent } from "../publish/model";

/**
 * The ages beside a person's events, as Edit shows them: the father's and the
 * mother's at the birth, the person's own at every other event. Only from the
 * dates the site publishes — a parent shown without details has no birth
 * date here, so no age.
 */
export function personEventAges(ds: Dataset, indi: Individual, t: Translate): (e: PubEvent) => AgeBadge[] | undefined {
  const fams = indi.childOf.map((id) => ds.families.get(id));
  const father = ds.individuals.get(fams.find((f) => f?.husband)?.husband ?? "");
  const mother = ds.individuals.get(fams.find((f) => f?.wife)?.wife ?? "");
  const parents = isSameSexCouple(father, mother)
    ? { husband: t("event.age.parent"), wife: t("event.age.parent") }
    : { husband: t("event.age.father"), wife: t("event.age.mother") };
  const born = birthDateOf(indi);
  return (e) => {
    if (!e.date) return undefined;
    const at = parseDate(e.date);
    if (e.tag === "BIRT") return coupleAgesDisplay(father, mother, at, parents, t);
    const age = ageBetween(born, at);
    if (age === undefined) return undefined;
    const detail = fullAgeBetween(born, at, t);
    return [{ text: String(age), title: detail ? `${t("event.age.person")}: ${detail}` : t("event.age.person") }];
  };
}

/** The partners' ages beside a family's events (a marriage, a divorce). */
export function familyEventAges(ds: Dataset, fam: Family, t: Translate): (e: PubEvent) => AgeBadge[] | undefined {
  const husband = ds.individuals.get(fam.husband ?? "");
  const wife = ds.individuals.get(fam.wife ?? "");
  const labels = isSameSexCouple(husband, wife)
    ? { husband: t("event.age.partner"), wife: t("event.age.partner") }
    : { husband: t("event.age.husband"), wife: t("event.age.wife") };
  return (e) => (e.date ? coupleAgesDisplay(husband, wife, parseDate(e.date), labels, t) : undefined);
}
