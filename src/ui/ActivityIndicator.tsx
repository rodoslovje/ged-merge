import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { activitySnapshot, watchActivity, type ActivityKind } from "../state/activity";
import { geoImportSnapshot, watchGeoImport, type GeoRunning } from "./tools/geoImport";
import { DropdownMenu, type DropdownItem } from "./DropdownMenu";
import { requestSettings } from "./settingsBus";

/** How long the indicator stays after the last request settles. Paced lookups
 *  leave a gap between requests (FamilySearch waits 600 ms after each), and a
 *  spinner blinking off and on through a run reads as many separate jobs. */
const LINGER_MS = 1200;

const KINDS: ActivityKind[] = ["places", "addresses", "sources"];

/** The import's own name, by what it fetches. */
function importKey(job: GeoRunning["job"]): string {
  switch (job.kind) {
    case "gurs":
    case "dgu":
      return "activity.import.places";
    case "addresses":
      return "activity.import.addresses";
    case "osm":
      return "activity.import.osm";
    case "file":
      return "activity.import.file";
  }
}

/**
 * Beside Undo/Redo/Save: a spinner while anything is being downloaded in the
 * background — register and geocoder lookups, source pages, a directory being
 * imported — whichever view started it. Absent when nothing runs. Opening it
 * lists what is running; the import's entry leads to Settings › Map, where it
 * can be followed and cancelled.
 */
export function ActivityIndicator() {
  const { t } = useTranslation();
  const counts = useSyncExternalStore(watchActivity, activitySnapshot, activitySnapshot);
  const geo = useSyncExternalStore(watchGeoImport, geoImportSnapshot, geoImportSnapshot);
  const running = geo.state.phase === "running" ? geo.state : undefined;
  const busy = !!running || KINDS.some((k) => counts[k] > 0);

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
  if (running) {
    const known = running.total > 0;
    const pct = known ? ` ${Math.round((running.done / running.total) * 100)} %` : "";
    items.push({
      value: "import",
      label: `${t(importKey(running.job))}${running.note ? ` — ${running.note}` : ""}${pct}`,
    });
  }
  for (const kind of KINDS) {
    if (counts[kind] > 0) items.push({ value: kind, label: t(`activity.${kind}`, { count: counts[kind] }) });
  }
  const total = KINDS.reduce((n, k) => n + counts[k], running ? 1 : 0);

  return (
    <DropdownMenu
      groups={[{ label: t("activity.title"), items: items.length ? items : [{ value: "done", label: t("activity.done") }] }]}
      onSelect={(value) => {
        if (value === "import") requestSettings("map");
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
