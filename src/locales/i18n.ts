import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./en";
import { sl } from "./sl";

export const SUPPORTED_LANGUAGES = ["en", "sl"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Minimal shape of react-i18next's `t()` shared by helpers that take it. */
export type Translate = (key: string, opts?: Record<string, unknown>) => string;

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

// Dev only: the bundles above are handed to i18next once, at init. A hot update
// to a locale file therefore replaces the module while i18next keeps the old
// copy, and a key added in that edit renders as its own name until the page is
// reloaded by hand — which reads as a missing translation rather than a stale
// one. Re-register on every hot update instead. Stripped from the build.
if (import.meta.hot) {
  import.meta.hot.accept(["./en", "./sl"], (mods) => {
    const [nextEn, nextSl] = mods as [{ en: typeof en } | undefined, { sl: typeof sl } | undefined];
    i18n.addResourceBundle("en", "translation", nextEn?.en ?? en, true, true);
    i18n.addResourceBundle("sl", "translation", nextSl?.sl ?? sl, true, true);
    void i18n.changeLanguage(i18n.language); // nudge the listeners into re-rendering
  });
}

export default i18n;
