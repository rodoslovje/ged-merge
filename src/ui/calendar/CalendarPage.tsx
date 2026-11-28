import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { factKey, isRoundAnniversary, monthWeeks, type CalendarMonth, type DayEntry, type Fact } from "../../calendar/model";
import type { Holiday } from "../../calendar/holidays";
import { saintsOf, type NameCalendar } from "../../calendar/nameDays";
import { schemeVars, type CalendarScheme } from "./schemes";
import { BADGE_BG, LOGO_BADGE_MARKUP } from "../exportSvg";
import { paperMm, type Orientation, type PaperName, type PaperSize } from "../../chart/sheets";

export type { PagePhoto } from "./PhotoArea";
import { NAME_DAY_GLYPH, ROUND_GLYPH, entryCell, entryGlyph, entryLine, factDate, factSentence, monthName, weekdayNames, yearsAgo, type EntryOptions, type PersonWords } from "../../calendar/text";

// The family calendar's printed pages, drawn the same for the wizard's preview
// and the print document (see calendarCss). One component per page kind; the
// format decides the layout.

export type CalendarFormat = "wallTop" | "wallMiddle" | "desk";
export const CALENDAR_FORMATS: CalendarFormat[] = ["wallTop", "wallMiddle", "desk"];

/** The page each format is designed on, in millimetres, and the em it is set
 *  in. It fixes the page's proportions; the paper it is printed on is chosen
 *  at print time and the page is scaled onto it ({@link printGeometry}). */
export const PAPER: Record<CalendarFormat, { w: number; h: number; em: number }> = {
  wallTop: { w: 210, h: 297, em: 3.5 },
  wallMiddle: { w: 297, h: 210, em: 3.7 },
  desk: { w: 210, h: 148, em: 2.6 },
};

/** The paper each format's print dialog opens on: a calendar hung by its top
 *  edge is a single sheet per month, so it goes on A3; the one bound in the
 *  middle opens out to that size from two A4 sheets. */
export const DEFAULT_PAPER: Record<CalendarFormat, PaperName> = { wallTop: "a3", wallMiddle: "a4", desk: "a5" };

/** Which way round a named paper goes for a format. */
export function formatOrientation(format: CalendarFormat): Orientation {
  return PAPER[format].w > PAPER[format].h ? "landscape" : "portrait";
}

export interface PrintGeometry {
  /** The sheet of paper, in mm. */
  sheet: { w: number; h: number };
  /** The page drawn on it, in mm, and its em: the designed page scaled as far
   *  as the sheet allows, proportions kept — a paper of another shape (Letter,
   *  a typed size) leaves white at two edges. */
  page: { w: number; h: number; em: number };
  /** How much larger than designed the page prints. */
  scale: number;
}

export function printGeometry(format: CalendarFormat, paper: PaperSize): PrintGeometry {
  const base = PAPER[format];
  const sheet = paperMm(paper, formatOrientation(format));
  const scale = Math.min(sheet.w / base.w, sheet.h / base.h);
  // Rounded down, so a page never outgrows its sheet by a rounding error and
  // spills onto a blank one.
  const mm = (v: number) => Math.floor(v * scale * 100) / 100;
  return { sheet, page: { w: mm(base.w), h: mm(base.h), em: base.em * scale }, scale };
}

export function pageStyle(format: CalendarFormat, scheme: CalendarScheme, extra?: Record<string, string>): CSSProperties {
  const p = PAPER[format];
  return { "--cal-ratio": `${p.w} / ${p.h}`, "--cal-ems": String(p.w / p.em), ...schemeVars(scheme), ...extra } as CSSProperties;
}

/** The living first (birthdays, anniversaries), the memorial days after them. */
function livingFirst(entries: DayEntry[]): DayEntry[] {
  return [...entries.filter((e) => e.kind !== "memorial"), ...entries.filter((e) => e.kind === "memorial")];
}

