import i18n from "i18next";
import { initReactI18next } from "react-i18next";

const resources = {
  en: {
    translation: {
      "lang.en": "English",
      "lang.sl": "Slovenian",
      "app.title": "GedMerge",
      "app.subtitle": "Compare and merge GEDCOM files entirely in your browser. Nothing is uploaded.",
      "section.load": "Load GEDCOM",
      "section.compare": "Compare",
      "section.matches": "Matches",
      "load.master": "Master GEDCOM",
      "load.incoming": "Incoming GEDCOM",
      "matches.individuals": "Individuals",
      "matches.families": "Families",
      "matches.calculating": "Calculating matches…",
      "matches.empty": "Load both files to calculate matches.",
      "compare.empty": "No match selected — pick one from the Matches list.",
      "nav.prev": "Previous match (Keyboard shortcut: ← or ↑)",
      "nav.next": "Next match (Keyboard shortcut: → or ↓)",
      "nav.pos": "{{current}} of {{total}}",
    },
  },
  sl: {
    translation: {
      "lang.en": "Angleščina",
      "lang.sl": "Slovenščina",
      "app.title": "GedMerge",
      "app.subtitle": "Primerjaj in združi GEDCOM datoteke v brskalniku. Nič se ne prenaša v oblak.",
      "section.load": "Naloži GEDCOM",
      "section.compare": "Primerjava",
      "section.matches": "Ujemanja",
      "load.master": "Glavni GEDCOM",
      "load.incoming": "Vhodni GEDCOM",
      "matches.individuals": "Osebe",
      "matches.families": "Družine",
      "matches.calculating": "Računanje ujemanj…",
      "matches.empty": "Naložite obe datoteki za izračun ujemanj.",
      "compare.empty": "Nobeno ujemanje ni izbrano — izberite ga s seznama ujemanj.",
      "nav.prev": "Prejšnje ujemanje (Bližnjica: ← ali ↑)",
      "nav.next": "Naslednje ujemanje (Bližnjica: → ali ↓)",
      "nav.pos": "{{current}} od {{total}}",
    },
  },
};

// Detect the user's browser language (e.g. 'en-US' -> 'en') and fallback to 'en' if not supported.
const browserLang = navigator.language.split("-")[0];
const defaultLang = Object.keys(resources).includes(browserLang) ? browserLang : "en";

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: defaultLang,
    fallbackLng: "en",
    interpolation: {
      escapeValue: false, // React already inherently protects from XSS
    },
  });

export default i18n;