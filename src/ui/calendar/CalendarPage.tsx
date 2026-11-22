import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { monthWeeks, type CalendarMonth, type DayEntry, type Fact } from "../../calendar/model";
import type { Holiday } from "../../calendar/holidays";
import { ENTRY_GLYPH, entryCell, entryLine, factDate, factSentence, monthName, weekdayNames, yearsAgo, type PersonWords } from "../../calendar/text";

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

/** A picture for a page: the image's address and an optional caption. */
export interface PagePhoto {
  url: string;
  caption?: string;
}

function pageStyle(format: CalendarFormat, extra?: Record<string, string>): CSSProperties {
  const p = PAPER[format];
  return { "--cal-ratio": `${p.w} / ${p.h}`, "--cal-ems": String(p.w / p.em), ...extra } as CSSProperties;
}

function Photo({ photo, style }: { photo?: PagePhoto; style?: CSSProperties }) {
  const { t } = useTranslation();
  return (
    <div className="cal-photo" style={style}>
      {photo ? <img src={photo.url} alt="" /> : <div className="cal-photo-empty">{t("calendar.noPhoto")}</div>}
      {photo?.caption && <div className="cal-caption">{photo.caption}</div>}
    </div>
  );
}

interface CoverProps {
  format: CalendarFormat;
  year: number;
  name: string;
  /** The cover's picture: a photo, or the fan chart's node. */
  photo?: PagePhoto;
  fan?: ReactNode;
}

export function CoverPage({ format, year, name, photo, fan }: CoverProps) {
  const { t } = useTranslation();
  return (
    <div className="cal-page cal-cover" style={pageStyle(format, { "--cal-pad-top": "3.4em" })}>
      <div className="cal-cover-title">{t("calendar.cover.title")}</div>
      <div className="cal-cover-year">{year}</div>
      <div className="cal-cover-name">{name}</div>
      {fan ? <div className="cal-fan">{fan}</div> : <Photo photo={photo} />}
    </div>
  );
}

interface MonthProps {
  format: CalendarFormat;
  year: number;
  month: CalendarMonth;
  /** The facts chosen for this month (the month's defaults unless changed). */
  facts: Fact[];
  holidays: Holiday[];
  photo?: PagePhoto;
  words: PersonWords;
}

/** One month: one page, or two for the wall calendar bound in the middle. */
export function MonthPages(props: MonthProps) {
  const { format, photo } = props;
  if (format === "wallMiddle") {
    return (
      <>
        <div className="cal-page" style={pageStyle(format, { "--cal-pad-top": "2em" })}>
          <Photo photo={photo} style={{ flex: "1 1 auto", marginBottom: "1.4em" }} />
        </div>
        <div className="cal-page" style={pageStyle(format, { "--cal-pad-top": "3.4em" })}>
          <Head {...props} />
          <div className="cal-grid-wrap"><Grid {...props} /></div>
          <div className="cal-lower">
            <DayList {...props} />
            <Facts {...props} />
          </div>
          <Legend />
        </div>
      </>
    );
  }
  if (format === "desk") {
    return (
      <div className="cal-page cal-desk" style={pageStyle(format, { "--cal-pad-top": "3.2em" })}>
        <Photo photo={photo} />
        <div className="cal-side">
          <Head {...props} />
          <div className="cal-grid-wrap"><Grid {...props} /></div>
          <div className="cal-lower">
            <Facts {...props} />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="cal-page" style={pageStyle(format, { "--cal-pad-top": "3.4em" })}>
      <Photo photo={photo} style={{ height: "40%" }} />
      <Head {...props} />
      <div className="cal-grid-wrap"><Grid {...props} /></div>
      <div className="cal-lower">
        <DayList {...props} />
        <Facts {...props} />
      </div>
      <Legend />
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

function Grid({ year, month, holidays, words }: MonthProps) {
  const { t, i18n } = useTranslation();
  const byDay = new Map<number, DayEntry[]>();
  for (const e of month.entries) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
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
              const cls = [di === 6 && "cal-sun", names && "cal-hol"].filter(Boolean).join(" ");
              return (
                <td key={di} className={cls || undefined}>
                  <div className="cal-day">{day}</div>
                  {names && <div className="cal-holname">{[...new Set(names)].join(", ")}</div>}
                  {byDay.get(day)?.map((e, i) => (
                    <div key={i} className={`cal-entry cal-${e.kind}`}>
                      <span className="cal-glyph">{ENTRY_GLYPH[e.kind]}</span>
                      {entryCell(t, words, e)}
                    </div>
                  ))}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DayList({ month, words }: MonthProps) {
  const { t } = useTranslation();
  if (!month.entries.length) return null;
  return (
    <div className="cal-list">
      {month.entries.map((e, i) => (
        <div key={i} className={`cal-${e.kind}`}>
          <b>{e.day}.</b>
          <span className="cal-glyph">{ENTRY_GLYPH[e.kind]}</span>
          {entryLine(t, words, e)}
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

function Legend() {
  const { t } = useTranslation();
  return (
    <div className="cal-legend">
      <span>{ENTRY_GLYPH.birthday} {t("calendar.legend.birthday")}</span>
      <span>{ENTRY_GLYPH.anniversary} {t("calendar.legend.anniversary")}</span>
      <span>{ENTRY_GLYPH.memorial} {t("calendar.legend.memorial")}</span>
    </div>
  );
}
