import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { COUNTRY_CODES } from "../../gedcom/countryCode";
import {
  buildGazetteerIndex,
  DGU_REGISTER,
  GURS_REGISTER,
  mergeDivisions,
  storedEntries,
  type GazetteerIndex,
  type Subdivision,
} from "../../geo/gazetteer";
import { countryNameOf } from "../../geo/placeProposal";
import { addressRegisterInfo } from "../../geo/addressLookup";
import {
  cancelGeoImport,
  dismissRegions,
  geoDataChanged,
  geoImportSnapshot,
  startAllRegions,
  startImport,
  startOsmCountry,
  watchGeoData,
  watchGeoImport,
} from "./geoImport";
import { deleteAddressRegister, deleteCountry, loadCountries, type CountryMeta } from "../../persist/geoDb";
import type { GeoFailure, GeoStage } from "../../worker/geoMessages";
import { requestSettings } from "../settingsBus";
import { ToolsError, ToolsLoading } from "./shared";
import { SelectMenu } from "../DropdownMenu";

// The place-directory manager: the offline gazetteers (GeoNames country extracts,
// OpenStreetMap downloads, the GURS register of Slovenian settlements and the DGU
// register of Croatian geographical names) that live in the gedmerge-geo
// IndexedDB and back every place lookup in the app — and, alongside them, the
// two national *address* registers (GURS's and DGU's), downloaded here for the
// same reason and dropped here the same way, but answering houses rather than
// places (see addressRegister.ts).
//
// Each source is one row: who it comes from, named once, and what of theirs you
// can take. A register offers two things, its settlements and its house
// numbers, and they differ in cost by an order of magnitude — hence two buttons
// under one name and one description.
//
// It is one-time setup that outlives the file, so Settings → Map owns it. The
// Geocode places tool keeps the same controls for as long as there is nothing
// loaded — that is where a researcher first learns they need a directory, and
// sending them elsewhere at that moment would be a dead end — and shrinks to a
// one-line summary once there is.
//
// What this file does *not* do is download anything. Every source — the two
// registers, their address registers, OpenStreetMap, a GeoNames file — is
// fetched, converted and stored by one worker driven by one runner
// (geoImport.ts), which is why a click here is a job name and a failure here is
// a code turned into a sentence. It used to be otherwise, and the difference
// was not academic: the imports this component ran itself died when it
// unmounted, which Settings does every time its tab changes.

/** The direction each source moves data: two fetch it from a service, one takes
 *  it off your own disk. Plain arrows, not emoji — they inherit the button's
 *  colour in both themes, where ⬇/⬆ would draw in their own. */
const DOWNLOAD_GLYPH = "↓";
const UPLOAD_GLYPH = "↑";

/** What the manager shows while an import runs, or once it has failed — the
 *  runner's state with its failure already worded. */
type ImportState =
  | { phase: "running"; stage: GeoStage; done: number; total: number; note?: string }
  | { phase: "error"; message: string }
  | null;

/**
 * Whole seconds since `active` became true, 0 when it is not. Overpass answers a
 * country query only once it has computed the whole extract, so for ten seconds
 * or more there is no byte to count and nothing else on screen moves — a ticking
 * number is the difference between "working" and "hung".
 */
function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const id = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return active ? seconds : 0;
}

/** A stored national address register — a different kind of thing from the
 *  place directories beside it: houses, not settlements, and read straight out
 *  of IndexedDB instead of an index built in memory. */
export interface AddressRegisterMeta {
  country: string;
  count: number;
  importedAt: number;
}

/** What {@link useGazetteer} hands its controls — and, in the Geocode tool, the
 *  built index the whole review list is scored against. */
