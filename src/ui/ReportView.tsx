import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Sex } from "../gedcom/types";
import type { TreeMode } from "../chart/personTree";
import type { ChartDirection } from "../chart/treeLayout";
import { Segmented, type SegmentedItem } from "./Segmented";
import { lifespanLine, livingLabelFor } from "../chart/nodeDisplay";
import { createKinshipResolver } from "../match/kinship";
import { linkHref } from "./FieldValue";
import { buildAhnentafel } from "../report/ahnentafel";
import { buildDescendants } from "../report/descendants";
import {
  generationHeading,
  romanIndex,
  sourceLabel,
  tocRows,
  truncationNote,
  type PersonRef,
  type ReportData,
  type ReportEntry,
  type SourceLine,
} from "../report/model";
import { childrenOfLabel, factText, reportName, reportToText, type ReportTextOptions } from "../report/text";
import { reportsToRtf } from "../report/rtf";
import { childGroups, planEntry } from "../report/narrative";
import { citationMark, narrativeEntry, narrativeLangFor } from "../report/narrativeText";
import type { Translate } from "../locales/i18n";
import { individualFieldRows } from "../review/fields";
import { ChartPage } from "./ChartPage";
import { ChartFindBox } from "./ChartFindBox";
import { useChartFind } from "./useChartFind";
import type { FindSource } from "./chartFind";
import { sexClass } from "./sex";
import { TreeNodePanel } from "./TreeNodePanel";
import { chartSlug, escapeHtml, printDocument } from "./exportSvg";
import { downloadText } from "./download";
import { ChartExportMenu } from "./ChartExportMenu";
import { FileTextIcon, PrinterIcon } from "./icons/FormatIcons";
import { ChartSettings } from "./ChartSettings";
import { useChartSettings } from "./ChartSettingsContext";
import { useStableHandler } from "./edit/useStableHandler";
import { useNameOf, useSettingsSlice } from "./SettingsContext";
import { ChartRootTitle } from "./ChartRootTitle";
import { lifespanAge } from "../gedcom/age";
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
// re-rooted. Exports: plain text and RTF downloads and the print dialog
// (Save as PDF).

// Same swatch convention as the Timeline: the root keeps the full-strength
// accent, everyone else fades toward the panel.
/** The preferences this file reads — subscribed field by field, so an
 *  unrelated one changing leaves it alone (see useSettingsSlice). */
const SETTINGS_KEYS = ["showKinship"] as const;

const COLOR_PERSON = "var(--accent)";
const COLOR_FAMILY = "color-mix(in srgb, var(--node-main) 45%, var(--panel))";

// Reports never append the married surname ("Silvija Sekušak (Renko)") — the
// entries' ⚭ lines / narrative marriage sentences already state the union.
// Module-level constant so the nameOf identity stays stable across renders.
const REPORT_NAME_DISPLAY = { marriedSurname: false } as const;

interface Props {
  mainDs: Dataset;
  rootId: string;
  /** The app-wide start person, for the header's kinship-to-start chip. */
  startId?: string;
  /** Main ids with unsaved edits — those entries show the "M" chip. */
  /** Translated label for where Back lands (App knows the hub's origin). */
  backLabel: string;
  onBack: () => void;
  /** Jump to a person in Edit mode (closes the hub). */
  onNavigate?: (id: string) => void;
  /** The Charts-hub kind switcher, rendered in the controls row. */
  kindSwitcher?: React.ReactNode;
  /** Re-root on another person. The hub owns the root (and records it in browser
   *  history), so a re-root here comes back down as a new `rootId`. */
  onRootChange: (id: string) => void;
  /** The hub-owned ancestors/descendants choice, shared with the pedigree
   *  charts so the direction survives kind switches. */
  mode: ChartDirection;
  onModeChange: (mode: ChartDirection) => void;
}

/** One report of the page: its direction, data (after the generation limit),
 *  page title and rendering options — the bowtie shows two. */
interface ReportPart {
  dir: TreeMode;
  data: ReportData | undefined;
  kind: string;
  opts: ReportTextOptions;
}