interface CoverProps {
  format: CalendarFormat;
  scheme: CalendarScheme;
  year: number;
  /** The calendar's name, as the givers call it. */
  title: string;
  name: string;
  /** The picture: photos, a collage or a chart (the view builds it). */
  picture: ReactNode;
  /** The family website's address, for the footer. */
  site?: string;
  /** A few words from the givers, under the name. */
  dedication?: string;
}

export function CoverPage({ format, scheme, year, title, name, picture, site, dedication }: CoverProps) {
  return (
    <div className="cal-page cal-cover" style={pageStyle(format, scheme, { "--cal-pad-top": "3.4em" })}>
      <div className="cal-cover-title">{title}</div>
      <div className="cal-cover-year">{year}</div>
      <div className="cal-cover-name">{name}</div>
      {dedication?.trim() && <div className="cal-dedication">{dedication.trim()}</div>}
      <div className="cal-picture">{picture}</div>
      <PageFooter site={site} />
    </div>
  );
}

interface MonthProps {
  format: CalendarFormat;
  scheme: CalendarScheme;
  year: number;
  month: CalendarMonth;
  /** The facts chosen for this month (the month's defaults unless changed). */
  facts: Fact[];
  holidays: Holiday[];
  picture: ReactNode;
  site?: string;
  words: PersonWords;
  entryOpts: EntryOptions;
  /** Show the list of the month's people under the grid. */
  showList: boolean;
  /** Show the moments from the family's past. */
  showFacts: boolean;
  /** Write the day's saints beside its number, from this calendar of names. */
  saints?: NameCalendar;
}

/** How many saints' names a day cell carries. */
const SAINTS_PER_DAY = 2;

/** One month: one page, or two for the wall calendar bound in the middle. */
export function MonthPages(props: MonthProps) {
  const { format, scheme, picture } = props;
  // Large print leaves out the list under the grid: the cells say it all.
  const large = !!props.entryOpts.large;
  if (format === "wallMiddle") {
    return (
      <>
        <div className="cal-page" style={pageStyle(format, scheme, { "--cal-pad-top": "2em" })}>
          <div className="cal-picture" style={{ flex: "1 1 auto", marginBottom: "1.4em" }}>{picture}</div>
        </div>
        <div className={`cal-page${large ? " cal-large" : ""}`} style={pageStyle(format, scheme, { "--cal-pad-top": "3.4em" })}>
          <Head {...props} />
          <div className="cal-grid-wrap"><Grid {...props} /></div>
          <div className="cal-lower">
            {!large && props.showList && <DayList {...props} />}
            {props.showFacts && <Facts {...props} />}
          </div>
          <Legend {...props} />
          <PageFooter site={props.site} />
        </div>
      </>
    );
  }
  if (format === "desk") {
    return (
      <div className={`cal-page cal-desk${large ? " cal-large" : ""}`} style={pageStyle(format, scheme, { "--cal-pad-top": "3.2em" })}>
        <div className="cal-picture">{picture}</div>
        <div className="cal-side">
          <Head {...props} />
          <div className="cal-grid-wrap"><Grid {...props} /></div>
          <div className="cal-lower">
            {props.showFacts && <Facts {...props} />}
          </div>
          <PageFooter site={props.site} />
        </div>
      </div>
    );
  }
  return (
    <div className={`cal-page${large ? " cal-large" : ""}`} style={pageStyle(format, scheme, { "--cal-pad-top": "3.4em" })}>
      <div className="cal-picture" style={{ height: "40%" }}>{picture}</div>
      <Head {...props} />
      <div className="cal-grid-wrap"><Grid {...props} /></div>
      <div className="cal-lower">
        {!large && props.showList && <DayList {...props} />}
        {props.showFacts && <Facts {...props} />}
      </div>
      <Legend {...props} />
      <PageFooter site={props.site} />
    </div>
  );
}

function Head({ year, month }: MonthProps) {
  const { i18n } = useTranslation();
  return (
    <div className="cal-head">
      <span className="cal-month">{monthName(i18n.language, month.month)}</span>
      <span className="cal-year">{year}</span>
    </div>
  );
}

/** How a busy day is drawn: its birthdays run together, and how many of its
 *  entries are drawn at all. */
