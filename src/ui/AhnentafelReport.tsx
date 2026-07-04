import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { buildAhnentafel, generationLabel, type AhnEntry, type AhnentafelData } from "../report/ahnentafel";
import { ahnentafelToText, factText } from "../report/text";
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

// Full-page Ahnentafel report: the root person's ancestors as the classic
// numbered list (root = 1, father = 2n, mother = 2n + 1) grouped by
// generation — the Charts hub's first text report. Entries are compact glyph
// fact lines (* born, ~ baptized, ⚭ married, † died, ▭ buried), the same
// vocabulary the Timeline draws; clicking an entry opens the shared detail
// panel, from which the report can be re-rooted. Exports: plain text download
// and the print dialog (Save as PDF).

// Same swatch convention as the Timeline: the root keeps the full-strength
// accent, ancestors fade toward the panel.
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
}

export function AhnentafelReport({ masterDs, rootId, backLabel, onBack, onNavigate, kindSwitcher, onRootChange }: Props) {
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

  const data = useMemo(
    () => buildAhnentafel(masterDs, currentRootId, nameOf),
    [masterDs, currentRootId, nameOf],
  );

  // Redact people inferred to be living: keep their number and name (the
  // pedigree structure), drop the dates, places and fact lines.
  const privacy = settings.privacyLiving;
  const redacted = useCallback((e: AhnEntry) => privacy && e.living, [privacy]);

  // Esc / Backspace leave; the kind digits are registered by the Charts hub.
  useChartShortcuts({ onLeave: onBack });

  const rootEntry = data?.generations[0]?.entries[0];
  const pageKind = t("ahnentafel.pageTitle");
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
              title: t("ahnentafel.exportTxt.tooltip"),
              onSelect: () =>
                data &&
                downloadText(
                  `${diagramSlug(rootEntry?.name, pageKind)}.txt`,
                  ahnentafelToText(t, data, exportTitle, { privacyLiving: privacy }),
                ),
            },
            {
              key: "pdf",
              icon: <FileTextIcon />,
              label: t("export.pdf"),
              title: t("tree.exportPdf.tooltip"),
              onSelect: () => data && printDocument(printDoc(t, data, exportTitle, diagramSlug(rootEntry?.name, pageKind), privacy)),
            },
          ]}
        />
      </div>

      <div className="tree-controls">
        <div className="tree-controls-left">{kindSwitcher}</div>
      </div>

      <div className="tree-canvas-wrap">
        <div className="report-scroll">
          {data ? (
            <div className="report-page">
              {data.generations.map((g) => (
                <section key={g.gen}>
                  <h3 className="report-gen-head">{generationLabel(t, g.gen)}</h3>
                  {g.entries.map((e) => (
                    <div
                      key={e.num}
                      className={`report-entry${e.id === selectedId ? " selected" : ""}`}
                      onClick={() => setSelectedId(e.id)}
                      title={t("tree.node.clickHint")}
                    >
                      <span className="report-num gm-data">{e.num}.</span>
                      <div className="report-entry-body">
                        <div>
                          <span className={`report-name ${sexClass(e.sex)}`}>{e.name}</span>
                          {!redacted(e) && e.years && <span className="report-years gm-data">{e.years}</span>}
                          {e.dupOf !== undefined && (
                            <span className="report-dup">→ {t("ahnentafel.dup", { n: e.dupOf })}</span>
                          )}
                        </div>
                        {!redacted(e) &&
                          e.facts.map((f, i) => (
                            <div key={i} className="report-fact gm-data">
                              {factText(f)}
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
                </section>
              ))}
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
function printDoc(t: Translate, data: AhnentafelData, title: string, fileName: string, privacy: boolean): string {
  const parts: string[] = [`<h1>${escapeHtml(title)}</h1>`];
  for (const g of data.generations) {
    parts.push(`<h2>${escapeHtml(generationLabel(t, g.gen))}</h2>`);
    for (const e of g.entries) {
      const hidden = privacy && e.living;
      const head =
        `<span class="num">${e.num}.</span> <strong>${escapeHtml(e.name)}</strong>` +
        (!hidden && e.years ? ` <span class="years">${escapeHtml(e.years)}</span>` : "") +
        (e.dupOf !== undefined ? ` <span class="dup">→ ${escapeHtml(t("ahnentafel.dup", { n: e.dupOf }))}</span>` : "");
      const facts = hidden ? [] : e.facts.map((f) => `<div class="fact">${escapeHtml(factText(f))}</div>`);
      parts.push(`<div class="entry">${head}${facts.join("")}</div>`);
    }
  }
  // Browsers seed the "Save as PDF" filename from the document <title>.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(`${fileName}.gedmerge`)}</title>
<style>
  @page { margin: 18mm; }
  body { font: 11pt/1.45 Georgia, "Times New Roman", serif; color: #000; margin: 0; }
  h1 { font-size: 15pt; margin: 0 0 12pt; }
  h2 { font-size: 12pt; margin: 14pt 0 6pt; border-bottom: 1pt solid #999; padding-bottom: 2pt; }
  .entry { margin: 0 0 7pt; page-break-inside: avoid; }
  .num { display: inline-block; min-width: 2.2em; }
  .years, .dup { color: #444; }
  .fact { margin-left: 2.6em; color: #222; }
</style></head><body>${parts.join("")}</body></html>`;
}
