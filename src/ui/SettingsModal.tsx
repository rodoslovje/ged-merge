import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";
import { useSettings, useNameOf } from "./SettingsContext";
import { xrefLabel, type NameOrder } from "../gedcom/nameDisplay";
import type { PersonName } from "../gedcom/types";
import { SUPPORTED_LANGUAGES } from "../locales/i18n";
import { PROXY_HOSTS } from "../normalize/urlMetadata";
import { DATE_PATTERN_CHOICES, type FormatOverrides } from "../normalize/formatOverrides";
import { detectFormatDefaults, sampleDateFor } from "../normalize/formatDefaults";
import type { Dataset } from "../gedcom/types";
import { sexClass } from "./sex";

export type ThemeMode = "auto" | "light" | "dark";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  /** Wipe the cached workspace (loaded files + merge session) from IndexedDB. */
  onClearCache: () => void;
  /** The loaded main file, for the Format tab's "Auto (detected)" examples. */
  mainDataset?: Dataset;
}

type SettingsTab = "general" | "format" | "advanced";
const SETTINGS_TABS: SettingsTab[] = ["general", "format", "advanced"];

/** One format dimension: a select whose first option is "Detected" (= no
 *  override) and whose value patches a single {@link FormatOverrides} key. */
interface FormatDimension {
  key: keyof FormatOverrides;
  /** Choice values; option labels come from `settings.format.{key}.{value}`
   *  unless the value is `verbatim` (shown as-is, e.g. date patterns). */
  choices: readonly string[];
  verbatim?: boolean;
}

/** The Format tab's dimensions, grouped for display. Matricula's own
 *  language form offers exactly those five languages; the Geneanet list
 *  mirrors GENEANET_CEMETERY_LOCALES (the locales the rewriter knows). */
const FORMAT_GROUPS: { group: string; dims: FormatDimension[] }[] = [
  {
    group: "dates",
    dims: [
      { key: "date", choices: DATE_PATTERN_CHOICES, verbatim: true },
      { key: "datePlaceholder", choices: ["none", "_", "?"] },
    ],
  },
  {
    group: "names",
    dims: [
      { key: "names", choices: ["records", "tags"] },
      { key: "unknownName", choices: ["blank", "NN", "N.N.", "_____"] },
    ],
  },
  {
    group: "places",
    dims: [{ key: "place", choices: ["packed-plac", "structured-addr", "plain-structured", "address-only"] }],
  },
  {
    group: "sources",
    dims: [
      { key: "sourceLayout", choices: ["paginated", "repository", "literature", "inline"] },
      { key: "citations", choices: ["event", "record"] },
      { key: "pageMedia", choices: ["event", "source"] },
      { key: "baptism", choices: ["BIRT", "BAPM"] },
      { key: "doubledLinks", choices: ["fold", "keep"] },
      { key: "matriculaLang", choices: ["sl", "de", "en", "cs", "it"], verbatim: true },
      { key: "geneanetLang", choices: ["en", "de", "es", "fi", "fr", "it", "nl", "no", "pt", "sv"], verbatim: true },
    ],
  },
];

/** Concrete, language-neutral samples of what each choice writes — shown
 *  between the row's label and its dropdown (GEDCOM-shaped where that is the
 *  clearest way to show structure). Dates and link languages are rendered
 *  from the value instead. */
const FORMAT_SAMPLES: Partial<Record<keyof FormatOverrides, Record<string, string>>> = {
  datePlaceholder: { none: "JUN 1879", _: "__.06.1879", "?": "??.06.1879" },
  place: {
    "structured-addr": "Kranj,Slovenija › ADDR Cesta 1",
    "packed-plac": "Cesta 1, Kranj (Slovenija)",
    "plain-structured": "Kranj,Slovenija",
    "address-only": "Cesta 1",
  },
  names: { records: "1 NAME › 2 TYPE married", tags: "2 _MARNM Kovač" },
  sourceLayout: {
    paginated: "0 SOUR › 1 OBJE ×N",
    repository: "0 SOUR › 1 REPO",
    literature: "1 AUTH, 1 PUBL",
    inline: '2 SOUR "…"',
  },
  citations: { event: "1 BIRT › 2 SOUR", record: "1 SOUR" },
  pageMedia: { event: "2 SOUR + 2 OBJE", source: "0 SOUR › 1 OBJE" },
  baptism: { BIRT: "1 BIRT › 2 SOUR", BAPM: "1 BAPM › 2 SOUR" },
  doubledLinks: { fold: "1 BIRT › 2 WWW", keep: "1 WWW + 2 WWW" },
};

