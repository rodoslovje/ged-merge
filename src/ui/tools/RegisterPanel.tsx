import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { collectFileCoords, type OfficialRename } from "../../tools/geocode";
import { loadDecisions, type GeocodeDecision } from "../../persist/geoDb";
import { checkPlacesAgainstRegister, type RegisterCheckReport } from "../../tools/registerCheck";
import { scanAddresses, type AddressRename } from "../../tools/addresses";
import { isOfflineQuery } from "../../geo/rn";
import { createKinshipResolver } from "../../match/kinship";
import { useDatasetDerivations } from "../DatasetDerivations";
import { buildPlaceSuggestions } from "../edit/placeSuggestions";
import { foldSearch } from "../globalSearch";
import { usePlaceStyle } from "../edit/PlaceLookupContext";
import { GazetteerMissing, useGazetteer } from "./GazetteerManager";
import { RegisterCheckSection } from "./RegisterCheckSection";
import { AddressCheckSection } from "./AddressCheckSection";
import { BackButton } from "../BackButton";
import { isEditableTarget, isModalOpen } from "../../keyboard/shortcuts";
import { useNameOf, useSettings } from "../SettingsContext";
import { useLocalRegisters } from "../useLocalRegisters";
import { ToolsLoading, TreeSearch, useDebounced } from "./shared";
import { useHomeCountry } from "../DatasetDerivations";

// The compliance report, as its own page.
//
// It began as a third tab of the geocode tool and did not belong there: those
// tabs are worklists — what is left to place — while this reads the whole file
// and holds it against the registers. Mixing them put two long lists under one
// tab bar and made "how much is left to do" mean two different things in one
// row of counts. It is reached from the Places page, beside the geocoding
// button, and has the two tabs its two questions deserve: the places, and the
// houses.
//
// A report, never a worklist of errors: see registerCheck.ts for why every
// finding is dismissible and nothing here writes to the file unasked.

interface Props {
  dataset: Dataset;
  active: boolean;
  /** Bumped on every committed edit batch, including undo/redo — the scans here
   *  walk the in-place-mutated dataset, so this is their only signal that it
   *  changed under them. */
  editVersion: number;
  /** Batched "take the official name" renames — each row renamed to the
   *  register's spelling and placed at its coordinate, all one undo step. */
  onApplyOfficialNames: (renames: OfficialRename[]) => number;
  /** Rename one house's address on every event that carries it. */
  onRenameAddresses: (renames: AddressRename[]) => number;
  /** Write a coordinate keyed by place+address, so a house's own position
   *  reaches that house and not the settlement around it. */
  onApplyAddressCoords: (assignments: Map<string, GeoCoord>) => number;
  /** Rename every occurrence of exactly one raw place value — the row's ✎, for
   *  a correction of the researcher's own rather than the register's. */
  onRenamePlaceValue: (from: string, to: string, addr?: string) => number;
  /** Return to the Places tree. */
  onBack: () => void;
  /** Jump to a person in Edit mode (the expanded row's people list). */
  onNavigate: (id: string) => void;
  /** The app-wide start person, for kinship labels in the people list. */
  startId?: string;
}

