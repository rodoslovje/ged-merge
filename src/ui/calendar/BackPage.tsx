import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isRoundAnniversary, type CalendarMonth } from "../../calendar/model";
import { ENTRY_GLYPH, entryCell, monthName, type EntryOptions, type PersonWords } from "../../calendar/text";
import { pageStyle, PageFooter, type CalendarFormat, type PagePhoto } from "./CalendarPage";
import type { CalendarScheme } from "./schemes";

// The calendar's back page: the year on one sheet, a gallery of who is who,
// or any of the pictures a month can carry — and under it a short colophon.

interface Props {
  format: CalendarFormat;
  scheme: CalendarScheme;
  title: string;
  children: ReactNode;
  /** The givers' own line ("Made by your grandchildren"). */
  signature?: string;
  /** When the calendar was made, already worded. */
  made: string;
  site?: string;
}

export function BackPage({ format, scheme, title, children, signature, made, site }: Props) {
  return (
    <div className="cal-page cal-back" style={pageStyle(format, scheme, { "--cal-pad-top": "3em" })}>
      <div className="cal-back-title">{title}</div>
      <div className="cal-back-body">{children}</div>
      <div className="cal-colophon">
        {signature?.trim() && <div className="cal-signature">{signature.trim()}</div>}
        <div>{[made, site].filter(Boolean).join(" · ")}</div>
      </div>
      <PageFooter />
    </div>
  );
}

/** The year at a glance: every month's days in a column of its own. */
export function YearOverview({ months, words, entryOpts }: { months: CalendarMonth[]; words: PersonWords; entryOpts: EntryOptions }) {
  const { t, i18n } = useTranslation();
  // The numbers follow the setting; large print's kinship words would not fit.
  const opts = { ...entryOpts, large: false };
  return (
    <div className="cal-overview">
      {months.map((m) => (
        <div key={m.month} className="cal-overview-month">
          <div className="cal-overview-head">{monthName(i18n.language, m.month)}</div>
          {m.entries.map((e, i) => (
            <div key={i} className={`cal-overview-entry cal-${e.kind}${isRoundAnniversary(e) ? " cal-round" : ""}`}>
              <b>{e.day}.</b>
              <span className="cal-glyph">{isRoundAnniversary(e) ? "★" : ENTRY_GLYPH[e.kind]}</span>
              {entryCell(t, words, e, opts)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Who is who: a portrait of everyone the calendar celebrates, each with the
 *  name and the kinship. */
export function WhoIsWho({ people }: { people: PagePhoto[] }) {
  const { t } = useTranslation();
  if (!people.length) return <div className="cal-photo-empty">{t("calendar.back.galleryEmpty")}</div>;
  return (
    <div className="cal-gallery">
      {people.map((p, i) => (
        <figure key={i} className="cal-gallery-item">
          <img src={p.url} alt="" />
          {p.caption && <figcaption>{p.caption}</figcaption>}
        </figure>
      ))}
    </div>
  );
}
