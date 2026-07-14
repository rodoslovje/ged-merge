import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";
import { useSettings, useNameOf } from "./SettingsContext";
import { xrefLabel, type NameOrder } from "../gedcom/nameDisplay";
import type { PersonName } from "../gedcom/types";
import { SUPPORTED_LANGUAGES } from "../locales/i18n";
import { PROXY_HOSTS } from "../normalize/urlMetadata";
import { sexClass } from "./sex";

export type ThemeMode = "auto" | "light" | "dark";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  /** Wipe the cached workspace (loaded files + merge session) from IndexedDB. */
  onClearCache: () => void;
}

type SettingsTab = "general" | "advanced";
const SETTINGS_TABS: SettingsTab[] = ["general", "advanced"];

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
export function SettingsModal({ isOpen, onClose, themeMode, onThemeMode, onClearCache }: Props) {
  const { t, i18n } = useTranslation();
  const { settings, set } = useSettings();
  const nameOf = useNameOf();
  const ref = useModalKeyboard(isOpen, onClose);
  const [tab, setTab] = useState<SettingsTab>("general");

  if (!isOpen) return null;

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
                  {t("settings.links.fetch.relays", { list: PROXY_HOSTS.join(", ") })}
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
