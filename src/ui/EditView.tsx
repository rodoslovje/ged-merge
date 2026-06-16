import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Family, GedEvent, Individual, Sex } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import { datesTooltipOf, lifespanOf } from "../gedcom/lifespan";
import { ADDITIONAL_NAME_TYPES, defaultHomeId, displayName, nameTypeLabel, primaryName } from "../match/relatives";
import {
  addAdditionalName,
  addChild,
  addParent,
  addPartner,
  rebuildFamily,
  rebuildIndividual,
  removeAdditionalName,
  setAdditionalName,
  setEventField,
  setFamilyEventField,
  setName,
  setNickname,
  setSex,
  type EventFieldUpdate,
} from "../gedcom/edit";
import { sexClass } from "./sex";
import { HomePersonSelector } from "./HomePersonSelector";
import { PersonCard } from "./PersonCard";

interface Props {
  dataset: Dataset;
  fileName: string;
  /** Seeds the initial selection (the Merge-mode home person, if set). */
  homeId?: string;
  /** Called whenever the dataset is mutated so the parent can track which records changed. */
  onDirty: (type: "individual" | "family", id: string) => void;
  /** Open the edit tree rooted on the currently selected person. */
  onShowTree: (id: string) => void;
}

/** Birth/christening/residence/death/burial — the events shown in the
 * center panel. */
const EVENT_TAGS = ["BIRT", "CHR", "RESI", "DEAT", "BURI"];

/** A mutation applied to the selected person's raw record, then rebuilt and
 * re-rendered. */
type Commit = (mutate: (indi: Individual) => void) => void;

/** A mutation applied to a family's raw record, then rebuilt and
 * re-rendered. */
type FamilyCommit = (fam: Family, mutate: (fam: Family) => void) => void;

/** Width (in `ch`) that fits `value` (or, while empty, `placeholder`)
 * without the input growing/shrinking awkwardly as the user types — used to
 * keep name fields compact instead of stretching to fill the row. */
function fieldWidth(value: string, placeholder: string): string {
  const len = value.length > 0 ? value.length : placeholder.length;
  return `${Math.max(len, 3) + 2}ch`;
}

/** Edit mode's person view: parents on top, the selected person in the
 * center, partners + children on the bottom. The center panel is editable;
 * relatives navigate on click. */
