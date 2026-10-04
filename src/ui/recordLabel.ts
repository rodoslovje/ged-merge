import type { ChangeReport } from "../merge/merge";
import type { Dataset, Individual } from "../gedcom/types";

/**
 * How a changed record is headed on the two screens that list them — the save
 * preview's cards and the downloaded change report.
 *
 * A `ChangeReport` writes its own `recordLabels` while the merge runs, in the
 * worker as often as not, where the reader's Name display settings (display
 * order, married surname, uppercase surname) are not to be had. So a person is
 * named here instead, from their own record, through the same `nameOf` the rest
 * of the app uses — and a woman recorded under her given name with a married
 * surname beside it is headed the way every other screen heads her.
 *
 * The report's label stays for everything that is not a person (families,
 * sources, media) and for a record neither the dataset nor the merge's
 * new-individuals map still holds, such as one this save removes.
 */
export function recordLabeller(
  report: ChangeReport,
  dataset: Dataset | undefined,
  nameOf: (indi: Individual) => string,
): (id: string) => string {
  return (id) => {
    const indi =
      report.recordKinds[id] === "individual"
        ? dataset?.individuals.get(id) ?? report.newIndividuals?.[id]
        : undefined;
    return indi ? nameOf(indi) : report.recordLabels[id] ?? id;
  };
}
