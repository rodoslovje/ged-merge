import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Individual, Sex } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import { datesTooltipOf, lifespanOf } from "../gedcom/lifespan";
import { additionalNames, defaultHomeId, displayName, nameTypeLabel, primaryName } from "../match/relatives";
import { rebuildIndividual, setEventField, setName, setSex, type EventFieldUpdate } from "../gedcom/edit";
import { serializeGedcom } from "../gedcom/serialize";
import { downloadText } from "./download";
import { sexClass } from "./sex";
import { HomePersonSelector } from "./HomePersonSelector";
import { PersonCard } from "./PersonCard";

interface Props {
  dataset: Dataset;
  fileName: string;
  /** Seeds the initial selection (the Merge-mode home person, if set). */
  homeId?: string;
}

/** Birth/residence/death/burial — the events shown in the center panel. */
const EVENT_TAGS = ["BIRT", "RESI", "DEAT", "BURI"];

/** A mutation applied to the selected person's raw record, then rebuilt and
 * re-rendered. */
type Commit = (mutate: (indi: Individual) => void) => void;

/** Edit mode's person view: parents on top, the selected person in the
 * center, partners + children on the bottom. The center panel is editable;
 * relatives navigate on click. */
export function EditView({ dataset, fileName, homeId }: Props) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => homeId ?? defaultHomeId(dataset) ?? dataset.individuals.keys().next().value,
  );
  const [history, setHistory] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  // Bumped after every edit to force a re-render — the dataset is mutated
  // in place, so React has no other signal that `person` changed.
  const [, setTick] = useState(0);

  function navigate(id: string) {
    if (!id || id === selectedId) return;
    if (selectedId) setHistory((h) => [...h, selectedId]);
    setSelectedId(id);
  }

  function goBack() {
    setHistory((h) => {
      if (h.length === 0) return h;
      setSelectedId(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }

  const person = selectedId ? dataset.individuals.get(selectedId) : undefined;

  const commit: Commit = (mutate) => {
    if (!person) return;
    mutate(person);
    rebuildIndividual(dataset, person);
    setDirty(true);
    setTick((v) => v + 1);
  };

  function exportGedcom() {
    const text = serializeGedcom(dataset.records, { eol: dataset.eol, finalNewline: dataset.finalNewline });
    const base = fileName.replace(/\.ged$/i, "");
    downloadText(`${base}.edited.ged`, text);
    setDirty(false);
  }

  if (!person) {
    return (
      <div className="section open edit-view">
        <div className="section-body">
          <p className="gm-file master gm-data">{fileName}</p>
          <p className="muted">{t("edit.empty")}</p>
        </div>
      </div>
    );
  }

  const parentFamilies = person.childOf
    .map((famId) => dataset.families.get(famId))
    .filter((f): f is NonNullable<typeof f> => !!f);

  const spouseFamilies = person.spouseOf
    .map((famId) => dataset.families.get(famId))
    .filter((f): f is NonNullable<typeof f> => !!f);

  const lifespan = lifespanOf(person);
  const otherNames = additionalNames(person);

  return (
    <div className="section open edit-view">
      <div className="section-body">
        <div className="edit-toolbar">
          <button className="nav-btn" onClick={goBack} disabled={history.length === 0}>
            ← {t("edit.back")}
          </button>
          <HomePersonSelector
            individuals={dataset.individuals}
            homeId={selectedId}
            onChange={navigate}
            placeholder={t("edit.selectPerson")}
            tooltip={t("edit.selectPerson")}
          />
          <button className="nav-btn" onClick={exportGedcom} disabled={!dirty} title={t("edit.exportTooltip")}>
            {t("edit.export")}
          </button>
        </div>

        <div className="edit-parents">
          {(parentFamilies.length ? parentFamilies : [undefined]).map((fam, i) => (
            <div className="edit-parent-group" key={fam?.id ?? `empty-${i}`}>
              <PersonCard
                individual={fam?.husband ? dataset.individuals.get(fam.husband) : undefined}
                roleLabel={t("field.father")}
                placeholder={t("edit.addFather")}
                onSelect={navigate}
              />
              <div className="edit-connector-h" />
              <PersonCard
                individual={fam?.wife ? dataset.individuals.get(fam.wife) : undefined}
                roleLabel={t("field.mother")}
                placeholder={t("edit.addMother")}
                onSelect={navigate}
              />
            </div>
          ))}
        </div>

        <div className="edit-connector-v" />

        <div className="edit-person">
          <NameEditor key={`name-${person.id}`} person={person} t={t} lifespan={lifespan} commit={commit} />
          <SexToggle key={`sex-${person.id}`} person={person} t={t} commit={commit} />
          {otherNames.length > 0 && (
            <div className="edit-other-names">
              {otherNames.map((n, i) => (
                <span className="edit-name-chip" key={i}>
                  {displayName(n)}
                  {n.type && <span className="muted"> · {nameTypeLabel(n.type, t)}</span>}
                </span>
              ))}
            </div>
          )}
          <EventList person={person} t={t} commit={commit} />
        </div>

        <div className="edit-connector-v" />

        <div className="edit-families">
          {(spouseFamilies.length ? spouseFamilies : [undefined]).map((fam, i) => {
            const partnerId = fam && (fam.husband === person.id ? fam.wife : fam.husband);
            return (
              <div className="edit-family" key={fam?.id ?? `empty-${i}`}>
                <PersonCard
                  individual={partnerId ? dataset.individuals.get(partnerId) : undefined}
                  roleLabel={t("field.partners")}
                  placeholder={t("edit.addPartner")}
                  onSelect={navigate}
                />
                <div className="edit-connector-h" />
                <div className="edit-children-wrap">
                  <div className="person-card-role">{t("field.children")}</div>
                  <div className="edit-children">
                    {fam?.children.map((childId) => (
                      <PersonCard
                        key={childId}
                        individual={dataset.individuals.get(childId)}
                        placeholder={t("edit.unknown")}
                        onSelect={navigate}
                      />
                    ))}
                    <PersonCard placeholder={t("edit.addChild")} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Editable given/surname fields for the primary name, plus the lifespan. */
function NameEditor({
  person,
  t,
  lifespan,
  commit,
}: {
  person: Individual;
  t: Translate;
  lifespan?: string;
  commit: Commit;
}) {
  const primary = primaryName(person);
  const [given, setGiven] = useState(primary?.given ?? "");
  const [surname, setSurname] = useState(primary?.surname ?? "");

  function commitName(nextGiven: string, nextSurname: string) {
    commit((indi) => setName(indi, { given: nextGiven, surname: nextSurname }));
  }

  return (
    <div className="edit-name-row" title={datesTooltipOf(person)}>
      <input
        className={`edit-input edit-name-input ${sexClass(person.sex)}`}
        value={given}
        placeholder={t("field.given")}
        title={t("field.given")}
        onChange={(e) => setGiven(e.target.value)}
        onBlur={() => commitName(given, surname)}
      />
      <input
        className={`edit-input edit-name-input ${sexClass(person.sex)}`}
        value={surname}
        placeholder={t("field.surname")}
        title={t("field.surname")}
        onChange={(e) => setSurname(e.target.value)}
        onBlur={() => commitName(given, surname)}
      />
      {lifespan && <span className="person-years gm-data">{lifespan}</span>}
    </div>
  );
}

const SEX_OPTIONS: Sex[] = ["M", "F", "U"];

/** M/F/U toggle for the individual's `SEX` line. */
function SexToggle({ person, t, commit }: { person: Individual; t: Translate; commit: Commit }) {
  return (
    <div className="edit-sex-row">
      <span className="edit-field-label">{t("field.sex")}</span>
      <div className="sex-toggle">
        {SEX_OPTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className={`sex-toggle-btn ${sexClass(s)} ${person.sex === s ? "active" : ""}`}
            title={t(`sex.${s}`)}
            onClick={() => commit((indi) => setSex(indi, s))}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Birth/residence/death/burial rows for the center panel, always shown so
 * empty events can be filled in. */
function EventList({ person, t, commit }: { person: Individual; t: Translate; commit: Commit }) {
  return (
    <div className="edit-events">
      {EVENT_TAGS.map((tag) => (
        <EventRow key={`${person.id}-${tag}`} person={person} tag={tag} t={t} commit={commit} />
      ))}
    </div>
  );
}

/** Editable date/place/links for a single event (e.g. `1 BIRT`). */
function EventRow({ person, tag, t, commit }: { person: Individual; tag: string; t: Translate; commit: Commit }) {
  const ev = person.events.find((e) => e.tag === tag);
  const label = t(`event.${tag}`);
  const [links, setLinks] = useState((ev?.links ?? []).join("\n"));

  function commitField(update: EventFieldUpdate) {
    commit((indi) => setEventField(indi, tag, update));
  }

  return (
    <div className="edit-event">
      <div className="edit-event-label">{label}</div>
      <div className="edit-event-value">
        <input
          className="edit-input edit-event-date"
          defaultValue={ev?.date?.raw ?? ""}
          placeholder={t("event.date", { event: label })}
          title={t("event.date", { event: label })}
          onBlur={(e) => commitField({ date: e.target.value })}
        />
        <input
          className="edit-input edit-event-place"
          defaultValue={ev?.place?.raw ?? ""}
          placeholder={t("event.place", { event: label })}
          title={t("event.place", { event: label })}
          onBlur={(e) => commitField({ place: e.target.value })}
        />
        <textarea
          className="edit-input edit-event-links"
          rows={1}
          value={links}
          placeholder={t("edit.links")}
          title={t("event.link", { event: label })}
          onChange={(e) => setLinks(e.target.value)}
          onBlur={() => commitField({ links: links.split("\n").map((l) => l.trim()).filter(Boolean) })}
        />
      </div>
    </div>
  );
}