export function RegisterPanel({
  dataset,
  active,
  editVersion,
  onApplyOfficialNames,
  onApplyAddressCoords,
  onRenameAddresses,
  onRenamePlaceValue,
  onBack,
  onNavigate,
  startId,
}: Props) {
  const { t } = useTranslation();
  const { settings: appSettings } = useSettings();
  useNameOf();
  const derivations = useDatasetDerivations();
  // What a place naming no country is held to — see GeocodePanel.
  const home = useHomeCountry();

  // Esc returns to the Places tree, as it does from the geocode tool.
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isEditableTarget(e.target) || isModalOpen()) return;
      e.preventDefault();
      onBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onBack]);

  const [scanGen, setScanGen] = useState(0);
  // Every edit batch mutates the dataset in place, so nothing in the memo deps
  // below moves on its own; a hidden panel catches up when it is shown again.
  const lastEditVersion = useRef(editVersion);
  useEffect(() => {
    if (!active) return;
    if (lastEditVersion.current !== editVersion) {
      lastEditVersion.current = editVersion;
      setScanGen((g) => g + 1);
    }
  }, [active, editVersion]);

  const gaz = useGazetteer({ withIndex: true });
  const { index } = gaz;
  const [decisions, setDecisions] = useState<Map<string, GeocodeDecision> | null>(null);
  useEffect(() => {
    void loadDecisions().then(setDecisions);
  }, []);

  const placeSug = useMemo(
    () => derivations?.placeSuggestions() ?? buildPlaceSuggestions(dataset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, scanGen],
  );
  // The layout this file writes its places in — what a register entry is shown
  // as, so the reader compares like with like.
  const placeStyle = usePlaceStyle(dataset, placeSug.placeSuggestions, index);

  const addrRows = useMemo(
    () => derivations?.addressRows() ?? scanAddresses(dataset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, scanGen],
  );
  const kinship = useMemo(
    () =>
      startId && appSettings.showKinship
        ? (derivations?.kinship(startId) ?? createKinshipResolver(dataset, startId, t))
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, scanGen, startId, appSettings.showKinship, t],
  );
  const fileCoords = useMemo(
    () => collectFileCoords(dataset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, scanGen],
  );

  const [search, setSearch] = useState("");
  const query = foldSearch(useDebounced(search, 200).trim());

  /** Anything to hold the file to: an official register decides where it knows
   *  the place, and an OpenStreetMap or GeoNames directory answers for the
   *  countries no register covers. */
  const hasRegister = !!index?.entries.length;

  // Deferred behind a paint: a lookup per distinct place is a whole-file pass,
  // and run inside a render-time memo it blocked the frame that showed the page.
  const [report, setReport] = useState<RegisterCheckReport | null>(null);
  useEffect(() => {
    if (!hasRegister || !decisions) {
      setReport(null);
      return;
    }
    const id = window.setTimeout(
      () => setReport(checkPlacesAgainstRegister(dataset, index, decisions, placeStyle.fmt, home)),
      0,
    );
    return () => window.clearTimeout(id);
  }, [dataset, index, decisions, hasRegister, placeStyle, scanGen, home]);

  const [tab, setTab] = useState<"places" | "addresses">("places");
  /** How many address findings there are, once the check has been run — null
   *  while it never has, which keeps the tab from promising a count for work
   *  not yet done. */
  const [addrFindings, setAddrFindings] = useState<number | null>(null);
  // Subscribed so the addresses tab appears the moment a register lands and
  // goes when one is dropped.
  useLocalRegisters();
  const addrCheckable = useMemo(
    () => addrRows.filter((r) => r.queries.length > 0 && isOfflineQuery(r.queries)).length,
    [addrRows],
  );
  /** The tab pinned by a click, unless it has stopped existing. */
  const shown = tab === "addresses" && !addrCheckable ? "places" : tab;

  const [tabActionsEl, setTabActionsEl] = useState<HTMLElement | null>(null);

  if (!decisions) return <ToolsLoading label={t("tools.running")} />;

  return (
    <div className="tools-geocode">
      {/* The page's name beside the way back from it — see GeocodePanel, whose
          shape this shares. What used to stand on the right repeated the
          section heading a line below it, so the title took its place. */}
      <div className="tools-filter-row">
        <BackButton label={t("tools.places.geocodeBack")} shortcutHint="Esc" showLabel onClick={onBack} />
        <h2 className="tools-page-title">{t("tools.places.registerToggle")}</h2>
      </div>

      {/* Without a directory this page has nothing to say at all — and said it
          by rendering nothing, which reads as "your file is fine". The same
          notice the geocode list shows, in this page's own words. */}
      {!hasRegister && <GazetteerMissing note={t("tools.register.noGazetteer")} />}

      {/* Two tabs for two questions. The addresses one appears only where a
          stored register can answer something, which is the condition its
          section renders on. */}
      {addrCheckable > 0 && (
        <div className="tools-geo-tabs-row">
          <div className="tools-geo-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={shown === "places"}
              className={shown === "places" ? "active" : ""}
              onClick={() => setTab("places")}
            >
              {t("tools.register.tab.places")}{" "}
              <span className="tools-chip-count">{report?.findings.filter((f) => !f.dismissed).length ?? 0}</span>
            </button>
            <button
              role="tab"
              aria-selected={shown === "addresses"}
              className={shown === "addresses" ? "active" : ""}
              onClick={() => setTab("addresses")}
            >
              {t("tools.register.tab.addresses")}
              {addrFindings !== null && <span className="tools-chip-count"> {addrFindings}</span>}
            </button>
          </div>
          {/* The sections own their buttons' state and portal them here. */}
          <div className="tools-dup-bulk" ref={setTabActionsEl} />
        </div>
      )}

      {/* With the chips the sections draw right below it — narrowing in one
          place, as on the geocoding page. */}
      <div className="tools-filter-row tools-filter-row--narrow">
        <TreeSearch value={search} onChange={setSearch} />
      </div>

      {/* Both stay mounted: an address report costs a pass over the whole file,
          and switching tabs must not throw it away. */}
      <div style={shown === "places" ? undefined : { display: "none" }}>
        <RegisterCheckSection
          report={report}
          dataset={dataset}
          index={index}
          style={placeStyle}
          kinship={kinship}
          onNavigate={onNavigate}
          fileCoords={fileCoords}
          query={query}
          actionsHost={shown === "places" ? tabActionsEl : null}
          onRename={(from, to, addr) => void onRenamePlaceValue(from, to, addr)}
          onApplyAddressCoords={onApplyAddressCoords}
          placeSug={placeSug}
          onApplyOfficialNames={onApplyOfficialNames}
          onDecisionsChanged={() => void loadDecisions().then(setDecisions)}
        />
      </div>
      <AddressCheckSection
        hidden={shown !== "addresses"}
        actionsHost={shown === "addresses" ? tabActionsEl : null}
        onCount={setAddrFindings}
        rows={addrRows}
        dataset={dataset}
        decisions={decisions}
        query={query}
        kinship={kinship}
        onNavigate={onNavigate}
        onRenameAddresses={onRenameAddresses}
        onDecisionsChanged={() => void loadDecisions().then(setDecisions)}
      />
    </div>
  );
}