export function ReportView({ mainDs, rootId: currentRootId, startId, backLabel, onBack, onNavigate, kindSwitcher, onRootChange, mode, onModeChange }: Props) {
  const { t, i18n } = useTranslation();
  const nameOf = useNameOf(REPORT_NAME_DISPLAY);
  const appSettings = useSettingsSlice(SETTINGS_KEYS);
  const { settings, set } = useChartSettings();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Identity-stable, so the memoized paragraph handlers don't rebuild every
  // render just because App passes a fresh callback.
  const changeRoot = useStableHandler((id: string) => {
    setSelectedId(null);
    onRootChange(id);
  });

  // Both directions build (they also feed the toggle's count badges); the
  // toggle picks which one the page shows.
  const factOpts = useMemo(
    () => ({
      occupation: settings.showOccupation,
      education: settings.showEducation,
      residence: settings.showResidence,
      notes: settings.showNotes,
      sources: settings.showSources,
      age: settings.showAge,
    }),
    [settings.showOccupation, settings.showEducation, settings.showResidence, settings.showNotes, settings.showSources, settings.showAge],
  );
  const ancestors = useMemo(
    () => buildAhnentafel(mainDs, currentRootId, nameOf, undefined, factOpts),
    [mainDs, currentRootId, nameOf, factOpts],
  );
  const descendants = useMemo(
    () => buildDescendants(mainDs, currentRootId, nameOf, undefined, factOpts),
    [mainDs, currentRootId, nameOf, factOpts],
  );
  // "Both" prints the Ahnentafel and the descendant register one after the
  // other; each is the page it would be on its own.
  const dirs = useMemo<TreeMode[]>(() => (mode === "both" ? ["ancestors", "descendants"] : [mode]), [mode]);
  // Generations the direction(s) have to offer (the root is generation 0) —
  // the deeper one for both.
  const availableGenerations = Math.max(
    0,
    ...dirs.map((d) => ((d === "descendants" ? descendants : ancestors)?.generations.length ?? 1) - 1),
  );
  // The generation limit trims a report's tail. The kept generations — their
  // entries and their numbering — are exactly the full report's, so slicing the
  // built data is the whole job; `truncated` records what was left off so the
  // page and every export can say so.
  const sliced = useMemo(() => {
    const max = settings.maxGenerations;
    const cut = (full: ReportData | undefined): ReportData | undefined => {
      if (!full || max === null || max >= full.generations.length - 1) return full;
      const generations = full.generations.slice(0, max + 1);
      return {
        ...full,
        generations,
        total: generations.reduce((n, g) => n + g.entries.filter((e) => e.dupOf === undefined).length, 0),
        truncated: full.generations.length - 1 - max,
      };
    };
    return { ancestors: cut(ancestors), descendants: cut(descendants) };
  }, [ancestors, descendants, settings.maxGenerations]);

  // Redact people inferred to be living: keep their number (the family
  // structure), replace the name with their kinship to the root — or the
  // "Living" placeholder — and drop the dates, places and fact lines, the
  // same convention as the chart nodes.
  const privacy = settings.privacyLiving;
  const redacted = useCallback((e: ReportEntry) => privacy && e.living, [privacy]);
  const kinship = useMemo(() => createKinshipResolver(mainDs, currentRootId, t), [mainDs, currentRootId, t]);
  const livingNameOf = useCallback(
    (p: { id: string; sex: Sex }) => kinship.label(p.id) || livingLabelFor(t, p.sex),
    [kinship, t],
  );
  // Table of contents up top: one row per generation, linked to its section
  // in every rendering (page scroll, text lines, RTF bookmarks, print anchors).
  const toc = settings.reportToc;

  // Narrative style: each entry's facts phrased as prose in the UI language
  // (with citation markers, woven-in notes and the numbered citation list).
  // Shared by the page, the text download and the print sheet — built per
  // report, since the child groups it reads are that report's own.
  const narrativeFor = useCallback(
    (data: ReportData | undefined) => {
      if (!settings.reportNarrative || !data) return undefined;
      const lang = narrativeLangFor(i18n.language);
      const groups = childGroups(data);
      // Privacy reaches the planner: it decides whether a living partner's
      // years and a living parent's name enter the sentences at all.
      return (e: ReportEntry) => narrativeEntry(t, lang, e, planEntry(e, groups.get(e.num), { privacyLiving: privacy }));
    },
    [settings.reportNarrative, t, i18n.language, privacy],
  );
  // One options object per report for all its renderings (page names, txt,
  // RTF, print).
  const parts = useMemo<ReportPart[]>(
    () =>
      dirs.map((dir) => {
        const data = sliced[dir];
        return {
          dir,
          data,
          kind: t(dir === "descendants" ? "register.pageTitle" : "ahnentafel.pageTitle"),
          opts: { privacyLiving: privacy, livingNameOf, narrativeOf: narrativeFor(data), toc },
        };
      }),
    [dirs, sliced, t, privacy, livingNameOf, narrativeFor, toc],
  );
  // The first report: the root entry and the header read from it, and its
  // options serve the names the page writes outside any one report.
  const data = parts[0].data;
  const exportOpts = parts[0].opts;

  // The direction row: each report's head-count, both the two together (the
  // root counted once).
  const directions: SegmentedItem<ChartDirection>[] = [
    { key: "ancestors", label: <>{t("tree.ancestors")}{ancestors && <span className="tree-mode-count">{ancestors.total}</span>}</> },
    { key: "descendants", label: <>{t("tree.descendants")}{descendants && <span className="tree-mode-count">{descendants.total}</span>}</> },
    {
      key: "both",
      label: <>{t("tree.both")}{ancestors && descendants && <span className="tree-mode-count">{ancestors.total + descendants.total - 1}</span>}</>,
      title: t("tree.both.tooltip"),
    },
  ];

  // Esc / Backspace leave, A/D switch direction; kind digits are the hub's.
  useChartShortcuts({ onMode: onModeChange, onLeave: onBack });

  const rootEntry = data?.generations[0]?.entries[0];
  // The report's people, for the branch-GEDCOM export (dups appear once).
  const reportIds = useMemo(
    () => [...new Set(parts.flatMap((p) => (p.data?.generations ?? []).flatMap((g) => g.entries.map((e) => e.id))))],
    [parts],
  );
  const pageKind = mode === "both" ? parts.map((p) => p.kind).join(" · ") : parts[0].kind;
  // Header lifespan with the age folded in when the Age display toggle is on —
  // the same lifespanLine convention as the pedigree charts and the timeline.
  const rootYears =
    rootEntry && !redacted(rootEntry)
      ? lifespanLine(
          { showLifespan: true, showAge: settings.showAge },
          { years: rootEntry.years, age: lifespanAge(mainDs.individuals.get(currentRootId)) },
        )
      : undefined;
  // Kinship-to-start chip, matching the other chart headers. The body's
  // `kinship` resolver is rooted at the report root; this one is to the start.
  const showStartKinship = settings.showKinship && appSettings.showKinship && !!startId;
  const startKinship = useMemo(
    () => (startId ? createKinshipResolver(mainDs, startId, t) : undefined),
    [mainDs, startId, t],
  );
  // The title of one report's export: the root, then that report's kind.
  const titleFor = (kind: string) => [rootEntry && reportName(rootEntry, exportOpts), rootYears, "—", kind].filter(Boolean).join(" ");
  // The reports with something to export, each with its own title.
  const exportParts = parts.filter((p): p is ReportPart & { data: ReportData } => !!p.data);

  const selectedEntry = useMemo(
    () => parts.flatMap((p) => p.data?.generations.flatMap((g) => g.entries) ?? []).find((e) => e.id === selectedId),
    [parts, selectedId],
  );
  const selectedIndi = selectedEntry ? mainDs.individuals.get(selectedEntry.id) : undefined;
  const selectedRows = useMemo(
    () => (selectedIndi ? individualFieldRows(t, selectedIndi, undefined, mainDs) : []),
    [t, selectedIndi, mainDs],
  );
  const mainNav = useMemo(
    () => ({
      linkable: (id: string) => mainDs.individuals.has(id),
      onNavigate: changeRoot,
    }),
    [mainDs, changeRoot],
  );

  // The "Children of …" heading with the parents rendered like any other
  // name: sex-coloured, lifespan after, privacy-redacted years. The localized
  // template is split around its placeholders so the words stay translated.
  const familyHeading = useCallback(
    (e: ReportEntry) => {
      const template = t(e.parentSpouse ? "register.childrenOfBoth" : "register.childrenOf", {
        name: "\u0001",
        spouse: "\u0002",
        interpolation: { escapeValue: false },
      });
      const ref = (r: PersonRef, k: number) => (
        <span key={k}>
          <span className={`report-name ${sexClass(r.sex)}`}>{reportName(r, exportOpts)}</span>
          {!(privacy && r.living) && r.years && <span className="report-years gm-data">{r.years}</span>}
        </span>
      );
      return template
        .split(/([\u0001\u0002])/)
        .map((part, k) =>
          part === "\u0001" && e.parent ? ref(e.parent, k) : part === "\u0002" && e.parentSpouse ? ref(e.parentSpouse, k) : part,
        );
    },
    [t, privacy, exportOpts],
  );

  // Cross-reference jump: scroll a numbered entry into view and flash it. Also
  // the find box's reveal — its keys are entry numbers.
  const jumpTo = useCallback((dir: TreeMode, num: number) => {
    const el = document.getElementById(`report-entry-${dir}-${num}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Restart the flash animation on repeated jumps to the same entry.
    el.classList.remove("report-flash");
    void el.offsetWidth;
    el.classList.add("report-flash");
  }, []);

  // Find-in-report, on the charts' find machinery: one position per numbered
  // entry, in reading order. Repeat entries (`dupOf`) are skipped — they carry
  // no anchor of their own and point at the entry that does. A name nowhere in
  // this report offers to re-root on that person, exactly as the charts do.
  const findSources = useMemo<FindSource[]>(
    () =>
      parts.flatMap((p) =>
        (p.data?.generations ?? [])
          .flatMap((g) => g.entries)
          .filter((e) => e.dupOf === undefined)
          .map((e) => ({ key: `${p.dir}:${e.num}`, people: [mainDs.individuals.get(e.id)] })),
      ),
    [parts, mainDs],
  );
  const revealEntry = useCallback(
    (key: string) => {
      const [dir, num] = key.split(":");
      jumpTo(dir as TreeMode, Number(num));
    },
    [jumpTo],
  );
  const find = useChartFind(findSources, mainDs.individuals, revealEntry, changeRoot);

  return (
    <ChartPage
      backLabel={backLabel}
      onBack={onBack}
      title={
        rootEntry ? (
          <ChartRootTitle
            name={reportName(rootEntry, exportOpts)}
            sexCls={sexClass(rootEntry.sex)}
            years={rootYears}
            kinship={showStartKinship ? startKinship?.label(currentRootId) : undefined}
            lineage={startKinship?.lineage(currentRootId)}
            kind={pageKind}
          />
        ) : (
          pageKind
        )
      }
      actions={
        <>
          <ChartSettings lockedType="report" availableGenerations={availableGenerations} />
          <ChartExportMenu
            disabled={!data}
            slug={chartSlug(rootEntry?.name, pageKind)}
            gedcom={{ ds: mainDs, personIds: reportIds }}
            extraItems={[
              {
                key: "txt",
                icon: <FileTextIcon />,
                label: t("export.txt"),
                title: t("report.exportTxt.tooltip"),
                onSelect: () =>
                  data &&
                  downloadText(
                    `${chartSlug(rootEntry?.name, pageKind)}.txt`,
                    exportParts.map((p) => reportToText(t, p.data, p.dir, titleFor(p.kind), p.opts)).join("\n\n"),
                  ),
              },
              {
                key: "rtf",
                icon: <FileTextIcon />,
                label: t("export.rtf"),
                title: t("report.exportRtf.tooltip"),
                onSelect: () =>
                  data &&
                  downloadText(
                    `${chartSlug(rootEntry?.name, pageKind)}.rtf`,
                    reportsToRtf(t, exportParts.map((p) => ({ data: p.data, direction: p.dir, title: titleFor(p.kind), opts: p.opts }))),
                    "application/rtf",
                  ),
              },
              {
                key: "pdf",
                icon: <PrinterIcon />,
                label: t("export.pdf"),
                title: t("tree.exportPdf.tooltip"),
                onSelect: () =>
                  data &&
                  printDocument(
                    printSheet(
                      chartSlug(rootEntry?.name, pageKind),
                      exportParts.flatMap((p) => printBody(t, p.data, p.dir, titleFor(p.kind), p.opts)),
                    ),
                  ),
              },
            ]}
          />
        </>
      }
      controlsLeft={
        <>
          {kindSwitcher}
          <Segmented label={t("tree.direction")} value={mode} onChange={onModeChange} items={directions} />
          <Segmented
            label={t("report.style")}
            value={settings.reportNarrative ? "narrative" : "list"}
            onChange={(style) => set({ reportNarrative: style === "narrative" })}
            items={(["list", "narrative"] as const).map((style) => ({
              key: style,
              label: t(`report.style.${style}`),
              title: t(`report.style.${style}.tooltip`),
            }))}
          />
        </>
      }
      // The chord stays with the browser here: report entries are plain text,
      // and native find highlights every hit and works in the print preview.
      controlsRight={<ChartFindBox find={find} scope="report" takesFindKey={false} />}
    >
      <div className="tree-canvas-wrap">
        <div className="report-scroll">
          {parts.some((p) => p.data) ? (
            parts.map(
              (part) =>
                part.data && (
                  <div key={part.dir} className="report-page">
                    {mode === "both" && <h2 className="report-part-head">{part.kind}</h2>}
              {toc && (
                <nav className="report-toc" aria-label={t("report.toc")}>
                  <h3 className="report-toc-head">{t("report.toc")}</h3>
                  {tocRows(t, part.data, part.dir).map((row) => (
                    <button
                      key={row.gen}
                      className="report-jump report-toc-row"
                      onClick={() =>
                        document
                          .getElementById(`report-gen-${part.dir}-${row.gen}`)
                          ?.scrollIntoView({ behavior: "smooth", block: "start" })
                      }
                    >
                      {row.label}
                    </button>
                  ))}
                </nav>
              )}
              {part.data.generations.map((g) => {
                const heading = generationHeading(t, g, part.dir);
                return (
                <section key={g.gen} id={`report-gen-${part.dir}-${g.gen}`}>
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
                          <button className="report-jump" onClick={() => jumpTo(part.dir, e.parentNum!)}>
                            {familyHeading(e)}
                          </button>
                        </h4>
                      )}
                      <div
                        id={e.dupOf === undefined ? `report-entry-${part.dir}-${e.num}` : undefined}
                        className={`report-entry${e.id === selectedId ? " selected" : ""}`}
                        onClick={() => setSelectedId(e.id)}
                        title={t("tree.node.clickHint")}
                      >
                        <span className="report-num gm-data">
                          {e.num}
                          {e.childIndex === undefined && "."}
                        </span>
                        {e.childIndex !== undefined && (
                          <span className="report-roman gm-data">{romanIndex(e.childIndex)}.</span>
                        )}
                        <div className="report-entry-body">
                          <div>
                            <span className={`report-name ${sexClass(e.sex)}`}>{reportName(e, part.opts)}</span>
                            {!redacted(e) && e.years && <span className="report-years gm-data">{e.years}</span>}
                            {e.dupOf !== undefined && (
                              <button
                                className="report-dup report-jump"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  jumpTo(part.dir, e.dupOf!);
                                }}
                              >
                                → {t("ahnentafel.dup", { n: e.dupOf })}
                              </button>
                            )}
                          </div>
                          {/* Narrative style: the prose paragraph (footnote
                              markers included), the person's own notes, then
                              the numbered footnotes — source citations and
                              the event notes too long to weave in. */}
                          {!redacted(e) &&
                            part.opts.narrativeOf &&
                            (() => {
                              const nt = part.opts.narrativeOf!(e);
                              return (
                                <>
                                  {nt.paragraph && <div className="report-para">{nt.paragraph}</div>}
                                  {(e.notes ?? []).map((note, j) => (
                                    <div key={`n${j}`} className="report-note">
                                      {note}
                                    </div>
                                  ))}
                                  {nt.footnotes.map((fn, j) =>
                                    fn.note !== undefined ? (
                                      <div key={`fn${j}`} className="report-note">
                                        {`${citationMark(j + 1)} ${fn.note}`}
                                      </div>
                                    ) : (
                                      sourceNode(fn.source, `${citationMark(j + 1)} ${sourceLabel(t, fn.source)}`, `fn${j}`)
                                    ),
                                  )}
                                </>
                              );
                            })()}
                          {/* List style: fact lines first (event notes/sources
                              nested under their line), then the person's own
                              notes, then their record-level sources. */}
                          {!redacted(e) &&
                            !part.opts.narrativeOf &&
                            e.facts.map((f, j) => (
                              <div key={j} className="report-fact gm-data">
                                {factText(t, f, part.opts)}
                                {f.note && <div className="report-note">{f.note}</div>}
                                {(f.sources ?? []).map((src, k) => sourceNode(src, sourceLabel(t, src), k))}
                              </div>
                            ))}
                          {!redacted(e) &&
                            !part.opts.narrativeOf &&
                            (e.notes ?? []).map((note, j) => (
                              <div key={`n${j}`} className="report-note">
                                {note}
                              </div>
                            ))}
                          {!redacted(e) &&
                            !part.opts.narrativeOf &&
                            (e.sources ?? []).map((src, j) => sourceNode(src, sourceLabel(t, src), `s${j}`))}
                        </div>
                      </div>
                    </div>
                  ))}
                </section>
                );
              })}
              {/* The report stops where the generation limit says — own up to
                  the generations left off rather than ending as if complete. */}
              {truncationNote(t, part.data) && <p className="report-truncated muted">{truncationNote(t, part.data)}</p>}
                  </div>
                ),
            )
          ) : (
            <p className="muted">{t("ahnentafel.empty")}</p>
          )}
        </div>

        {selectedEntry && selectedIndi && (
          <TreeNodePanel
            node={selectedEntry}
            swatch={selectedEntry.num === 1 ? COLOR_PERSON : COLOR_FAMILY}
            rows={selectedRows}
            mainPerson={mainNav}
            mainLabel={t("tree.main")}
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
    </ChartPage>
  );
}

/** A source citation line — a link to the resolved page/image when there is
 *  one (click must not select the entry), plain text otherwise. The label is
 *  pre-composed by the caller (localized page, optional citation marker). */
function sourceNode(src: SourceLine, label: string, key: React.Key) {
  return src.url ? (
    <a
      key={key}
      className="report-source gm-data"
      href={linkHref(src.url)}
      target="_blank"
      rel="noreferrer"
      onClick={(ev) => ev.stopPropagation()}
    >
      {label} ↗
    </a>
  ) : (
    <div key={key} className="report-source gm-data">
      {label}
    </div>
  );
}

/** One report's part of the print document: its title, table of contents,
 *  generations and closing note (see printSheet). */
function printBody(
  t: Translate,
  data: ReportData,
  direction: TreeMode,
  title: string,
  opts: ReportTextOptions,
): string[] {
  const parts: string[] = [`<h1>${escapeHtml(title)}</h1>`];
  if (opts.toc) {
    // Anchor links to the generation headings — clickable in the saved PDF.
    parts.push(
      `<nav class="toc"><div class="toc-head">${escapeHtml(t("report.toc"))}</div>` +
        tocRows(t, data, direction)
          .map((row) => `<a href="#gen-${direction}-${row.gen}">${escapeHtml(row.label)}</a>`)
          .join("") +
        `</nav>`,
    );
  }
  for (const g of data.generations) {
    const h = generationHeading(t, g, direction);
    const meta = [h.range, h.coverage].filter(Boolean).map((s) => `· ${escapeHtml(s!)}`).join(" ");
    parts.push(`<h2 id="gen-${direction}-${g.gen}">${escapeHtml(h.title)}${meta ? ` <span class="range">${meta}</span>` : ""}</h2>`);
    let lastFam: string | undefined;
    for (const e of g.entries) {
      if (e.parentNum !== undefined && e.parentFam !== lastFam) {
        parts.push(`<h3>${escapeHtml(childrenOfLabel(t, e, opts))}</h3>`);
        lastFam = e.parentFam;
      }
      const hidden = !!opts.privacyLiving && e.living;
      const numCell =
        `<span class="num">${e.num}${e.childIndex === undefined ? "." : ""}</span>` +
        (e.childIndex !== undefined ? `<span class="rom">${romanIndex(e.childIndex)}.</span>` : "");
      const head =
        `${numCell} <strong>${escapeHtml(reportName(e, opts))}</strong>` +
        (!hidden && e.years ? ` <span class="years">${escapeHtml(e.years)}</span>` : "") +
        (e.dupOf !== undefined ? ` <span class="dup">→ ${escapeHtml(t("ahnentafel.dup", { n: e.dupOf }))}</span>` : "");
      const sourceDiv = (s: SourceLine, mark?: string) => {
        const label = escapeHtml(`${mark ? `${mark} ` : ""}${sourceLabel(t, s)}`);
        return `<div class="source">${s.url ? `<a href="${escapeHtml(s.url)}">${label}</a>` : label}</div>`;
      };
      const noteDiv = (n: string) => `<div class="note">${escapeHtml(n)}</div>`;
      const body: string[] = [];
      if (!hidden && opts.narrativeOf) {
        // Narrative style: paragraph (footnote markers included), person
        // notes, then the numbered footnotes (citations + long event notes).
        const nt = opts.narrativeOf(e);
        if (nt.paragraph) body.push(`<div class="para">${escapeHtml(nt.paragraph)}</div>`);
        body.push(...(e.notes ?? []).map(noteDiv));
        body.push(
          ...nt.footnotes.map((fn, i) =>
            fn.note !== undefined ? noteDiv(`${citationMark(i + 1)} ${fn.note}`) : sourceDiv(fn.source, citationMark(i + 1)),
          ),
        );
      } else if (!hidden) {
        // List style: fact lines first (event notes/sources nested under
        // their line), then the person's notes, then their sources.
        body.push(
          ...e.facts.map(
            (f) =>
              `<div class="fact">${escapeHtml(factText(t, f, opts))}` +
              (f.note ? noteDiv(f.note) : "") +
              (f.sources ?? []).map((s) => sourceDiv(s)).join("") +
              `</div>`,
          ),
        );
        body.push(...(e.notes ?? []).map(noteDiv), ...(e.sources ?? []).map((s) => sourceDiv(s)));
      }
      parts.push(`<div class="entry">${head}${body.join("")}</div>`);
    }
  }
  const truncated = truncationNote(t, data);
  if (truncated) parts.push(`<div class="note">${escapeHtml(truncated)}</div>`);
  return parts;
}

/** The standalone print document ("Save as PDF"): the same content as the
 *  page — one report, or the bowtie's two one after the other — in a
 *  self-contained light-palette sheet (no app CSS to resolve). */
function printSheet(fileName: string, parts: string[]): string {
  // Browsers seed the "Save as PDF" filename from the document <title>.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(`${fileName}.gedmerge`)}</title>
<style>
  @page { margin: 18mm; }
  body { font: 11pt/1.45 Georgia, "Times New Roman", serif; color: #000; margin: 0; }
  h1 { font-size: 15pt; margin: 0 0 12pt; }
  h2 { font-size: 12pt; margin: 14pt 0 6pt; border-bottom: 1.5pt solid #666; padding-bottom: 2pt; text-transform: uppercase; letter-spacing: 0.04em; }
  h2 .range { font-weight: 400; text-transform: none; letter-spacing: 0; color: #444; font-size: 10pt; }
  h3 { font-size: 11pt; margin: 10pt 0 4pt; font-style: italic; font-weight: 500; }
  .toc { margin: 0 0 14pt; }
  .toc-head { font-weight: 700; margin-bottom: 3pt; }
  .toc a { display: block; color: #000; text-decoration: none; margin-left: 1.2em; }
  .entry { margin: 0 0 7pt; page-break-inside: avoid; }
  .num { display: inline-block; min-width: 2.2em; text-align: right; }
  .rom { display: inline-block; min-width: 2.2em; text-align: right; margin-left: 0.3em; }
  .years, .dup { color: #444; }
  .fact { margin-left: 2.6em; color: #222; }
  .para { margin-left: 2.6em; color: #222; }
  .note { font-style: italic; color: #444; white-space: pre-wrap; }
  .source { color: #555; font-size: 10pt; }
  .source a { color: #1a4b7a; text-decoration: none; }
  .entry > .note, .entry > .source { margin-left: 2.6em; }
  .fact > .note, .fact > .source { margin-left: 1.2em; }
</style></head><body>${parts.join("")}</body></html>`;
}
