import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isRoundAnniversary, monthWeeks, type CalendarMonth, type DayEntry, type Fact } from "../../calendar/model";
import type { Holiday } from "../../calendar/holidays";
import { schemeVars, type CalendarScheme } from "./schemes";
import { BADGE_BG, LOGO_BADGE_MARKUP } from "../exportSvg";

export type { PagePhoto } from "./PhotoArea";
import { ENTRY_GLYPH, entryCell, entryLine, factDate, factSentence, monthName, weekdayNames, yearsAgo, type EntryOptions, type PersonWords } from "../../calendar/text";

// The family calendar's printed pages, drawn the same for the wizard's preview
// and the print document (see calendarCss). One component per page kind; the
// format decides the layout.

export type CalendarFormat = "wallTop" | "wallMiddle" | "desk";
export const CALENDAR_FORMATS: CalendarFormat[] = ["wallTop", "wallMiddle", "desk"];

/** Paper per format, in millimetres, and the em the page is set in. */
export const PAPER: Record<CalendarFormat, { w: number; h: number; em: number }> = {
  wallTop: { w: 210, h: 297, em: 3.5 },
  wallMiddle: { w: 297, h: 210, em: 3.7 },
  desk: { w: 210, h: 148, em: 2.6 },
};

function pageStyle(format: CalendarFormat, scheme: CalendarScheme, extra?: Record<string, string>): CSSProperties {
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
  name: string;
  /** The picture: photos, a collage or a chart (the view builds it). */
  picture: ReactNode;
  /** The family website's address, for the footer. */
  site?: string;
  /** A few words from the givers, under the name. */
  dedication?: string;
}

export function CoverPage({ format, scheme, year, name, picture, site, dedication }: CoverProps) {
  const { t } = useTranslation();
  return (
    <div className="cal-page cal-cover" style={pageStyle(format, scheme, { "--cal-pad-top": "3.4em" })}>
      <div className="cal-cover-title">{t("calendar.cover.title")}</div>
      <div className="cal-cover-year">{year}</div>
      <div className="cal-cover-name">{name}</div>
      {dedication?.trim() && <div className="cal-dedication">{dedication.trim()}</div>}
      <div className="cal-picture">{picture}</div>
      <Footer site={site} />
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
}

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
            {!large && <DayList {...props} />}
            <Facts {...props} />
          </div>
          <Legend />
          <Footer site={props.site} />
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
            <Facts {...props} />
          </div>
          <Footer site={props.site} />
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
        {!large && <DayList {...props} />}
        <Facts {...props} />
      </div>
      <Legend />
      <Footer site={props.site} />
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

function Grid({ year, month, holidays, words, entryOpts }: MonthProps) {
  const { t, i18n } = useTranslation();
  const byDay = new Map<number, DayEntry[]>();
  for (const e of livingFirst(month.entries)) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
  const hol = new Map<number, string[]>();
  for (const h of holidays) if (h.month === month.month) hol.set(h.day, [...(hol.get(h.day) ?? []), t(`calendar.holiday.${h.key}`)]);
  return (
    <table className="cal-grid">
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
              return (
                <td key={di} className={cls || undefined}>
                  <div className="cal-day">{day}</div>
                  {names && <div className="cal-holname">{[...new Set(names)].join(", ")}</div>}
                  {byDay.get(day)?.filter((e) => e.kind !== "memorial").map((e, i) => (
                    <div key={i} className={`cal-entry cal-${e.kind}${isRoundAnniversary(e) ? " cal-round" : ""}`}>
                      <span className="cal-glyph">{isRoundAnniversary(e) ? ROUND_GLYPH : ENTRY_GLYPH[e.kind]}</span>
                      {entryCell(t, words, e, entryOpts)}
                    </div>
                  ))}
                  {/* The memorial days sit at the foot of the day, stacked
                      upwards, apart from the living above them. */}
                  {byDay.get(day)?.some((e) => e.kind === "memorial") && (
                    <div className="cal-mems">
                      {byDay.get(day)!.filter((e) => e.kind === "memorial").map((e, i) => (
                        <div key={i} className="cal-entry cal-memorial">
                          <span className="cal-glyph">{ENTRY_GLYPH[e.kind]}</span>
                          {entryCell(t, words, e, entryOpts)}
                        </div>
                      ))}
                    </div>
                  )}
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
          <span className="cal-glyph">{isRoundAnniversary(e) ? ROUND_GLYPH : ENTRY_GLYPH[e.kind]}</span>
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

/** A round birthday's or a jubilee's mark, in place of the plain glyph. */
const ROUND_GLYPH = "★";

function Legend() {
  const { t } = useTranslation();
  return (
    <div className="cal-legend">
      <span>{ENTRY_GLYPH.birthday} {t("calendar.legend.birthday")}</span>
      <span>{ENTRY_GLYPH.anniversary} {t("calendar.legend.anniversary")}</span>
      <span>{ENTRY_GLYPH.memorial} {t("calendar.legend.memorial")}</span>
      <span>{ROUND_GLYPH} {t("calendar.legend.round")}</span>
    </div>
  );
}

/** The page's foot: the family website's address on the left, where one is
 *  set in the website tool, and the GED Merge credit on the right. */
function Footer({ site }: { site?: string }) {
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
