import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import type { NormalizeOptions } from "../../normalize/types";
import { downloadText } from "../download";
import { revealEdgeWhitespace } from "../whitespace";
import { type ToolsScans } from "../useToolsScans";
import { ToolsError, ToolsLoading } from "./shared";

export function NormalizePanel({ dataset, scans, fileName, active }: { dataset: Dataset; scans: ToolsScans; fileName: string; active: boolean }) {
  const { t } = useTranslation();
  // The preview report comes from the ToolsView-level worker scan cache.
  const state = scans.normalize;
  // Which passes the user wants applied on download; the preview report above
  // always reflects all three so the counts show what each would change.
  const [selected, setSelected] = useState<NormalizeOptions>({ dates: true, places: true, links: true, names: true });
  // True while the worker serializes the selected passes for download.
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    setSelected({ dates: true, places: true, links: true, names: true });
    setDownloading(false);
  }, [dataset]);

  // Run the preview in the tools worker the first time the tab is shown; the
  // result lives in the ToolsView-level cache, so revisits are instant.
  useEffect(() => {
    if (active) scans.ensure("normalize");
  }, [active, scans]);

  function download() {
    if (downloading) return;
    setDownloading(true);
    // The worker re-runs only the selected passes and serializes the result,
    // so just the finished text crosses back to the main thread.
    scans.runNormalizeText(
      selected,
      (text) => {
        setDownloading(false);
        const base = fileName.replace(/\.ged$/i, "");
        downloadText(`${base}.gedmerge.ged`, text);
      },
      () => setDownloading(false),
    );
  }

  if (state.status === "error") return <ToolsError message={state.message} />;
  if (state.status !== "done") return <ToolsLoading label={t("tools.normalize.running")} />;

  return (
    <>
      {state.status === "done" && (() => {
        const report = state.result;
        const changed = report.datesChanged + report.placesReshaped + report.linksConverted + report.nameVariantsReshaped + report.unknownNamesReshaped;
        if (changed === 0) return <p className="tools-clean tools-clean--ok">{t("tools.normalize.none")}</p>;
        const counts = {
          dates: report.datesChanged,
          places: report.placesReshaped,
          links: report.linksConverted,
          // The "names" pass also cleans unknown-name placeholders (NN, ____).
          names: report.nameVariantsReshaped + report.unknownNamesReshaped,
        };
        const toggle = (key: keyof NormalizeOptions) =>
          setSelected((s) => ({ ...s, [key]: !s[key] }));
        // Selected sum guards the download: only passes that are both checked
        // and actually change something count toward "anything to apply".
        const selectedChanges =
          (selected.dates ? counts.dates : 0) +
          (selected.places ? counts.places : 0) +
          (selected.links ? counts.links : 0) +
          (selected.names ? counts.names : 0);
        return (
          <>
            <p className="tools-intro">{t("tools.normalize.intro")}</p>
            <ul className="tools-norm-summary">
              <NormCheck label={t("tools.normalize.dates", { count: counts.dates })}
                checked={selected.dates} count={counts.dates} onChange={() => toggle("dates")} />
              <NormCheck label={t("tools.normalize.places", { count: counts.places })}
                checked={selected.places} count={counts.places} onChange={() => toggle("places")} />
              <NormCheck label={t("tools.normalize.links", { count: counts.links })}
                checked={selected.links} count={counts.links} onChange={() => toggle("links")} />
              <NormCheck label={t("tools.normalize.names", { count: counts.names })}
                checked={selected.names} count={counts.names} onChange={() => toggle("names")} />
            </ul>
            {selected.dates && <NormExamples title={t("tools.normalize.exDates")} examples={report.dateExamples} />}
            {selected.places && <NormExamples title={t("tools.normalize.exPlaces")} examples={report.placeExamples} />}
            {selected.links && <NormExamples title={t("tools.normalize.exLinks")} examples={report.linkExamples} />}
            {selected.names && <NormExamples title={t("tools.normalize.exNames")} examples={[...report.nameVariantExamples, ...report.unknownNameExamples]} />}
            <button className="nav-btn tools-run" onClick={download} disabled={selectedChanges === 0 || downloading}>
              {t("tools.normalize.download")}
            </button>
          </>
        );
      })()}
    </>
  );
}

/** One selectable normalization-count row: a checkbox in front of the count.
 *  Passes with nothing to change are disabled — there is nothing to opt into. */
function NormCheck({
  label,
  checked,
  count,
  onChange,
}: {
  label: string;
  checked: boolean;
  count: number;
  onChange: () => void;
}) {
  return (
    <li>
      <label className={`tools-norm-check ${count === 0 ? "disabled" : ""}`}>
        <input type="checkbox" checked={checked && count > 0} disabled={count === 0} onChange={onChange} />
        <span>{label}</span>
      </label>
    </li>
  );
}

function NormExamples({ title, examples }: { title: string; examples: { before: string; after: string }[] }) {
  if (!examples.length) return null;
  return (
    <div className="tools-examples">
      <div className="tools-examples-title">{title}</div>
      <ul>
        {examples.map((e, i) => (
          <li key={i}>
            <span className="tools-ex-from">{revealEdgeWhitespace(e.before)}</span>
            <span className="tools-pair-sep">→</span>
            <span className="tools-ex-to">{revealEdgeWhitespace(e.after)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
