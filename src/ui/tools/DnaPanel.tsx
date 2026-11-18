import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import {
  PLACE_LEVELS,
  ancestorSurnames,
  directLine,
  earliestKnown,
  ftdnaSurnameRows,
  placeAt,
  placeCountry,
  type LineSide,
  type LineStep,
  type PlaceLevel,
} from "../../tools/dna";
import { toCsv } from "../../stats/csv";
import { downloadText, savedName } from "../download";
import { PersonLink } from "../PersonLink";
import { StartPersonSelector } from "../StartPersonSelector";
import { PickerMenu } from "../PickerMenu";
import { InfoTip, ToolsIntro } from "./shared";

const GENERATION_CHOICES = [0, 3, 4, 5, 6, 7, 8, 10, 12];
const SIDES: LineSide[] = ["paternal", "maternal"];
/** Ancestors named in a surname row before the rest are counted. */
const SHOWN_ANCESTORS = 3;

/** A value with a button that puts it on the clipboard, for pasting into a DNA site's form. */
function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="tools-dna-field">
      <span className="tools-dna-field-label">{label}</span>
      <span className="tools-dna-field-value">{value || "—"}</span>
      <button type="button" className="nav-btn tools-dna-copy" disabled={!value} onClick={copy}>
        {copied ? t("tools.dna.copied") : t("tools.dna.copy")}
      </button>
    </div>
  );
}

function stepYears(s: LineStep, t: (k: string, o?: Record<string, unknown>) => string): string {
  const birth = s.birthYear !== undefined ? `${s.birthApprox ? "~" : ""}${s.birthYear}` : "";
  if (s.deathYear !== undefined) return `${birth}–${s.deathYear}`;
  return birth || t("tools.dna.noYears");
}

