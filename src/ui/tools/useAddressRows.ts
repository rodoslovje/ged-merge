import { useRef } from "react";
import type { Dataset } from "../../gedcom/types";
import { startAddressScan, type AddressRow } from "../../tools/addresses";
import { useDatasetDerivations } from "../DatasetDerivations";
import { useSlicedBuild } from "../useSlicedBuild";

const NO_ROWS: AddressRow[] = [];

/**
 * The file's place+address rows (see `scanAddresses`), scanned in slices so
 * a large file does not freeze the page: two seconds of work on half a
 * million people. Empty until the first scan of a file is through; a re-scan
 * (`gen` moved — an edit, an apply) keeps the rows before it on screen
 * meanwhile, so a list being worked on does not blink away.
 */
export function useAddressRows(dataset: Dataset, gen: unknown): AddressRow[] {
  const derivations = useDatasetDerivations();
  // The derivations' scan is shared: one per edit version, whoever asks.
  const build = useSlicedBuild(() => derivations?.addressScan() ?? startAddressScan(dataset), [dataset, gen]);
  const last = useRef<{ dataset: Dataset; rows: AddressRow[] } | null>(null);
  if (build.result) last.current = { dataset, rows: build.result };
  return build.result ?? (last.current?.dataset === dataset ? last.current.rows : NO_ROWS);
}
