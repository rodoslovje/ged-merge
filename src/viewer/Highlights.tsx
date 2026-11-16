import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GedDate, GedEvent } from "../gedcom/types";
import { buildStatsFacts } from "../stats/facts";
import { applyCountry, DEFAULT_SCOPE, scopeFacts } from "../stats/scope";
import { overview } from "../stats/aggregate";
import { StatTile } from "../ui/tools/StatsCharts";
import { PersonLink } from "../ui/PersonLink";
import { displayDate } from "../gedcom/dateDisplay";
import { eventDisplayLabel, eventGlyph, familyEventLabel } from "../gedcom/eventTags";
import { onThisWeek } from "./anniversaries";
import { useSettingsSlice } from "../ui/SettingsContext";
import { StatsIcon } from "../ui/icons/StatsIcon";

const DATE_KEYS = ["dateDisplay"] as const;

/**
 * The front page's highlights: a few of the statistics' numbers, the most
 * common surnames, and what happened in the family this week in years past —
 * so the first page says something about the family before anyone searches.
 */
export function Highlights({ ds, onNavigate, onSurname }: {
  ds: Dataset;
  onNavigate: (id: string) => void;
  /** A surname picked: the front page searches for it. */
  onSurname: (surname: string) => void;
}) {
  const { t, i18n } = useTranslation();
  // Re-drawn when the date display is set (the site sets it as it opens).
  useSettingsSlice(DATE_KEYS);
  const ov = useMemo(() => {
    const facts = buildStatsFacts(ds);
    return overview(applyCountry(facts, scopeFacts(facts, DEFAULT_SCOPE, null, undefined), DEFAULT_SCOPE));
  }, [ds]);
  const week = useMemo(() => onThisWeek(ds, new Date()), [ds]);
  const num = (n: number) => n.toLocaleString(i18n.language);
  const person = (id: string) => <PersonLink dataset={ds} id={id} fallback={id} onNavigate={onNavigate} />;
  const couple = (famId: string) => {
    const fam = ds.families.get(famId);
    return (
      <span className="site-couple">
        {fam?.husband && person(fam.husband)}
        {fam?.husband && fam?.wife && <span className="muted"> ⚭ </span>}
        {fam?.wife && person(fam.wife)}
      </span>
    );
  };

  return (
    <section className="site-highlights">
      <h2>{t("site.home.highlights")}</h2>
      {/* The three numbers that size the tree up, large; the rest compact. */}
      <div className="stats-tiles site-tiles-primary">
        <StatTile label={t("stats.people")} value={num(ov.people)} />
        <StatTile label={t("stats.families")} value={num(ov.families)} />
        {ov.firstBirth && ov.lastBirth && <StatTile label={t("stats.births")} value={`${ov.firstBirth.year}–${ov.lastBirth.year}`} />}
      </div>
      <div className="stats-tiles site-tiles-secondary">
        <StatTile label={t("stats.surnames")} value={num(ov.surnames)} />
        <StatTile label={t("stats.placesNamed")} value={num(ov.places)} />
        {ov.oldestMale && <StatTile tone="male" label={t("stats.oldestMale")} value={t("stats.years", { count: ov.oldestMale.age })} sub={person(ov.oldestMale.id)} />}
        {ov.oldestFemale && <StatTile tone="female" label={t("stats.oldestFemale")} value={t("stats.years", { count: ov.oldestFemale.age })} sub={person(ov.oldestFemale.id)} />}
        {ov.largestFamily && <StatTile label={t("stats.largestFamily")} value={t("stats.children", { count: ov.largestFamily.children })} sub={couple(ov.largestFamily.id)} />}
      </div>

      {ov.topSurnames.length > 0 && (
        <div className="site-surnames">
          <h3>{t("site.home.surnames")}</h3>
          <div className="site-chips">
            {ov.topSurnames.map((b) => (
              <button key={b.key} type="button" className="site-chip" onClick={() => onSurname(b.label ?? b.key)}>
                {b.label}<span className="site-chip-count">{num(b.count)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {week.length > 0 && (
        <div className="site-week">
          <h3>{t("site.home.thisWeek")}</h3>
          <ul className="site-week-list">
            {week.map((a, i) => (
              <li key={i}>
                <span className="site-week-date">{displayDate(a.event.date as GedDate)}</span>
                <span className="site-week-glyph" aria-hidden="true">{eventGlyph(a.event.tag)}</span>
                <span className="site-week-what">{label(a.event, a.family, t)}</span>
                {a.family ? couple(a.id) : person(a.id)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p><a className="nav-btn site-more" href="#/stats"><StatsIcon size={16} /> {t("site.home.moreStats")}</a></p>
    </section>
  );
}

function label(e: GedEvent, family: boolean, t: (k: string) => string): string {
  return family ? familyEventLabel(e.tag, t) : eventDisplayLabel(e.tag, t);
}

