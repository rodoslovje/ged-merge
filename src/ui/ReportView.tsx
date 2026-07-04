import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { TreeMode } from "../tree/compareTree";
import { buildAhnentafel } from "../report/ahnentafel";
import { buildDescendants } from "../report/descendants";
import { generationHeading, type ReportData, type ReportEntry } from "../report/model";
import { childrenOfLabel, entryNum, factText, reportToText } from "../report/text";
import type { Placed } from "../tree/treeLayout";
import type { Translate } from "../locales/i18n";
import { individualFieldRows } from "../review/fields";
import { BackButton } from "./BackButton";
import { sexClass } from "./sex";
import { TreeNodePanel } from "./TreeNodePanel";
import { diagramSlug, escapeHtml, printDocument } from "./exportSvg";
import { downloadText } from "./download";
import { ExportMenu } from "./ExportMenu";
import { FileTextIcon } from "./icons/FormatIcons";
import { ChartSettings } from "./ChartSettings";
import { useChartSettings } from "./ChartSettingsContext";
import { useNameOf } from "./SettingsContext";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";

// Full-page text report — the Charts hub's "Report" kind, with the shared
// Ancestors/Descendants toggle choosing between:
//  - the Ahnentafel: ancestors in classic numbering (root = 1, father = 2n,
//    mother = 2n + 1), grouped by generation;
//  - the descendant register: sequential (NGSQ-style) numbers in order of
//    appearance, each generation's children grouped under "Children of no. X".
// Entries are compact glyph fact lines (* born, ~ baptized, ⚭ married,
// † died, ▭ buried), the same vocabulary the Timeline draws; clicking an
// entry opens the shared detail panel, from which the report can be
// re-rooted. Exports: plain text download and the print dialog (Save as PDF).

// Same swatch convention as the Timeline: the root keeps the full-strength
// accent, everyone else fades toward the panel.
const COLOR_PERSON = "var(--accent)";
const COLOR_FAMILY = "color-mix(in srgb, var(--node-master) 45%, var(--panel))";

interface Props {
  masterDs: Dataset;
  rootId: string;
  /** Translated label for where Back lands (App knows the hub's origin). */
  backLabel: string;
  onBack: () => void;
  /** Jump to a person in Edit mode (closes the hub). */
  onNavigate?: (id: string) => void;
  /** The Charts-hub kind switcher, rendered in the controls row. */
  kindSwitcher?: React.ReactNode;
  /** Reports re-roots up to the Charts hub, so switching kinds stays on the
   *  person the user is looking at. */
  onRootChange?: (id: string) => void;
  /** The hub-owned ancestors/descendants choice, shared with the pedigree
   *  charts so the direction survives kind switches. */
  mode: TreeMode;
  onModeChange: (mode: TreeMode) => void;
}

