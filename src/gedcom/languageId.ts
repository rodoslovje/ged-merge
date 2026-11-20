/**
 * GEDCOM 5.5.1's language names and the language tags GEDCOM 7.0 writes for
 * them.
 *
 * 5.5.1 names a language by a word from its own closed list (`LANGUAGE_ID`:
 * `1 LANG Slovene` on a submitter or the header); 7.0 writes a BCP 47 tag
 * (`1 LANG sl`). The list below is 5.5.1's, word for word — its spellings
 * included (`Belorusian`, `Mandrin`, `Pusto`, `Serbo_Croa`) — each with the
 * tag for that language. A few names files write that the list does not have
 * (`Slovenian`, `Croatian`) are read too, and written as the list's own word
 * where it has one.
 */
const LANGUAGE_IDS: ReadonlyArray<readonly [name: string, tag: string]> = [
  ["Afrikaans", "af"], ["Albanian", "sq"], ["Amharic", "am"], ["Anglo-Saxon", "ang"], ["Arabic", "ar"],
  ["Armenian", "hy"], ["Assamese", "as"], ["Belorusian", "be"], ["Bengali", "bn"], ["Braj", "bra"],
  ["Bulgarian", "bg"], ["Burmese", "my"], ["Cantonese", "yue"], ["Catalan", "ca"], ["Catalan_Spn", "ca-ES"],
  ["Church-Slavic", "cu"], ["Czech", "cs"], ["Danish", "da"], ["Dogri", "doi"], ["Dutch", "nl"],
  ["English", "en"], ["Esperanto", "eo"], ["Estonian", "et"], ["Faroese", "fo"], ["Finnish", "fi"],
  ["French", "fr"], ["Georgian", "ka"], ["German", "de"], ["Greek", "el"], ["Gujarati", "gu"],
  ["Hawaiian", "haw"], ["Hebrew", "he"], ["Hindi", "hi"], ["Hungarian", "hu"], ["Icelandic", "is"],
  ["Indonesian", "id"], ["Italian", "it"], ["Japanese", "ja"], ["Kannada", "kn"], ["Khmer", "km"],
  ["Konkani", "kok"], ["Korean", "ko"], ["Lahnda", "lah"], ["Lao", "lo"], ["Latvian", "lv"],
  ["Lithuanian", "lt"], ["Macedonian", "mk"], ["Maithili", "mai"], ["Malayalam", "ml"], ["Mandrin", "cmn"],
  ["Manipuri", "mni"], ["Marathi", "mr"], ["Mewari", "mtr"], ["Navaho", "nv"], ["Nepali", "ne"],
  ["Norwegian", "no"], ["Oriya", "or"], ["Pahari", "him"], ["Pali", "pi"], ["Panjabi", "pa"],
  ["Persian", "fa"], ["Polish", "pl"], ["Portuguese", "pt"], ["Prakrit", "pra"], ["Pusto", "ps"],
  ["Rajasthani", "raj"], ["Romanian", "ro"], ["Russian", "ru"], ["Sanskrit", "sa"], ["Serb", "sr"],
  ["Serbo_Croa", "sh"], ["Slovak", "sk"], ["Slovene", "sl"], ["Spanish", "es"], ["Swedish", "sv"],
  ["Tagalog", "tl"], ["Tamil", "ta"], ["Telugu", "te"], ["Thai", "th"], ["Tibetan", "bo"],
  ["Turkish", "tr"], ["Ukrainian", "uk"], ["Urdu", "ur"], ["Vietnamese", "vi"], ["Wendic", "wen"],
  ["Yiddish", "yi"],
];

/** Names files write for a language that 5.5.1's list spells otherwise, or
 *  does not have. Read only: the way down writes the list's own word. */
const OTHER_NAMES: ReadonlyArray<readonly [name: string, tag: string]> = [
  ["Slovenian", "sl"], ["Croatian", "hr"], ["Serbian", "sr"], ["Bosnian", "bs"], ["Belarusian", "be"],
  ["Mandarin", "cmn"], ["Pashto", "ps"], ["Punjabi", "pa"], ["Navajo", "nv"], ["Serbo-Croatian", "sh"],
];

const TAG_OF = new Map<string, string>(
  [...LANGUAGE_IDS, ...OTHER_NAMES].map(([name, tag]) => [name.toLowerCase(), tag]),
);
const NAME_OF = new Map<string, string>(LANGUAGE_IDS.map(([name, tag]) => [tag.toLowerCase(), name]));

/** The 7.0 language tag for a 5.5.1 language name (`Slovene` → `sl`);
 *  undefined for a value that is no such name — a tag already, or a word the
 *  list does not know. */
export function languageTagOf(name: string | undefined): string | undefined {
  return name ? TAG_OF.get(name.trim().toLowerCase()) : undefined;
}

/** The 5.5.1 language name for a 7.0 language tag (`sl`, `sl-SI` → `Slovene`);
 *  undefined when 5.5.1's list has no word for the language. */
export function languageNameOf(tag: string | undefined): string | undefined {
  const value = tag?.trim().toLowerCase();
  if (!value) return undefined;
  return NAME_OF.get(value) ?? NAME_OF.get(value.split("-")[0]);
}