interface DayFit { compact: boolean; shown: number }
const NO_FITS: Record<number, DayFit> = {};

/**
 * How each day too busy for its cell is drawn. A cell never grows (every week
 * stays as tall as the others), so such a day is measured and tightened step
 * by step until it fits: first its birthdays run together as one list of
 * names, without their marks; then it is cut back one entry at a time, a "+N"
 * standing for the rest. `sig` names everything the cells' size and content
 * follow from: a change starts the measuring anew.
 */
function useCellFit(sig: string) {
  const ref = useRef<HTMLTableElement>(null);
  const [fit, setFit] = useState<{ sig: string; days: Record<number, DayFit> }>({ sig, days: NO_FITS });
  const days = fit.sig === sig ? fit.days : NO_FITS;
  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    let next: Record<number, DayFit> | undefined;
    for (const cell of table.querySelectorAll<HTMLElement>(".cal-cell")) {
      if (cell.scrollHeight <= cell.clientHeight + 1) continue;
      const day = Number(cell.dataset.day);
      const shown = Number(cell.dataset.shown);
      const compact = days[day]?.compact ?? false;
      // The list of names is tried whole before anything is left out.
      if (!compact && Number(cell.dataset.birthdays) > 1) (next ??= { ...days })[day] = { compact: true, shown };
      else if (shown > 0) (next ??= { ...days })[day] = { compact, shown: shown - 1 };
    }
    if (next) setFit({ sig, days: next });
  }, [sig, days]);
  return [ref, days] as const;
}