export function ReportView({ masterDs, rootId, backLabel, onBack, onNavigate, kindSwitcher, onRootChange, mode, onModeChange }: Props) {
  const { t } = useTranslation();
  const nameOf = useNameOf();
  const { settings } = useChartSettings();
  const [currentRootId, setCurrentRootId] = useState(rootId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const changeRoot = useCallback((id: string) => {
    setCurrentRootId(id);
    setSelectedId(null);
    onRootChange?.(id);
  }, [onRootChange]);

  // Both directions build (they also feed the toggle's count badges); the
  // toggle picks which one the page shows.
  const factOpts = useMemo(
    () => ({
      occupation: settings.showOccupation,
      education: settings.showEducation,
      residence: settings.showResidence,
      notes: settings.showNotes,
      sources: settings.showSources,
    }),
    [settings.showOccupation, settings.showEducation, settings.showResidence, settings.showNotes, settings.showSources],
  );
  const ancestors = useMemo(
    () => buildAhnentafel(masterDs, currentRootId, nameOf, undefined, factOpts),
    [masterDs, currentRootId, nameOf, factOpts],
  );
  const descendants = useMemo(
    () => buildDescendants(masterDs, currentRootId, nameOf, undefined, factOpts),
    [masterDs, currentRootId, nameOf, factOpts],
  );
  const data = mode === "descendants" ? descendants : ancestors;

  // Redact people inferred to be living: keep their number and name (the
  // family structure), drop the dates, places and fact lines.
  const privacy = settings.privacyLiving;
  const redacted = useCallback((e: ReportEntry) => privacy && e.living, [privacy]);

  // Esc / Backspace leave, A/D switch direction; kind digits are the hub's.
  useChartShortcuts({ onMode: onModeChange, onLeave: onBack });

  const rootEntry = data?.generations[0]?.entries[0];
  const pageKind = t(mode === "descendants" ? "register.pageTitle" : "ahnentafel.pageTitle");
  const exportTitle = [rootEntry?.name, rootEntry && !redacted(rootEntry) ? rootEntry.years : undefined, "—", pageKind]
    .filter(Boolean)
    .join(" ");

  const selectedEntry = useMemo(
    () => data?.generations.flatMap((g) => g.entries).find((e) => e.id === selectedId),
    [data, selectedId],
  );
  const selectedIndi = selectedEntry ? masterDs.individuals.get(selectedEntry.id) : undefined;
  const selectedRows = useMemo(
    () => (selectedIndi ? individualFieldRows(t, selectedIndi, undefined, masterDs) : []),
    [t, selectedIndi, masterDs],
  );
  const masterNav = useMemo(
    () => ({
      linkable: (id: string) => masterDs.individuals.has(id),
      onNavigate: changeRoot,
    }),
    [masterDs, changeRoot],
  );

  // Cross-reference jump: scroll a numbered entry into view and flash it.
  const jumpTo = useCallback((num: number) => {
    const el = document.getElementById(`report-entry-${num}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Restart the flash animation on repeated jumps to the same entry.
    el.classList.remove("report-flash");
    void el.offsetWidth;
    el.classList.add("report-flash");
  }, []);

  return (
    <div className="tree-page">
      <div className="tree-toolbar">
        <BackButton label={backLabel} shortcutHint="Esc" onClick={onBack} />
        <h2 className="tree-title">
          {rootEntry ? (
            <>
              <span className={`tree-title-name ${sexClass(rootEntry.sex)}`}>{rootEntry.name}</span>
              {!redacted(rootEntry) && rootEntry.years && <span className="tree-title-years gm-data">{rootEntry.years}</span>}
              <span className="tree-title-break" aria-hidden="true" />
              <span className="tree-title-kind">{pageKind}</span>
            </>
          ) : (
            pageKind
          )}
        </h2>
        <ChartSettings lockedType="report" />
        <ExportMenu
          disabled={!data}
          items={[
            {
              key: "txt",
              icon: <FileTextIcon />,
              label: t("export.txt"),
              title: t("report.exportTxt.tooltip"),
              onSelect: () =>
                data &&
                downloadText(
                  `${diagramSlug(rootEntry?.name, pageKind)}.txt`,
                  reportToText(t, data, mode, exportTitle, { privacyLiving: privacy }),
                ),
            },
            {
              key: "pdf",
              icon: <FileTextIcon />,
              label: t("export.pdf"),
              title: t("tree.exportPdf.tooltip"),
              onSelect: () =>
                data && printDocument(printDoc(t, data, mode, exportTitle, diagramSlug(rootEntry?.name, pageKind), privacy)),
            },
          ]}
        />
      </div>

      <div className="tree-controls">
        <div className="tree-controls-left">
          {kindSwitcher}
          <div className="tree-mode">
            <button className={mode === "ancestors" ? "active" : ""} onClick={() => onModeChange("ancestors")}>
              {t("tree.ancestors")}
              {ancestors && <span className="tree-mode-count">{ancestors.total}</span>}
            </button>
            <button className={mode === "descendants" ? "active" : ""} onClick={() => onModeChange("descendants")}>
              {t("tree.descendants")}
              {descendants && <span className="tree-mode-count">{descendants.total}</span>}
            </button>
          </div>
        </div>
      </div>

      <div className="tree-canvas-wrap">
        <div className="report-scroll">
          {data ? (
            <div className="report-page">
              {data.generations.map((g) => {
                const heading = generationHeading(t, g, mode);
                return (
                <section key={g.gen}>
                  <h3 className="report-gen-head">
                    <span>{heading.title}</span>
                    {heading.range && <span className="report-gen-range gm-data">{heading.range}</span>}
                    {heading.coverage && <span className="report-gen-range gm-data">· {heading.coverage}</span>}
                  </h3>
                  {g.entries.map((e, i) => (
                    <div key={`${e.num}-${i}`}>
                      {/* Register generations group children per union, both
                          parents named; the heading jumps back to the
                          descendant parent's entry. */}
                      {e.parentNum !== undefined && e.parentFam !== g.entries[i - 1]?.parentFam && (
                        <h4 className="report-family-head">
                          <button className="report-jump" onClick={() => jumpTo(e.parentNum!)}>
                            {childrenOfLabel(t, e)}
                          </button>
                        </h4>
                      )}
                      <div
                        id={e.dupOf === undefined ? `report-entry-${e.num}` : undefined}
                        className={`report-entry${e.id === selectedId ? " selected" : ""}`}
                        onClick={() => setSelectedId(e.id)}
                        title={t("tree.node.clickHint")}
                      >
                        <span className={`report-num gm-data${e.childIndex !== undefined ? " with-roman" : ""}`}>
                          {entryNum(e)}
                        </span>
                        <div className="report-entry-body">
                          <div>
                            <span className={`report-name ${sexClass(e.sex)}`}>{e.name}</span>
                            {!redacted(e) && e.years && <span className="report-years gm-data">{e.years}</span>}
                            {e.dupOf !== undefined && (
                              <button
                                className="report-dup report-jump"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  jumpTo(e.dupOf!);
                                }}
                              >
                                → {t("ahnentafel.dup", { n: e.dupOf })}
                              </button>
                            )}
                          </div>
                          {!redacted(e) &&
                            (e.notes ?? []).map((note, j) => (
                              <div key={`n${j}`} className="report-note">
                                {note}
                              </div>
                            ))}
                          {!redacted(e) &&
                            (e.sources ?? []).map((src, j) => (
                              <div key={`s${j}`} className="report-source gm-data">
                                {src}
                              </div>
                            ))}
                          {!redacted(e) &&
                            e.facts.map((f, j) => (
                              <div key={j} className="report-fact gm-data">
                                {factText(f)}
                                {f.note && <div className="report-note">{f.note}</div>}
                                {(f.sources ?? []).map((src, k) => (
                                  <div key={k} className="report-source">
                                    {src}
                                  </div>
                                ))}
                              </div>
                            ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </section>
                );
              })}
            </div>
          ) : (
            <p className="muted">{t("ahnentafel.empty")}</p>
          )}
        </div>

        {selectedEntry && selectedIndi && (
          <TreeNodePanel
            node={selectedEntry as unknown as Placed}
            swatch={selectedEntry.num === 1 ? COLOR_PERSON : COLOR_FAMILY}
            rows={selectedRows}
            masterPerson={masterNav}
            masterLabel={t("tree.master")}
            singleColumn
            onClose={() => setSelectedId(null)}
            onSetRoot={() => changeRoot(selectedEntry.id)}
            extraActions={
              onNavigate ? (
                <button className="nav-btn tree-compare-root" onClick={() => onNavigate(selectedEntry.id)}>
                  {t("relpath.openInEdit")}
                </button>
              ) : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

/** The standalone print document ("Save as PDF"): the same content as the
 *  page, in a self-contained light-palette sheet (no app CSS to resolve). */
function printDoc(
  t: Translate,
  data: ReportData,
  direction: TreeMode,
  title: string,
  fileName: string,
  privacy: boolean,
): string {
  const parts: string[] = [`<h1>${escapeHtml(title)}</h1>`];
  for (const g of data.generations) {
    const h = generationHeading(t, g, direction);
    const meta = [h.range, h.coverage].filter(Boolean).map((s) => `· ${escapeHtml(s!)}`).join(" ");
    parts.push(`<h2>${escapeHtml(h.title)}${meta ? ` <span class="range">${meta}</span>` : ""}</h2>`);
    let lastFam: string | undefined;
    for (const e of g.entries) {
      if (e.parentNum !== undefined && e.parentFam !== lastFam) {
        parts.push(`<h3>${escapeHtml(childrenOfLabel(t, e))}</h3>`);
        lastFam = e.parentFam;
      }
      const hidden = privacy && e.living;
      const head =
        `<span class="num">${escapeHtml(entryNum(e))}</span> <strong>${escapeHtml(e.name)}</strong>` +
        (!hidden && e.years ? ` <span class="years">${escapeHtml(e.years)}</span>` : "") +
        (e.dupOf !== undefined ? ` <span class="dup">→ ${escapeHtml(t("ahnentafel.dup", { n: e.dupOf }))}</span>` : "");
      const notes = hidden
        ? []
        : [
            ...(e.notes ?? []).map((n) => `<div class="note">${escapeHtml(n)}</div>`),
            ...(e.sources ?? []).map((s) => `<div class="source">${escapeHtml(s)}</div>`),
          ];
      const facts = hidden
        ? []
        : e.facts.map(
            (f) =>
              `<div class="fact">${escapeHtml(factText(f))}` +
              (f.note ? `<div class="note">${escapeHtml(f.note)}</div>` : "") +
              (f.sources ?? []).map((s) => `<div class="source">${escapeHtml(s)}</div>`).join("") +
              `</div>`,
          );
      parts.push(`<div class="entry">${head}${notes.join("")}${facts.join("")}</div>`);
    }
  }
  // Browsers seed the "Save as PDF" filename from the document <title>.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(`${fileName}.gedmerge`)}</title>
<style>
  @page { margin: 18mm; }
  body { font: 11pt/1.45 Georgia, "Times New Roman", serif; color: #000; margin: 0; }
  h1 { font-size: 15pt; margin: 0 0 12pt; }
  h2 { font-size: 12pt; margin: 14pt 0 6pt; border-bottom: 1.5pt solid #666; padding-bottom: 2pt; text-transform: uppercase; letter-spacing: 0.04em; }
  h2 .range { font-weight: 400; text-transform: none; letter-spacing: 0; color: #444; font-size: 10pt; }
  h3 { font-size: 11pt; margin: 10pt 0 4pt; font-style: italic; font-weight: 500; }
  .entry { margin: 0 0 7pt; page-break-inside: avoid; }
  .num { display: inline-block; min-width: 3em; text-align: right; }
  .years, .dup { color: #444; }
  .fact { margin-left: 2.6em; color: #222; }
  .note { font-style: italic; color: #444; white-space: pre-wrap; }
  .source { color: #555; font-size: 10pt; }
  .entry > .note, .entry > .source { margin-left: 2.6em; }
  .fact > .note, .fact > .source { margin-left: 1.2em; }
</style></head><body>${parts.join("")}</body></html>`;
}
