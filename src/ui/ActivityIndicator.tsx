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

/** `done` of `total` as a whole percentage. */
const percent = (done: number, total: number) => Math.round((done / total) * 100);

/** The import's own name, by what it fetches and from whom — the register is
 *  named, so a GURS run reads differently from a DGU one. */
function importKey(job: GeoRunning["job"]): string {
  switch (job.kind) {
    case "gurs":
      return "activity.import.gurs";
    case "dgu":
      return "activity.import.dgu";
    case "addresses":
      return job.country === "SI" ? "activity.import.gursAddresses" : "activity.import.dguAddresses";
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
  const busy = !!running || KINDS.some((k) => counts[k].active > 0);

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
    // A download whose length the server never announced still shows how
    // much has arrived — the same reading as the import's own bar.
    const pct =
      running.total > 0
        ? ` ${percent(running.done, running.total)} %`
        : running.done > 0
          ? ` ${(running.done / 1048576).toFixed(1)} MB`
          : "";
    items.push({
      value: "import",
      label: `${t(importKey(running.job))}${running.note ? ` — ${running.note}` : ""}${pct}`,
    });
  }
  for (const kind of KINDS) {
    const { active, total } = counts[kind];
    if (active > 0)
      items.push({
        value: kind,
        label: t(`activity.${kind}`, { count: active, percent: percent(total - active, total) }),
      });
  }
  const total = KINDS.reduce((n, k) => n + counts[k].active, running ? 1 : 0);

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