export interface Gazetteer {
  /** Null until IndexedDB has answered; empty array = nothing imported yet. */
  countries: CountryMeta[] | null;
  /** The stored address registers — at most one, Croatia's, today. Null until
   *  IndexedDB has answered. */
  addressRegisters: AddressRegisterMeta[] | null;
  /** The searchable index, built only where it is used (`withIndex`). */
  index: GazetteerIndex | undefined;
  importState: ImportState;
  importFile: (file: File) => void;
  /** Fetch one country's places from OpenStreetMap, by ISO 3166-1 alpha-2. */
  downloadCountry: (country: string) => void;
  downloadSlovenia: () => void;
  downloadCroatia: () => void;
  /** Fetch a national address register — the houses, not the places. */
  downloadCroatiaAddresses: () => void;
  downloadSloveniaAddresses: () => void;
  removeAddressRegister: (country: string) => Promise<void>;
  /** The country whose places are too many for one query, and the subdivisions
   *  offered instead. Null whenever there is no such offer on the table. */
  regions: { country: string; list: Subdivision[] } | null;
  /** Fetch one ISO 3166-2 subdivision ("US-CA") into its country's directory. */
  downloadRegion: (region: string) => void;
  /** Fetch every offered subdivision, one after another. */
  downloadAllRegions: () => void;
  dismissRegions: () => void;
  cancelImport: () => void;
  removeCountry: (code: string) => Promise<void>;
}

/**
 * The gazetteer store: what is imported, and every way to change it. Held by the
 * two hosts separately — `withIndex` because only the Geocode tool searches the
 * entries, and building that index over a country's places is not work Settings
 * should do to show a list of two lines.
 */