function Grid({ format, year, month, holidays, words, entryOpts, facts, showList, showFacts, saints }: MonthProps) {
  const { t, i18n } = useTranslation();
  // The living first, the memorial days after them — the order a busy day is cut in.
  const byDay = new Map<number, { e: DayEntry; text: string }[]>();
  for (const e of livingFirst(month.entries)) byDay.set(e.day, [...(byDay.get(e.day) ?? []), { e, text: entryCell(t, words, e, entryOpts) }]);
  const hol = new Map<number, string[]>();
  for (const h of holidays) if (h.month === month.month) hol.set(h.day, [...(hol.get(h.day) ?? []), t(`calendar.holiday.${h.key}`)]);
  const [ref, fitOf] = useCellFit(JSON.stringify([
    format, year, month.month, !!entryOpts.large, showList, showFacts, facts.map(factKey),
    [...byDay].map(([day, list]) => [day, list.map((x) => x.text)]), [...hol], saints,
  ]));
  const saintsOn = (day: number) => (saints ? saintsOf(saints, month.month, day).slice(0, SAINTS_PER_DAY).join(", ") : "");
  const entry = ({ e, text }: { e: DayEntry; text: string }, i: number) => (
    <div key={i} className={`cal-entry cal-${e.kind}${isRoundAnniversary(e) ? " cal-round" : ""}`}>
      <Glyph e={e} />
      {text}
    </div>
  );
  return (
    <table className="cal-grid" ref={ref}>
      <thead>
        <tr>
          {weekdayNames(i18n.language).map((w, i) => (
            <th key={i} className={i === 6 ? "cal-sun" : undefined}>{w}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {monthWeeks(year, month.month).map((week, wi) => (
          <tr key={wi}>
            {week.map((day, di) => {
              if (!day) return <td key={di} className="cal-blank" />;
              const names = hol.get(day);
              const cls = [di === 5 && "cal-sat", di === 6 && "cal-sun", names && "cal-hol"].filter(Boolean).join(" ");
              const all = byDay.get(day) ?? [];
              const fit = fitOf[day];
              const fits = all.slice(0, fit?.shown ?? all.length);
              const mems = fits.filter((x) => x.e.kind === "memorial");
              const living = fits.filter((x) => x.e.kind !== "memorial");
              const birthdays = living.filter((x) => x.e.kind === "birthday");
              return (
                <td key={di} className={cls || undefined}>
                  {/* The day's content floats over its cell, so a busy day
                      never stretches its week: every row stays as tall as
                      the others. */}
                  <div className="cal-cell" data-day={day} data-shown={fits.length} data-birthdays={all.filter((x) => x.e.kind === "birthday").length}>
                    {/* The day's saints share the number's line, so they
                        take no room from the family's names. */}
                    {saints ? (
                      <div className="cal-dayrow">
                        <div className="cal-day">{day}</div>
                        <div className="cal-saint">{saintsOn(day)}</div>
                      </div>
                    ) : <div className="cal-day">{day}</div>}
                    {names && <div className="cal-holname">{[...new Set(names)].join(", ")}</div>}
                    {/* A busy day's birthdays run together: the names alone,
                        a round one in bold. */}
                    {fit?.compact ? (
                      <>
                        {birthdays.length > 0 && (
                          <div className="cal-entry cal-birthday cal-compact">
                            {birthdays.map((x, i) => (
                              <span key={i} className={isRoundAnniversary(x.e) ? "cal-round-name" : undefined}>
                                {i > 0 && ", "}
                                <Glyph e={x.e} />
                                {x.text}
                              </span>
                            ))}
                          </div>
                        )}
                        {living.filter((x) => x.e.kind !== "birthday").map(entry)}
                      </>
                    ) : living.map(entry)}
                    {/* What the cell has no room for: how many are left out. */}
                    {fits.length < all.length && <div className="cal-entry cal-more">+{all.length - fits.length}</div>}
                    {/* The memorial days sit at the foot of the day, apart
                        from the living above them. */}
                    {mems.length > 0 && <div className="cal-mems">{mems.map(entry)}</div>}
                  </div>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DayList({ month, words, entryOpts }: MonthProps) {
  const { t } = useTranslation();
  if (!month.entries.length) return null;
  return (
    <div className="cal-list">
      {livingFirst(month.entries).map((e, i) => (
        <div key={i} className={`cal-${e.kind}${isRoundAnniversary(e) ? " cal-round" : ""}`}>
          <b>{e.day}.</b>
          <Glyph e={e} />
          {entryLine(t, words, e, entryOpts)}
        </div>
      ))}
    </div>
  );
}

function Facts({ facts, words }: MonthProps) {
  const { t, i18n } = useTranslation();
  if (!facts.length) return null;
  return (
    <div className="cal-facts">
      <h4>{t("calendar.facts.title")}</h4>
      {facts.map((f, i) => (
        <div key={i} className="cal-fact">
          <div className="cal-fact-when">
            {factDate(t, i18n.language, f.date)} · {yearsAgo(t, f.yearsAgo)}
          </div>
          {factSentence(t, words, f)}
        </div>
      ))}
    </div>
  );
}

/** An entry's mark, where it has one: a plain birthday goes without. */
export function Glyph({ e }: { e: DayEntry }) {
  const glyph = entryGlyph(e, isRoundAnniversary(e));
  return glyph ? <span className="cal-glyph">{glyph}</span> : null;
}

function Legend({ month }: MonthProps) {
  const { t } = useTranslation();
  return (
    <div className="cal-legend">
      {month.entries.some((e) => e.kind === "nameday") && <span>{NAME_DAY_GLYPH} {t("calendar.legend.nameday")}</span>}
      <span>⚭ {t("calendar.legend.anniversary")}</span>
      <span>† {t("calendar.legend.memorial")}</span>
      <span>{ROUND_GLYPH} {t("calendar.legend.round")}</span>
    </div>
  );
}

/** The page's foot: the family website's address on the left, where one is
 *  set in the website tool, and the GED Merge credit on the right. */
export function PageFooter({ site }: { site?: string }) {
  const { t } = useTranslation();
  return (
    <div className="cal-foot">
      <span>{site}</span>
      <span className="cal-credit">
        {t("site.footer.madeWith")}
        {/* GED Merge's own green, whatever the scheme — the brand beside its badge. */}
        <span className="cal-brand" style={{ color: BADGE_BG }}>gedmerge.com</span>
        <svg viewBox="0 0 100 100" aria-hidden="true" dangerouslySetInnerHTML={{ __html: LOGO_BADGE_MARKUP }} />
      </span>
    </div>
  );
}
