import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./en";
import { sl } from "./sl";

export const SUPPORTED_LANGUAGES = ["en", "sl"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

const STORAGE_KEY = "gedmerge.lang";

/** Initial language: a saved choice, else the browser's, else English. */
function detectLanguage(): Language {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && (SUPPORTED_LANGUAGES as readonly string[]).includes(saved)) {
    return saved as Language;
  }
  const nav = navigator.language.slice(0, 2).toLowerCase();
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(nav) ? (nav as Language) : "en";
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    sl: { translation: sl },
  },
  lng: detectLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false }, // React already escapes
});

// Remember the user's language choice across sessions.
i18n.on("languageChanged", (lng) => localStorage.setItem(STORAGE_KEY, lng));

export default i18n;