const THEME_MODES: ThemeMode[] = ["auto", "light", "dark"];
const LANG_LABELS: Record<string, string> = { en: "🇬🇧 English", sl: "🇸🇮 Slovenščina" };

/** Sample person used by the live name-display preview — a married woman so the
 * married-surname, order and uppercase options are all visible at once. */
const SAMPLE_NAME: PersonName = { full: "Ana Novak", given: "Ana", surname: "Novak", married: "Kovač" };
const SAMPLE_XREF = "@I42@";
const SAMPLE_LIFESPAN = "1850–1920";
const SAMPLE_AGE = 70;

/**
 * General settings: name-display preferences, the record-id toggle, and the
 * opt-in for online link-metadata lookups. Preferences live in
 * {@link useSettings} and persist to localStorage.
 */
export function SettingsModal({ isOpen, onClose, themeMode, onThemeMode, onClearCache, mainDataset }: Props) {
  const { t, i18n } = useTranslation();
  const { settings, set } = useSettings();
  const nameOf = useNameOf();
  const ref = useModalKeyboard(isOpen, onClose);
  const [tab, setTab] = useState<SettingsTab>("general");
  // What "Auto (detected)" resolves to, shown as the per-row example. Only
  // worth computing with the modal open on the Format tab (a few tree walks).
  const detected = useMemo(
    () => (isOpen && tab === "format" && mainDataset ? detectFormatDefaults(mainDataset) : undefined),
    [isOpen, tab, mainDataset],
  );

  if (!isOpen) return null;

  /** Concrete sample of the row's *effective* value (the override when set,
   *  else the detected habit — the latter only while a main file is loaded). */
  const formatExample = ({ key }: FormatDimension): string | undefined => {
    const effective = settings.formatOverrides[key] ?? detected?.[key];
    if (!effective) return undefined;
    if (key === "date") return sampleDateFor(effective);
    if (key === "unknownName") return effective === "blank" ? "/Kovač/" : `${effective} /Kovač/`;
    if (key === "matriculaLang") return `…online.eu/${effective}/…`;
    if (key === "geneanetLang") return `${effective}.geneanet.org`;
    return FORMAT_SAMPLES[key]?.[effective];
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal settings-modal"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{t("settings.title")}</h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")} aria-label={t("help.close")}>
            ×
          </button>
        </div>
        <div className="settings-tabs" role="tablist" aria-label={t("settings.title")}>
          {SETTINGS_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {t(`settings.tab.${id}`)}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {tab === "general" && (
          <>
          <section className="settings-section">
            <h3>{t("settings.language.title")}</h3>
            <div className="settings-radio-row">
              {SUPPORTED_LANGUAGES.map((lng) => (
                <label key={lng} className="settings-radio">
                  <input
                    type="radio"
                    name="settings-language"
                    value={lng}
                    checked={i18n.language === lng}
                    onChange={() => i18n.changeLanguage(lng)}
                  />
                  <span className="settings-row-label">{LANG_LABELS[lng] ?? lng}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h3>{t("settings.appearance.title")}</h3>
            <div className="settings-radio-row">
              {THEME_MODES.map((mode) => (
                <label key={mode} className="settings-radio">
                  <input
                    type="radio"
                    name="settings-theme"
                    value={mode}
                    checked={themeMode === mode}
                    onChange={() => onThemeMode(mode)}
                  />
                  <span className="settings-row-label">{t(`settings.theme.${mode}`)}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h3>{t("settings.name.title")}</h3>

            <div className="settings-preview">
              <span className="settings-preview-label">{t("settings.name.preview")}</span>
              <span className="settings-preview-person">
                <span className={`person-name ${sexClass("F")}`}>{nameOf(SAMPLE_NAME)}</span>
                {settings.showXref && <span className="person-xref gm-data">{xrefLabel(SAMPLE_XREF)}</span>}
                <span className="person-years gm-data">{settings.showAge ? `${SAMPLE_LIFESPAN} (${SAMPLE_AGE})` : SAMPLE_LIFESPAN}</span>
              </span>
            </div>

            <fieldset className="settings-radio-group">
              <legend className="settings-row-label">{t("settings.name.order")}</legend>
              <div className="settings-radio-row">
              {(["given-surname", "surname-given"] as NameOrder[]).map((order) => (
                <label key={order} className="settings-radio">
                  <input
                    type="radio"
                    name="settings-name-order"
                    value={order}
                    checked={settings.order === order}
                    onChange={() => set({ order })}
                  />
                  <span className="settings-row-label">
                    {t(order === "given-surname" ? "settings.name.order.givenSurname" : "settings.name.order.surnameGiven")}
                  </span>
                </label>
              ))}
              </div>
            </fieldset>

            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.uppercaseSurname}
                onChange={(e) => set({ uppercaseSurname: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.name.uppercase")}</span>
                <span className="settings-hint">{t("settings.name.uppercase.hint")}</span>
              </span>
            </label>

            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.marriedSurname}
                onChange={(e) => set({ marriedSurname: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.name.married")}</span>
                <span className="settings-hint">{t("settings.name.married.hint")}</span>
              </span>
            </label>
          </section>

          <section className="settings-section">
            <h3>{t("settings.display.title")}</h3>
            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.showKinship}
                onChange={(e) => set({ showKinship: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.display.kinship")}</span>
                <span className="settings-hint">{t("settings.display.kinship.hint")}</span>
              </span>
            </label>

            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.showXref}
                onChange={(e) => set({ showXref: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.display.xref")}</span>
                <span className="settings-hint">{t("settings.display.xref.hint")}</span>
              </span>
            </label>

            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.showAge}
                onChange={(e) => set({ showAge: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.display.age")}</span>
                <span className="settings-hint">{t("settings.display.age.hint")}</span>
              </span>
            </label>
          </section>
          </>
          )}

          {tab === "format" && (
          <>
          {FORMAT_GROUPS.map(({ group, dims }) => (
            <section key={group} className="settings-section settings-format-group">
              <h3>{t(`settings.format.group.${group}`)}</h3>
              {dims.map(({ key, choices, verbatim }) => (
                <label key={key} className="settings-row settings-format-row" title={t(`settings.format.${key}.hint`)}>
                  <span className="settings-row-label">{t(`settings.format.${key}`)}</span>
                  <span className="settings-format-example gm-data">{formatExample({ key, choices, verbatim })}</span>
                  <select
                    value={(settings.formatOverrides[key] as string | undefined) ?? ""}
                    onChange={(e) => {
                      const next = { ...settings.formatOverrides };
                      if (e.target.value) next[key] = e.target.value as never;
                      else delete next[key];
                      set({ formatOverrides: next });
                    }}
                  >
                    <option value="">{t("settings.format.detected")}</option>
                    {choices.map((c) => (
                      <option key={c} value={c}>
                        {(verbatim ? c : t(`settings.format.${key}.${c}`)) +
                          // The month-word layouts are the GEDCOM-standard date
                          // form (spec day is 1–2 digits); numeric layouts are
                          // vendor conventions. <option> can't be styled, so
                          // the marker is part of the label.
                          (key === "date" && (c === "D MMM YYYY" || c === "DD MMM YYYY")
                            ? ` — ${t("settings.format.gedcomStandard")}`
                            : "")}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </section>
          ))}
          </>
          )}

          {tab === "advanced" && (
          <>
          <section className="settings-section">
            <h3>{t("settings.links.title")}</h3>
            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.allowLinkFetch}
                onChange={(e) => set({ allowLinkFetch: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.links.fetch")}</span>
                <span className="settings-hint">{t("settings.links.fetch.hint")}</span>
                <span className="settings-hint">
                  {t("settings.links.fetch.relays")}{" "}
                  {PROXY_HOSTS.map((host, i) => (
                    <span key={host}>
                      {i > 0 && ", "}
                      <a href={`https://${host}/`} target="_blank" rel="noreferrer">
                        {host}
                      </a>
                    </span>
                  ))}
                  {". "}
                  {t("settings.links.fetch.relaysNote")}
                </span>
              </span>
            </label>
          </section>

          <section className="settings-section">
            <h3>{t("settings.data.title")}</h3>
            <label className="settings-row settings-row-toggle">
              <input
                type="checkbox"
                checked={settings.persistWorkspace}
                onChange={(e) => set({ persistWorkspace: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{t("settings.data.persist")}</span>
                <span className="settings-hint">{t("settings.data.persist.hint")}</span>
              </span>
            </label>
            {settings.persistWorkspace && (
              <div className="settings-row">
                <span className="settings-row-text">
                  <span className="settings-row-label">{t("settings.data.clear")}</span>
                  <span className="settings-hint">{t("settings.data.clear.hint")}</span>
                </span>
                <button type="button" className="settings-danger-btn" onClick={onClearCache}>
                  {t("settings.data.clear")}
                </button>
              </div>
            )}
          </section>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