export function useGazetteer({ withIndex = false }: { withIndex?: boolean } = {}): Gazetteer {
  const { t } = useTranslation();
  const [countries, setCountries] = useState<CountryMeta[] | null>(null);
  const [addressRegisters, setAddressRegisters] = useState<AddressRegisterMeta[] | null>(null);
  const [index, setIndex] = useState<GazetteerIndex | undefined>(undefined);

  // Imports run outside this component, so their progress is read rather than
  // held — and a manager mounting halfway through one picks it up.
  const snapshot = useSyncExternalStore(watchGeoImport, geoImportSnapshot, geoImportSnapshot);

  const reload = async () => {
    const stored = await loadCountries();
    setCountries(
      stored.map(({ code, count, importedAt }) => ({ code, count, importedAt })).sort((a, b) => b.count - a.count),
    );
    const registers: AddressRegisterMeta[] = [];
    for (const country of ["SI", "HR"] as const) {
      const info = await addressRegisterInfo(country);
      if (info) registers.push({ country, ...info });
    }
    setAddressRegisters(registers);
    if (withIndex)
      setIndex(stored.length ? buildGazetteerIndex(storedEntries(stored), mergeDivisions(stored)) : undefined);
  };

  useEffect(() => {
    void reload();
    // Whatever writes or deletes a directory says so once, wherever it happened
    // — an import that landed while this manager was unmounted included.
    return watchGeoData(() => void reload());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * A failure in the reader's own language.
   *
   * Every source fails in the same handful of ways, so every source's failure
   * is worded here and nowhere else: the download did not go through, the
   * service is loaded, the answer held nothing, the payload was not what it
   * should be, the browser would not store it, the worker never started.
   */
  const failureText = (failure: GeoFailure): string => {
    switch (failure.code) {
      case "download":
      case "busy":
        return t("tools.geocode.downloadFailed");
      // A country too large is normally the region offer rather than an error;
      // it reaches here only when there are no regions to offer, or when one
      // region is itself too large — which is the region's own dead end and
      // says so, since the country's other regions are unaffected.
      case "tooLarge":
        return failure.region
          ? t("tools.geocode.regionTooLarge", { region: failure.region })
          : t("tools.geocode.tooLargeNoRegions");
      case "empty":
        return t("tools.geocode.emptyResult");
      case "unreadable":
        return t("tools.geocode.unreadable", { detail: failure.detail });
      case "storeBlocked":
        return t("tools.geocode.storeBlocked");
      case "storeRefused":
        return t("tools.geocode.storeRefused", { detail: failure.detail });
      case "stalled":
        return t("tools.geocode.stalled");
      case "workerFailed":
        return t("tools.geocode.workerLoadFailed");
    }
  };

  const state = snapshot.state;
  const importState: ImportState =
    state.phase === "running"
      ? { phase: "running", stage: state.stage, done: state.done, total: state.total, note: state.note }
      : state.phase === "error"
        ? { phase: "error", message: failureText(state.failure) }
        : state.phase === "partial"
          ? {
              phase: "error",
              message: t("tools.geocode.regionAllFailed", {
                count: state.failed.length,
                names: state.failed.join(", "),
              }),
            }
          : null;

  const removeCountry = async (code: string) => {
    await deleteCountry(code);
    geoDataChanged();
  };

  const removeAddressRegister = async (country: string) => {
    await deleteAddressRegister(country);
    geoDataChanged();
  };

  return {
    countries,
    addressRegisters,
    index,
    importState,
    importFile: (file) => startImport({ kind: "file", file }),
    downloadCountry: startOsmCountry,
    downloadSlovenia: () => startImport({ kind: "gurs" }),
    downloadCroatia: () => startImport({ kind: "dgu" }),
    downloadSloveniaAddresses: () => startImport({ kind: "addresses", country: "SI" }),
    downloadCroatiaAddresses: () => startImport({ kind: "addresses", country: "HR" }),
    removeAddressRegister,
    regions: snapshot.regions,
    // "US-CA" belongs to "US": the country is the storage key its places merge
    // into, and the region is the piece being replaced there.
    downloadRegion: (region) => startImport({ kind: "osm", country: region.slice(0, region.indexOf("-")), region }),
    downloadAllRegions: () =>
      startAllRegions((name, index, total) => t("tools.geocode.regionProgress", { name, index, total })),
    dismissRegions,
    cancelImport: cancelGeoImport,
    removeCountry,
  };
}

/** What a directory code stands for, spelled out for the chip's tooltip: the
 *  official registers by name, a "-OSM" key as an OpenStreetMap download, and
 *  a bare country code — by convention — as a GeoNames file. */
function directoryTitle(code: string, language: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (code === GURS_REGISTER) return t("tools.geocode.dir.gurs");
  if (code === DGU_REGISTER) return t("tools.geocode.dir.dgu");
  const country = countryNameOf(code.slice(0, 2), language) ?? code.slice(0, 2);
  return code.endsWith("-OSM") ? t("tools.geocode.dir.osm", { country }) : t("tools.geocode.dir.geonames", { country });
}

/** What is imported, with the date and a way to drop it again. The address
 *  registers sit in the same list, marked for what they are: they are imported
 *  the same way, they are dropped the same way, and a reader wants one answer
 *  to "what does this browser hold". */
function GazetteerList({ gaz }: { gaz: Gazetteer }) {
  const { t, i18n } = useTranslation();
  const dateFmt = new Intl.DateTimeFormat(i18n.language);
  if (!gaz.countries?.length && !gaz.addressRegisters?.length) return null;
  return (
    <ul className="tools-geo-countries">
      {gaz.countries?.map((c) => (
        <li key={c.code}>
          <span className="tools-geo-country gm-data" title={directoryTitle(c.code, i18n.language, t)}>{c.code}</span>
          <span className="tools-geo-count">
            {t("tools.geocode.countryMeta", { count: c.count, date: dateFmt.format(c.importedAt) })}
          </span>
          <button
            className="tools-geo-delete"
            onClick={() => void gaz.removeCountry(c.code)}
            title={t("tools.geocode.deleteCountry")}
            aria-label={t("tools.geocode.deleteCountry")}
          >
            🗑
          </button>
        </li>
      ))}
      {gaz.addressRegisters?.map((a) => (
        <li key={`addr-${a.country}`}>
          {/* "HR-ADR", in the same shape as the "HR-DGU" of the places above:
              the code names the source, and this source is the addresses. */}
          <span className="tools-geo-country gm-data" title={t("tools.geocode.dir.dguAddresses")}>
            {`${a.country}-ADR`}
          </span>
          <span className="tools-geo-count">
            {t("tools.geocode.addressMeta", { count: a.count, date: dateFmt.format(a.importedAt) })}
          </span>
          <button
            className="tools-geo-delete"
            onClick={() => void gaz.removeAddressRegister(a.country)}
            title={t("tools.geocode.deleteAddresses")}
            aria-label={t("tools.geocode.deleteAddresses")}
          >
            🗑
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The way out of a country too large to fetch whole: its regions, one at a time
 * or all of them in a row.
 *
 * It appears in place of an error, because a timeout on the United States is not
 * a fault to report — the country simply has to be asked for in pieces, and the
 * pieces are right here. The whole-country control above stays where it is: what
 * fails for one country works for the next.
 */
function RegionPicker({ gaz, regions }: { gaz: Gazetteer; regions: { country: string; list: Subdivision[] } }) {
  const { t, i18n } = useTranslation();
  const countryName = useMemo(
    () => new Intl.DisplayNames([i18n.language], { type: "region" }).of(regions.country) ?? regions.country,
    [i18n.language, regions.country],
  );
  return (
    <div className="tools-geo-regions">
      <p className="tools-geo-hint">
        {t("tools.geocode.regionIntro", { country: countryName, count: regions.list.length })}
      </p>
      <div className="tools-geo-acquire">
        <SelectMenu
          className="nav-btn tools-run tools-geo-osm"
          ariaLabel={t("tools.geocode.regionPick")}
          value=""
          placeholder={`${DOWNLOAD_GLYPH} ${t("tools.geocode.regionPick")}`}
          onChange={(region) => {
            if (region) gaz.downloadRegion(region);
          }}
          options={regions.list.map(({ code, name }) => ({ value: code, label: name }))}
        />
        <button className="nav-btn tools-run" onClick={() => gaz.downloadAllRegions()}>
          <span aria-hidden="true">{DOWNLOAD_GLYPH} </span>
          {t("tools.geocode.regionAll", { count: regions.list.length })}
        </button>
        <button className="tools-issue-link" onClick={gaz.dismissRegions}>
          {t("tools.geocode.regionDismiss")}
        </button>
      </div>
      <p className="tools-geo-hint">{t("tools.geocode.regionAllHint", { count: regions.list.length })}</p>
    </div>
  );
}

/**
 * One source, named once above whatever it offers.
 *
 * The source's name is a label rather than words inside each control: a
 * register offers two downloads, and "GURS (Slovenia)" written into both would
 * say the same thing twice while what actually tells them apart — places
 * against addresses — is left to fight for the remaining space. With the name
 * lifted out, every row reads the same way: who it comes from, then what of
 * theirs you can take.
 */
function SourceGroup({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="tools-geo-source">
      <span className="tools-geo-source-name">{name}</span>
      <div className="tools-geo-source-actions">{children}</div>
    </div>
  );
}

/** A national register's pair: its settlements, and its house numbers. They
 *  share one description — choosing between GURS and DGU is choosing a country,
 *  while choosing between the two buttons is the smaller decision the tooltips
 *  carry, since what they cost differs by an order of magnitude. */
function RegisterSource({
  name,
  places,
  addresses,
}: {
  name: string;
  places: { onClick: () => void; title: string };
  addresses: { onClick: () => void; title: string };
}) {
  const { t } = useTranslation();
  return (
    <SourceGroup name={name}>
      <button className="nav-btn tools-run" onClick={places.onClick} title={places.title}>
        <span aria-hidden="true">{DOWNLOAD_GLYPH} </span>
        {t("tools.geocode.sourcePlaces")}
      </button>
      <button className="nav-btn tools-run" onClick={addresses.onClick} title={addresses.title}>
        <span aria-hidden="true">{DOWNLOAD_GLYPH} </span>
        {t("tools.geocode.sourceAddresses")}
      </button>
    </SourceGroup>
  );
}

/** The ways in: the two national registers (GURS, DGU), any country from
 *  OpenStreetMap, or a GeoNames file. None of them is held to the online-lookups
 *  opt-in (see below) — and the file import sits under the paragraph that tells
 *  you where to fetch the file, because that instruction is half the button. */
function GazetteerAcquire({ gaz }: { gaz: Gazetteer }) {
  const { t, i18n } = useTranslation();
  // The picker replaces a two-letter code box: nobody should have to know that
  // Croatia is HR. Names come from the browser in the reader's own language, and
  // fall back to the code itself where it has none.
  const countries = useMemo(() => {
    const names = new Intl.DisplayNames([i18n.language], { type: "region" });
    return COUNTRY_CODES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) =>
      a.name.localeCompare(b.name, i18n.language),
    );
  }, [i18n.language]);
  const running = gaz.importState?.phase === "running" ? gaz.importState : undefined;
  const waited = useElapsed(running?.stage === "waiting");
  if (running) {
    // Each stage says what it is actually doing: waiting on a service that sends
    // nothing until it is ready, looking up the regions a country is fetched
    // in, receiving bytes, converting them, or writing them away. Only the wait
    // needs a clock — the others have their own numbers.
    const stage =
      running.stage === "waiting"
        ? `${t("tools.geocode.waiting")}${waited ? ` ${waited} s` : ""}`
        : running.stage === "regions"
          ? t("tools.geocode.regionsLoading")
          : running.stage === "downloading"
            ? t("tools.geocode.downloading")
            : running.stage === "storing"
              ? t("tools.geocode.storing")
              : t("tools.geocode.importing");
    // In a region run the region leads: which of the fifty is on the wire is
    // the thing being waited for, and the stage is a detail of it.
    const label = running.note ? `${running.note} — ${stage}` : stage;
    return <ToolsLoading label={label} progress={running} bytes onCancel={gaz.cancelImport} />;
  }
  return (
    <>
      {gaz.importState?.phase === "error" && <ToolsError message={gaz.importState.message} />}
      {gaz.regions && <RegionPicker gaz={gaz} regions={gaz.regions} />}
      {/* Each way in is its button and the sentence that explains it, side by
          side: what the source gives you and what it asks in return is the whole
          basis for choosing between them, so it belongs beside the click rather
          than in a paragraph naming all three. */}
      {/* Downloading a directory is not a lookup, and is not held to the
          online-lookups switch. That switch is there because a lookup says what
          you are researching: it sends the place off your machine and asks a
          service about it. This asks nothing — it fetches a country's whole
          published dataset, the same bytes for everyone who clicks, and reads
          it here. Gating it meant a reader who wanted the app to keep its
          questions to itself could not have the very directories that make the
          questions unnecessary. */}
      <div className="tools-geo-sources">
        <>
            {/* The credit names the agency, so the agency's name is the link —
                to its own public viewer, where the datasets this row holds can
                be seen in full or one settlement checked against its source.
                The name itself is a proper noun in either language and stays
                out of the locale files. */}
            <RegisterSource
              name={t("tools.geocode.gursName")}
              places={{ onClick: () => gaz.downloadSlovenia(), title: t("tools.geocode.gursTooltip") }}
              addresses={{
                onClick: () => gaz.downloadSloveniaAddresses(),
                title: t("tools.geocode.gursAddressesTooltip"),
              }}
            />
            <p className="tools-geo-hint">
              {t("tools.geocode.sourceGurs")} ©{" "}
              <a href="https://ipi.eprostor.gov.si/jv/" target="_blank" rel="noreferrer">
                Geodetska uprava Republike Slovenije
              </a>
              {t("tools.geocode.licenseCcBy")}
            </p>
            <RegisterSource
              name={t("tools.geocode.dguName")}
              places={{ onClick: () => gaz.downloadCroatia(), title: t("tools.geocode.dguTooltip") }}
              addresses={{
                onClick: () => gaz.downloadCroatiaAddresses(),
                title: t("tools.geocode.dguAddressesTooltip"),
              }}
            />
            <p className="tools-geo-hint">
              {t("tools.geocode.sourceDgu")} ©{" "}
              <a href="https://geoportal.dgu.hr/" target="_blank" rel="noreferrer">
                Državna geodetska uprava
              </a>
              {t("tools.geocode.licenseOpen")}
            </p>
            {/* One control, not a pair: OpenStreetMap has no address register
                to offer, and the control opens the country list where the
                country picked is the click — the same shape as the map tab's
                "Add a free preset…". It never holds a selection, so it reads as
                its own label again the moment the download starts. */}
            <SourceGroup name="OpenStreetMap">
              <SelectMenu
                className="nav-btn tools-run tools-geo-osm"
                title={t("tools.geocode.countryTooltip")}
                ariaLabel={t("tools.geocode.countryTooltip")}
                value=""
                placeholder={`${DOWNLOAD_GLYPH} ${t("tools.geocode.sourcePlaces")}`}
                onChange={(code) => {
                  if (code) gaz.downloadCountry(code);
                }}
                options={countries.map(({ code, name }) => ({ value: code, label: name }))}
              />
            </SourceGroup>
            <p className="tools-geo-hint">
              {t("tools.geocode.sourceOsm")} {t("tools.geocode.sourceOsmCredit")}{" "}
              <a href="https://www.openstreetmap.org" target="_blank" rel="noreferrer">
                OpenStreetMap
              </a>
              {t("tools.geocode.sourceOsmLicense")}
            </p>
        </>
        {/* The fallback: for a country neither download serves, and for anyone
            who would rather the app fetched nothing at all. Named like the rows
            above even though the arrow points the other way — where the data
            comes from is the thing being chosen either way. */}
        <SourceGroup name="GeoNames">
          <label className="nav-btn tools-geo-import">
            <span aria-hidden="true">{UPLOAD_GLYPH} </span>
            {t("tools.geocode.importBtn")}
            <input
              type="file"
              accept=".txt,.zip"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) gaz.importFile(file);
              }}
            />
          </label>
        </SourceGroup>
        <p className="tools-geo-hint">
          {t("tools.geocode.sourceGeoNames")}{" "}
          <a href="https://download.geonames.org/export/dump/" target="_blank" rel="noreferrer">
            download.geonames.org/export/dump
          </a>
          {t("tools.geocode.sourceGeoNames2")}©{" "}
          {/* Two links, two different things: the dump above is where the file
              is fetched from, this one is the project being credited. */}
          <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">
            GeoNames
          </a>
          {t("tools.geocode.licenseCcBy")}
        </p>
      </div>
      <p className="tools-geo-hint">{t("tools.geocode.storedLocally")}</p>
    </>
  );
}

/** The whole manager, as Settings → Map shows it: everything imported, every way
 *  to add more, and the credits. */
export function GazetteerManager({ gaz }: { gaz: Gazetteer }) {
  const { t } = useTranslation();
  return (
    <div className="tools-geo-gazetteer settings-geo">
      {gaz.countries?.length === 0 && <p className="tools-geo-empty">{t("settings.geo.empty")}</p>}
      <GazetteerList gaz={gaz} />
      <GazetteerAcquire gaz={gaz} />
    </div>
  );
}

/**
 * The manager as the Geocode tool shows it. With nothing imported it is the full
 * thing, because that is the moment the need is discovered and the list below
 * cannot work without it. With something imported it is one line — which
 * directories are in and how big — and the managing happens in Settings.
 */
/**
 * What a page says when it has no place directory to work with: what it cannot
 * do without one, and the one click to the place that manages them. The
 * controls themselves are deliberately *not* repeated here — two copies of the
 * same setup invite the reader to wonder which one is the real one.
 *
 * `note` is the page's own sentence, because the loss differs: the geocode list
 * can still take a coordinate typed by hand, while the compliance check has
 * nothing whatever to hold the file to.
 */
export function GazetteerMissing({ note }: { note: string }) {
  const { t } = useTranslation();
  return (
    <div className="tools-geo-gazetteer">
      <p className="tools-geo-empty">{note}</p>
      <button className="tools-issue-link" onClick={() => requestSettings("map")}>
        {t("tools.geocode.openSettings")}
      </button>
    </div>
  );
}

export function GazetteerSetup({ gaz }: { gaz: Gazetteer }) {
  const { t, i18n } = useTranslation();
  if (gaz.countries === null) return null;

  // Nothing loaded: say so and point at the one place that manages them. An
  // address register on its own counts as loaded: it answers houses, which is
  // most of what this tool is asked for.
  if (gaz.countries.length === 0 && !gaz.addressRegisters?.length) {
    return <GazetteerMissing note={t("tools.geocode.noGazetteer")} />;
  }

  return (
    <div className="tools-geo-gazetteer">
      <div className="tools-geo-summary">
        <span className="tools-geo-loaded" title={t("tools.geocode.loadedCountriesHint")}>{t("tools.geocode.loadedCountries")}</span>
        {gaz.countries.map((c) => (
          <span key={c.code} className="tools-geo-summary-entry" title={directoryTitle(c.code, i18n.language, t)}>
            <span className="tools-geo-country gm-data">{c.code}</span>
            <span className="tools-geo-count">{c.count.toLocaleString(i18n.language)}</span>
          </span>
        ))}
        {gaz.addressRegisters?.map((a) => (
          <span key={`addr-${a.country}`} className="tools-geo-summary-entry" title={t("tools.geocode.dir.dguAddresses")}>
            <span className="tools-geo-country gm-data">{`${a.country}-ADR`}</span>
            <span className="tools-geo-count">{a.count.toLocaleString(i18n.language)}</span>
          </span>
        ))}
        <button className="tools-issue-link" onClick={() => requestSettings("map")}>
          {t("tools.geocode.manageInSettings")}
        </button>
      </div>
    </div>
  );
}