function LineCard({
  dataset,
  side,
  line,
  pickedId,
  onPick,
  onNavigate,
}: {
  dataset: Dataset;
  side: LineSide;
  line: LineStep[];
  pickedId: string | undefined;
  onPick: (id: string | undefined) => void;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const auto = earliestKnown(line);
  const eka = line.find((s) => s.id === pickedId) ?? auto;
  const place = placeAt(eka?.place, "locality");
  const country = placeCountry(eka?.place);
  const name = [eka?.given, eka?.surname].filter(Boolean).join(" ");
  const oneLine = eka
    ? [name, eka.birthYear !== undefined ? t("tools.dna.born", { year: eka.birthYear }) : "", place, country].filter(Boolean).join(", ")
    : "";

  return (
    <section className="tools-privacy-group tools-dna-line">
      <div className="tools-privacy-legend">{t(`tools.dna.line.${side}`)}</div>
      {line.length === 0 ? (
        <p className="muted">{t(`tools.dna.line.empty.${side}`)}</p>
      ) : (
        <>
          <div className="tools-dna-eka">
            <span className="tools-publish-label">
              <span className="tools-dna-eka-title">{t("tools.dna.eka")}</span>
              <InfoTip hint={t("tools.dna.ekaHint")} />
            </span>
            {eka ? (
              <>
                <CopyField label={t("tools.dna.field.given")} value={eka.given ?? ""} />
                <CopyField label={t("tools.dna.field.surname")} value={eka.surname ?? ""} />
                <CopyField label={t("tools.dna.field.birthYear")} value={eka.birthYear !== undefined ? String(eka.birthYear) : ""} />
                <CopyField label={t("tools.dna.field.place")} value={place} />
                <CopyField label={t("tools.dna.field.country")} value={country} />
                <CopyField label={t("tools.dna.field.all")} value={oneLine} />
              </>
            ) : (
              <p className="muted">{t("tools.dna.eka.none")}</p>
            )}
          </div>
          <ol className="tools-dna-steps">
            {line.map((s) => (
              <li key={s.id} className={s.usable ? undefined : "muted"}>
                <label className="tools-dna-step">
                  <input
                    type="radio"
                    name={`dna-eka-${side}`}
                    checked={eka?.id === s.id}
                    disabled={!s.usable}
                    title={t("tools.dna.useAsEka")}
                    onChange={() => onPick(s.id === auto?.id ? undefined : s.id)}
                  />
                  <span className="tools-dna-gen">{t("tools.dna.gen", { n: s.generation })}</span>
                </label>
                <span className="tools-dna-step-body">
                  <PersonLink dataset={dataset} id={s.id} fallback={s.id} onNavigate={onNavigate} noYears />
                  <span className="muted"> · {stepYears(s, t)}</span>
                  {!s.surname && <span className="muted"> · {t("tools.dna.noSurname")}</span>}
                  {!s.given && <span className="muted"> · {t("tools.dna.noGiven")}</span>}
                  {s.place && (
                    <span className="tools-dna-step-place muted">
                      {placeAt(s.place, "full")}
                      {s.placeTag && s.placeTag !== "BIRT" && ` (${t(`tools.dna.placeFrom.${s.placeTag}`)})`}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

export function DnaPanel({
  dataset,
  fileName,
  startId,
  editVersion,
  onNavigate,
}: {
  dataset: Dataset;
  fileName: string;
  startId?: string;
  editVersion: number;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [ownRoot, setOwnRoot] = useState<string | undefined>();
  const rootId = ownRoot && dataset.individuals.has(ownRoot) ? ownRoot : startId && dataset.individuals.has(startId) ? startId : undefined;
  const [maxGenerations, setMaxGenerations] = useState(0);
  const [place, setPlace] = useState<PlaceLevel>("localityCountry");
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<Partial<Record<LineSide, string>>>({});

  // A new person is a new list: what was unticked or picked for the last one does not carry over.
  useEffect(() => {
    setExcluded(new Set());
    setPicked({});
  }, [rootId]);

  const lines = useMemo(
    () => (rootId ? { paternal: directLine(dataset, rootId, "paternal"), maternal: directLine(dataset, rootId, "maternal") } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the dataset mutates in place; editVersion marks the change
    [dataset, rootId, editVersion],
  );
  const rows = useMemo(
    () => (rootId ? ancestorSurnames(dataset, rootId, { maxGenerations, place }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
    [dataset, rootId, maxGenerations, place, editVersion],
  );
  const chosen = rows.filter((r) => !excluded.has(r.key));
  const allOn = chosen.length === rows.length;

  const toggle = (key: string) =>
    setExcluded((s) => {
      const n = new Set(s);
      if (!n.delete(key)) n.add(key);
      return n;
    });

  function download() {
    // FamilyTreeDNA reads the header row by name, so the file goes without the
    // byte-order mark a spreadsheet would want: it would sit in front of "Surname".
    const csv = toCsv(ftdnaSurnameRows(chosen), { separator: "," }).replace(/^﻿/, "");
    downloadText(savedName(fileName, "ftdna-surnames.csv"), csv, "text/csv;charset=utf-8");
  }

  return (
    <div className="tools-dna">
      <ToolsIntro>{t("tools.dna.intro")}</ToolsIntro>

      <div className="tools-privacy-group">
        <div className="tools-privacy-legend">{t("tools.dna.person")}</div>
        <StartPersonSelector
          individuals={dataset.individuals}
          version={editVersion}
          startId={rootId}
          onChange={setOwnRoot}
          placeholder={t("tools.dna.pick")}
          tooltip={t("tools.dna.personHint")}
          onStartClick={ownRoot && ownRoot !== startId ? () => setOwnRoot(undefined) : undefined}
          startClickTitle={t("stats.startReset")}
        />
      </div>

      {!rootId || !lines ? (
        <p className="muted">{t("tools.dna.noPerson")}</p>
      ) : (
        <>
          <div className="tools-dna-lines">
            {SIDES.map((side) => (
              <LineCard
                key={side}
                dataset={dataset}
                side={side}
                line={lines[side]}
                pickedId={picked[side]}
                onPick={(id) => setPicked((p) => ({ ...p, [side]: id }))}
                onNavigate={onNavigate}
              />
            ))}
          </div>

          <section className="tools-privacy-group">
            <div className="tools-privacy-legend">{t("tools.dna.surnames")}</div>
            <div className="tools-privacy-inline">
              <span className="tools-privacy-inline">
                {t("tools.dna.generations")}
                <PickerMenu
                  items={GENERATION_CHOICES.map((n) => ({ key: String(n), label: n === 0 ? t("tools.dna.generations.all") : String(n) }))}
                  value={String(maxGenerations)}
                  onChange={(k) => setMaxGenerations(Number(k))}
                  label={t("tools.dna.generations")}
                />
              </span>
              <span className="tools-privacy-inline">
                {t("tools.dna.placeLevel")}
                <PickerMenu
                  items={PLACE_LEVELS.map((p) => ({ key: p, label: t(`tools.dna.placeLevel.${p}`) }))}
                  value={place}
                  onChange={setPlace}
                  label={t("tools.dna.placeLevel")}
                />
              </span>
              <InfoTip hint={t("tools.dna.placeHint")} />
            </div>
            {rows.length === 0 ? (
              <p className="muted">{t("tools.dna.noSurnames")}</p>
            ) : (
              <>
                <div className="tools-dna-actions">
                  <button type="button" className="nav-btn primary" disabled={chosen.length === 0} onClick={download}>
                    {t("tools.dna.download")}
                  </button>
                  <span className="muted">{t("tools.dna.selected", { n: chosen.length, total: rows.length })}</span>
                  <InfoTip hint={t("tools.dna.downloadHint")} />
                </div>
                <div className="tools-dna-table-wrap">
                  <table className="stats-table tools-dna-table">
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            checked={allOn}
                            title={t("tools.dna.selectAll")}
                            onChange={() => setExcluded(allOn ? new Set(rows.map((r) => r.key)) : new Set())}
                          />
                        </th>
                        <th>{t("tools.dna.col.surname")}</th>
                        <th>{t("tools.dna.col.location")}</th>
                        <th>{t("tools.dna.col.ancestors")}</th>
                        <th>{t("tools.dna.col.born")}</th>
                        <th>{t("tools.dna.col.gen")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key} className={excluded.has(r.key) ? "muted" : undefined}>
                          <td>
                            <input type="checkbox" checked={!excluded.has(r.key)} onChange={() => toggle(r.key)} />
                          </td>
                          <td>{r.surname}</td>
                          <td>{r.location}</td>
                          <td>
                            {r.personIds.slice(0, SHOWN_ANCESTORS).map((id, i) => (
                              <span key={id} className="tools-dna-person">
                                {i > 0 && ", "}
                                <PersonLink dataset={dataset} id={id} fallback={id} onNavigate={onNavigate} noYears />
                              </span>
                            ))}
                            {r.personIds.length > SHOWN_ANCESTORS && (
                              <span className="muted"> {t("tools.dna.more", { n: r.personIds.length - SHOWN_ANCESTORS })}</span>
                            )}
                          </td>
                          <td className="tools-dna-num">
                            {r.fromYear === undefined ? "" : r.fromYear === r.toYear ? r.fromYear : `${r.fromYear}–${r.toYear}`}
                          </td>
                          <td className="tools-dna-num">{r.generation}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
