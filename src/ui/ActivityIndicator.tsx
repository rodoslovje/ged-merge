import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { activitySnapshot, watchActivity, type ActivityKind } from "../state/activity";
import { geoImportSnapshot, importLabelKey, importProgress, isUncounted, watchGeoImport, type GeoRunning } from "./tools/geoImport";
import { useNow } from "./useNow";
import { countryNameOf } from "../geo/placeProposal";
import { DropdownMenu, type DropdownItem } from "./DropdownMenu";
import { requestSettings } from "./settingsBus";

/** How long the indicator stays after the last request settles. Paced lookups
 *  leave a gap between requests (FamilySearch waits 600 ms after each), and a
 *  spinner blinking off and on through a run reads as many separate jobs. */
const LINGER_MS = 1200;

const KINDS: ActivityKind[] = ["places", "addresses", "sources"];

/** Which download of a source it is, where the source has many: the region in
 *  a run of them, or the OpenStreetMap country (region) picked. */
function whichOne(run: GeoRunning, language: string): string | undefined {
  if (run.note) return run.note;
  if (run.job.kind !== "osm") return undefined;
  return run.job.region ?? countryNameOf(run.job.country, language) ?? run.job.country;
}

/** `done` of `total` as a whole percentage. */
const percent = (done: number, total: number) => Math.round((done / total) * 100);

/**
 * Beside Undo/Redo/Save: a spinner while anything is being downloaded in the
 * background — register and geocoder lookups, source pages, a directory being
 * imported — whichever view started it. Absent when nothing runs. Opening it
 * lists what is running; the import's entry leads to Settings › Map, where it
 * can be followed and cancelled.
 */
export function ActivityIndicator() {
  const { t, i18n } = useTranslation();
  const counts = useSyncExternalStore(watchActivity, activitySnapshot, activitySnapshot);
  const geo = useSyncExternalStore(watchGeoImport, geoImportSnapshot, geoImportSnapshot);
  const running = Object.values(geo.jobs).filter((j): j is GeoRunning => j.phase === "running");
  const busy = running.length > 0 || KINDS.some((k) => counts[k].active > 0);
  const now = useNow(running.some(isUncounted));

  const [shown, setShown] = useState(busy);
  useEffect(() => {
    if (busy) {
      setShown(true);
      return;
    }
    const timer = setTimeout(() => setShown(false), LINGER_MS);
    return () => clearTimeout(timer);
  }, [busy]);
  if (!shown) return null;

  const items: DropdownItem[] = [];
  // What runs, then how far it has got — the number set apart from the words,
  // so a list of several reads down its values at a glance.
  const entry = (text: string, value: string) => (
    <>
      {text} <span className="activity-value">{value}</span>
    </>
  );
  for (const run of running) {
    items.push({
      value: `import:${importLabelKey(run.job)}`,
      // The same reading as the download's own button in Settings › Map.
      label: entry([t(importLabelKey(run.job)), whichOne(run, i18n.language)].filter(Boolean).join(" — "), importProgress(run, now)),
    });
  }
  for (const kind of KINDS) {
    const { active, total } = counts[kind];
    if (active > 0)
      items.push({
        value: kind,
        label: entry(
          t(`activity.${kind}`),
          `${t("activity.remaining", { count: active })} · ${percent(total - active, total)} %`,
        ),
      });
  }
  const total = KINDS.reduce((n, k) => n + counts[k].active, running.length);

  return (
    <DropdownMenu
      groups={[{ label: t("activity.title"), items: items.length ? items : [{ value: "done", label: t("activity.done") }] }]}
      onSelect={(value) => {
        if (value.startsWith("import:")) requestSettings("map");
      }}
      className="nav-btn activity-btn"
      title={t("activity.tooltip")}
      ariaLabel={t("activity.tooltip")}
      trigger={
        <>
          <span className={busy ? "spinner activity-spinner" : "activity-spinner activity-spinner--idle"} aria-hidden="true" />
          {total > 0 && <span className="activity-count">{total}</span>}
        </>
      }
    />
  );
}