export function EditView({ dataset, fileName, homeId, onDirty, onShowTree }: Props) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => homeId ?? defaultHomeId(dataset) ?? dataset.individuals.keys().next().value,
  );
  const [history, setHistory] = useState<string[]>([]);
  // Bumped after every edit to force a re-render — the dataset is mutated
  // in place, so React has no other signal that `person` changed.
  const [, setTick] = useState(0);
  const focusNextName = useRef(false);

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
    onDirty("individual", person.id);
    setTick((v) => v + 1);
  };

  const commitFamily: FamilyCommit = (fam, mutate) => {
    mutate(fam);
    rebuildFamily(dataset, fam);
    onDirty("family", fam.id);
    setTick((v) => v + 1);
  };

  function addRelative(kind: "father" | "mother" | "partner" | "child", fam?: Family) {
    if (!person) return;
    const added =
      kind === "partner"
        ? addPartner(dataset, person, fam)
        : kind === "child"
          ? addChild(dataset, person, fam)
          : addParent(dataset, person, fam, kind);

    // Pre-fill surname from family context
    let defaultSurname: string | undefined;
    if (kind === "child") {
      // Inherit from the father of the family the child was added to
      const childFam = added.childOf.map((id) => dataset.families.get(id)).find((f) => f?.husband);
      const father = childFam?.husband ? dataset.individuals.get(childFam.husband) : undefined;
      defaultSurname = (father ? primaryName(father)?.surname : undefined) || undefined;
    } else if (kind === "father") {
      defaultSurname = primaryName(person)?.surname || undefined;
    }
    if (defaultSurname) {
      setName(added, { surname: defaultSurname });
      rebuildIndividual(dataset, added);
    }

    onDirty("individual", person.id);
    onDirty("individual", added.id);
    focusNextName.current = true;
    navigate(added.id);
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
          <button
            className="nav-btn"
            onClick={() => selectedId && onShowTree(selectedId)}
            title={t("edit.tree.tooltip")}
          >
            {t("edit.tree.button")}
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
                onAdd={() => addRelative("father", fam)}
              />
              <div className="edit-connector-h" />
              <PersonCard
                individual={fam?.wife ? dataset.individuals.get(fam.wife) : undefined}
                roleLabel={t("field.mother")}
                placeholder={t("edit.addMother")}
                onSelect={navigate}
                onAdd={() => addRelative("mother", fam)}
              />
            </div>
          ))}
        </div>

        <div className="edit-connector-v" />

        <div className="edit-person">
          <NameEditor
            key={`name-${person.id}`}
            person={person}
            t={t}
            lifespan={lifespan}
            commit={commit}
            focusOnMount={focusNextName.current}
            onMounted={() => { focusNextName.current = false; }}
          />
          <SexToggle key={`sex-${person.id}`} person={person} t={t} commit={commit} />
          <OtherNamesEditor key={`names-${person.id}`} person={person} t={t} commit={commit} />
          <EventList person={person} t={t} commit={commit} />
        </div>

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
                  onAdd={() => addRelative("partner", fam)}
                />
                {fam && <FamilyMarriageRow fam={fam} t={t} commit={commitFamily} />}
                {fam?.events.some((e) => e.tag === "DIV") && <FamilyDivorceRow fam={fam} t={t} commit={commitFamily} />}
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
                    <PersonCard placeholder={t("edit.addChild")} onAdd={() => addRelative("child", fam)} />
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
  focusOnMount,
  onMounted,
}: {
  person: Individual;
  t: Translate;
  lifespan?: string;
  commit: Commit;
  focusOnMount?: boolean;
  onMounted?: () => void;
}) {
  const primary = primaryName(person);
  const [given, setGiven] = useState(primary?.given ?? "");
  const [surname, setSurname] = useState(primary?.surname ?? "");
  const givenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusOnMount) givenRef.current?.focus();
    onMounted?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commitName(nextGiven: string, nextSurname: string) {
    commit((indi) => setName(indi, { given: nextGiven, surname: nextSurname }));
  }

  return (
    <div className="edit-name-row" title={datesTooltipOf(person)}>
      <input
        ref={givenRef}
        className={`edit-input edit-name-input ${sexClass(person.sex)}`}
        style={{ width: fieldWidth(given, t("field.given")) }}
        value={given}
        placeholder={t("field.given")}
        title={t("field.given")}
        onChange={(e) => setGiven(e.target.value)}
        onBlur={() => commitName(given, surname)}
      />
      <input
        className={`edit-input edit-name-input ${sexClass(person.sex)}`}
        style={{ width: fieldWidth(surname, t("field.surname")) }}
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
const SEX_GLYPHS: Record<string, string> = { M: "♂", F: "♀", U: "?" };

function SexToggle({ person, t, commit }: { person: Individual; t: Translate; commit: Commit }) {
  return (
    <div className="edit-sex-row">
      <select
        className={`sex-select ${sexClass(person.sex)}`}
        value={person.sex}
        onChange={(e) => commit((indi) => setSex(indi, e.target.value as Sex))}
      >
        {SEX_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {SEX_GLYPHS[s]} {t(`sex.${s}`)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Nickname plus any further `NAME` records (married/maiden/aka/…), shown as
 * chips that turn into editable fields on click, plus a single "+ Add name"
 * button to append more. */
function OtherNamesEditor({ person, t, commit }: { person: Individual; t: Translate; commit: Commit }) {
  const [editing, setEditing] = useState<"nick" | number | null>(null);
  const primary = primaryName(person);
  const extraNames = person.names.slice(1);

  return (
    <div className="edit-other-names">
      {editing === "nick" ? (
        <NicknameEditor person={person} t={t} commit={commit} onDone={() => setEditing(null)} />
      ) : primary?.nickname ? (
        <button type="button" className="edit-name-chip" onClick={() => setEditing("nick")}>
          {primary.nickname}
          <span className="muted"> · {nameTypeLabel("nick", t)}</span>
        </button>
      ) : null}

      {extraNames.map((n, i) =>
        editing === i ? (
          <NameVariantEditor key={i} person={person} index={i} t={t} commit={commit} onDone={() => setEditing(null)} />
        ) : (
          <button type="button" className="edit-name-chip" key={i} onClick={() => setEditing(i)}>
            {displayName(n)}
            {n.type && <span className="muted"> · {nameTypeLabel(n.type, t)}</span>}
          </button>
        ),
      )}

      <button
        type="button"
        className="edit-name-chip edit-name-chip-add"
        onClick={() => {
          commit((indi) => addAdditionalName(indi, "aka"));
          setEditing(extraNames.length);
        }}
      >
        + {t("edit.addName")}
      </button>
    </div>
  );
}

/** Inline-editable nickname (the primary name's `NICK` sub-tag). */
function NicknameEditor({
  person,
  t,
  commit,
  onDone,
}: {
  person: Individual;
  t: Translate;
  commit: Commit;
  onDone: () => void;
}) {
  const [value, setValue] = useState(primaryName(person)?.nickname ?? "");

  return (
    <span className="edit-name-chip edit-name-chip-editing">
      <input
        className="edit-input edit-name-variant-input"
        style={{ width: fieldWidth(value, t("nametype.nick")) }}
        value={value}
        placeholder={t("nametype.nick")}
        title={t("nametype.nick")}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => commit((indi) => setNickname(indi, value))}
      />
      <button
        type="button"
        className="edit-link-remove"
        title={t("edit.removeName")}
        onClick={() => {
          commit((indi) => setNickname(indi, ""));
          setValue("");
          onDone();
        }}
      >
        ×
      </button>
    </span>
  );
}

/** Inline-editable given/surname/type for an additional `NAME` record
 * (married/maiden/aka/…) — see `setAdditionalName` for indexing. */
function NameVariantEditor({
  person,
  index,
  t,
  commit,
  onDone,
}: {
  person: Individual;
  index: number;
  t: Translate;
  commit: Commit;
  onDone: () => void;
}) {
  const name = person.names[index + 1];
  const [given, setGiven] = useState(name?.given ?? "");
  const [surname, setSurname] = useState(name?.surname ?? "");

  function commitFields(nextGiven: string, nextSurname: string) {
    commit((indi) => setAdditionalName(indi, index, { given: nextGiven, surname: nextSurname }));
  }

  const ref = useRef<HTMLSpanElement>(null);

  return (
    <span
      ref={ref}
      className="edit-name-chip edit-name-chip-editing"
      onBlur={(e) => { if (!ref.current?.contains(e.relatedTarget as Node)) onDone(); }}
    >
      <input
        className="edit-input edit-name-variant-input"
        style={{ width: fieldWidth(given, t("field.given")) }}
        value={given}
        placeholder={t("field.given")}
        title={t("field.given")}
        autoFocus
        onChange={(e) => setGiven(e.target.value)}
        onBlur={() => commitFields(given, surname)}
      />
      <input
        className="edit-input edit-name-variant-input"
        style={{ width: fieldWidth(surname, t("field.surname")) }}
        value={surname}
        placeholder={t("field.surname")}
        title={t("field.surname")}
        onChange={(e) => setSurname(e.target.value)}
        onBlur={() => commitFields(given, surname)}
      />
      <select
        className="edit-input edit-name-type-select"
        value={name?.type ?? "aka"}
        title={t("field.nameType")}
        onChange={(e) => commit((indi) => setAdditionalName(indi, index, { type: e.target.value }))}
      >
        {ADDITIONAL_NAME_TYPES.map((opt) => (
          <option key={opt} value={opt}>
            {nameTypeLabel(opt, t)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="edit-link-remove"
        title={t("edit.removeName")}
        onClick={() => {
          commit((indi) => removeAdditionalName(indi, index));
          onDone();
        }}
      >
        ×
      </button>
    </span>
  );
}

/** Birth/residence/death/burial rows for the center panel, always shown so
 * empty events can be filled in. */
function EventList({ person, t, commit }: { person: Individual; t: Translate; commit: Commit }) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const isShown = (tag: string) => tag === "BIRT" || person.events.some((e) => e.tag === tag) || revealed.has(tag);
  const shown = EVENT_TAGS.filter(isShown);
  const empty = EVENT_TAGS.filter((tag) => !isShown(tag));

  return (
    <div className="edit-events">
      <div className="edit-event-head">
        <span />
        <span>{t("event.colDate")}</span>
        <span>{t("event.colPlace")}</span>
        <span>{t("event.colAddr")}</span>
      </div>
      {shown.map((tag) => (
        <EventRow key={`${person.id}-${tag}`} person={person} tag={tag} t={t} commit={commit} />
      ))}
      {empty.length > 0 && (
        <div className="edit-event-add">
          <span className="edit-event-add-label">{t("event.addLabel")}</span>
          {empty.map((tag) => (
            <button
              key={tag}
              type="button"
              className="add-chip"
              onClick={() => setRevealed((prev) => new Set(prev).add(tag))}
            >
              + {t(`event.${tag}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Editable date/place/address/links for a single event (e.g. `1 BIRT`). */
function EventRow({ person, tag, t, commit }: { person: Individual; tag: string; t: Translate; commit: Commit }) {
  const ev = person.events.find((e) => e.tag === tag);
  const label = t(`event.${tag}`);

  return (
    <EventFieldsRow ev={ev} label={label} t={t} commitField={(update) => commit((indi) => setEventField(indi, tag, update))} />
  );
}

/** Marriage (`1 MARR`) date/place/address/links for a spouse family. */
function FamilyMarriageRow({ fam, t, commit }: { fam: Family; t: Translate; commit: FamilyCommit }) {
  const ev = fam.events.find((e) => e.tag === "MARR");
  const label = t("event.MARR");

  return (
    <EventFieldsRow
      ev={ev}
      label={label}
      t={t}
      commitField={(update) => commit(fam, (f) => setFamilyEventField(f, "MARR", update))}
    />
  );
}

/** Divorce (`1 DIV`) date/place/address/links for a spouse family — only
 * shown when the family already has a DIV event. */
function FamilyDivorceRow({ fam, t, commit }: { fam: Family; t: Translate; commit: FamilyCommit }) {
  const ev = fam.events.find((e) => e.tag === "DIV");
  const label = t("event.DIV");

  return (
    <EventFieldsRow
      ev={ev}
      label={label}
      t={t}
      commitField={(update) => commit(fam, (f) => setFamilyEventField(f, "DIV", update))}
    />
  );
}

function useField(initial: string) {
  const [value, setValue] = useState(initial);
  const init = useRef(initial);
  return {
    value,
    isDirty: value !== init.current,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value),
  };
}

/** Editable date/place/address/links for a single event (individual or
 * family), e.g. `1 BIRT` or `1 MARR`. */
function EventFieldsRow({
  ev,
  label,
  t,
  commitField,
}: {
  ev: GedEvent | undefined;
  label: string;
  t: Translate;
  commitField: (update: EventFieldUpdate) => void;
}) {
  const dateField = useField(ev?.date?.raw ?? "");
  const placeField = useField(ev?.place?.raw ?? "");
  const addrField = useField(ev?.address?.raw ?? "");

  function cls(base: string, isDirty: boolean) {
    return isDirty ? `${base} edit-input--dirty` : base;
  }

  return (
    <div className="edit-event">
      <div className="edit-event-label">{label}</div>
      <input
        className={cls("edit-input edit-event-date", dateField.isDirty)}
        value={dateField.value}
        placeholder={t("event.date", { event: label })}
        title={t("event.date", { event: label })}
        onChange={dateField.onChange}
        onBlur={() => commitField({ date: dateField.value })}
      />
      <input
        className={cls("edit-input edit-event-place", placeField.isDirty)}
        value={placeField.value}
        placeholder={t("event.place", { event: label })}
        title={t("event.place", { event: label })}
        onChange={placeField.onChange}
        onBlur={() => commitField({ place: placeField.value })}
      />
      <input
        className={cls("edit-input edit-event-addr", addrField.isDirty)}
        value={addrField.value}
        placeholder={t("event.addr", { event: label })}
        title={t("event.addr", { event: label })}
        onChange={addrField.onChange}
        onBlur={() => commitField({ address: addrField.value })}
      />
      <LinksEditor links={ev?.links ?? []} label={label} t={t} onCommit={(links) => commitField({ links })} />
    </div>
  );
}

/** A list of single-line link inputs, each removable, plus a "+ Add link"
 * button to append another. */
function LinksEditor({
  links: initialLinks,
  label,
  t,
  onCommit,
}: {
  links: string[];
  label: string;
  t: Translate;
  onCommit: (links: string[]) => void;
}) {
  const [links, setLinks] = useState(initialLinks);

  function commitLinks(next: string[]) {
    setLinks(next);
    onCommit(next.map((l) => l.trim()).filter(Boolean));
  }

  return (
    <div className="edit-links">
      {links.map((link, i) => (
        <div className="edit-link-row" key={i}>
          <input
            className="edit-input edit-link-input"
            value={link}
            placeholder={t("event.link", { event: label })}
            title={t("event.link", { event: label })}
            onChange={(e) => setLinks((prev) => prev.map((l, idx) => (idx === i ? e.target.value : l)))}
            onBlur={() => commitLinks(links)}
          />
          <button
            type="button"
            className="edit-link-remove"
            title={t("edit.removeLink")}
            onClick={() => commitLinks(links.filter((_, idx) => idx !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="edit-link-add" onClick={() => setLinks((prev) => [...prev, ""])}>
        + {t("edit.addLink")}
      </button>
    </div>
  );
}
