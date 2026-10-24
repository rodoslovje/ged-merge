import type { Dataset, GedNode, Translation } from "../gedcom/types";
import { firstChild } from "../gedcom/node";
import { type RecordPatch } from "../ui/historyTypes";
import { patchRecords, walkPlacNodes } from "./geocode";
import { UNDETERMINED } from "./fixTranslationLang";

/**
 * A place's translations (GEDCOM 7 `TRAN` + `LANG` under its `PLAC`), read and
 * written for a set of place values at once — the values one row of the places
 * tree stands for. A place's other names belong to the place, not to one event,
 * so every `PLAC` with one of the values carries the same list.
 */

/** The `TRAN` lines under one `PLAC`, in file order. */
function translationsAt(plac: GedNode): Translation[] {
  const out: Translation[] = [];
  for (const c of plac.children) {
    if (c.tag !== "TRAN" || !c.value?.trim()) continue;
    const lang = firstChild(c, "LANG")?.value?.trim();
    out.push(lang ? { value: c.value.trim(), lang } : { value: c.value.trim() });
  }
  return out;
}

function signature(list: Translation[]): string {
  return list.map((t) => `${t.value}\0${t.lang ?? ""}`).join("\n");
}

/** What the values carry today: each distinct list with the number of places
 *  writing it, most-written first — more than one means they disagree. */
export function placeTranslationSets(
  dataset: Dataset,
  values: ReadonlySet<string>,
): { list: Translation[]; n: number }[] {
  const sets = new Map<string, { list: Translation[]; n: number }>();
  const visit = (raw: GedNode) =>
    walkPlacNodes(raw, (plac) => {
      if (!values.has(plac.value!.trim())) return;
      const list = translationsAt(plac);
      const key = signature(list);
      const hit = sets.get(key);
      if (hit) hit.n++;
      else sets.set(key, { list, n: 1 });
    });
  for (const indi of dataset.individuals.values()) visit(indi.raw);
  for (const fam of dataset.families.values()) visit(fam.raw);
  return [...sets.values()].sort((a, b) => b.n - a.n);
}

/**
 * Give every `PLAC` with one of `values` exactly `list` as its translations,
 * each with its `LANG` (`und` where none was chosen). The new lines stand where
 * the first old one stood, else after the place's own FORM/LANG. Mutates the
 * dataset in place and returns `RecordPatch[]` for the undo stack.
 */
export function setPlaceTranslations(
  dataset: Dataset,
  values: ReadonlySet<string>,
  list: Translation[],
): RecordPatch[] {
  const clean = list
    .map((t) => ({ value: t.value.trim(), lang: t.lang?.trim() || UNDETERMINED }))
    .filter((t) => t.value);
  const want = signature(clean);
  return patchRecords(dataset, (raw) => {
    let changed = false;
    walkPlacNodes(raw, (plac) => {
      if (!values.has(plac.value!.trim()) || signature(translationsAt(plac)) === want) return;
      const first = plac.children.findIndex((c) => c.tag === "TRAN");
      const kept = plac.children.filter((c) => c.tag !== "TRAN");
      let at = first >= 0 ? plac.children.slice(0, first).filter((c) => c.tag !== "TRAN").length : -1;
      if (at < 0) {
        at = 0;
        kept.forEach((c, i) => {
          if (c.tag === "FORM" || c.tag === "LANG") at = i + 1;
        });
      }
      const lines = clean.map((t): GedNode => ({
        level: plac.level + 1,
        tag: "TRAN",
        value: t.value,
        children: [{ level: plac.level + 2, tag: "LANG", value: t.lang, children: [] }],
      }));
      kept.splice(at, 0, ...lines);
      plac.children = kept;
      changed = true;
    });
    return changed;
  });
}
