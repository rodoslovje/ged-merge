// The per-language grammar of the narrative report. Sentence templates live
// in the locale files (narrative.* keys); everything here is the closed-class
// grammar that plain string interpolation can't express — date phrases with
// their case-bearing prepositions, pronouns, list joining, count words.
// Open-class words (place names, personal names) are deliberately NEVER
// inflected: Slovenian declines proper names too, so places render inside a
// nominative-safe frame ("v kraju X") and spouses are named predicatively by
// the sl templates ("njegova žena je bila X").

import type { GedDate, Sex } from "../../gedcom/types";
import type { Language } from "../../locales/i18n";

export interface NarrativeLang {
  lang: Language;
  /**
   * A structured date as a prose phrase including its preposition:
   *  en: "on 5 May 1848" · "in May 1848" · "in 1848" · "about 1848" ·
   *      "before 5 May 1848" · "between 1848 and 1850"
   *  sl: "5. maja 1848" · "maja 1848" · "leta 1848" · "okoli leta 1848" ·
   *      "pred 5. majem 1848" · "med letoma 1848 in 1850"
   * Unparseable dates fall back to the raw text; deliberate all-unknown
   * placeholders render as "".
   */
  datePhrase(d: GedDate): string;
  /** The location inside a nominative-safe frame. A street address reads
   *  postal-style, a bare place gets the locality frame:
   *  en: "at Dunajska 5, Kranj" · "at Dunajska 5" · "in Kranj"
   *  sl: "na naslovu Dunajska 5, Kranj" · "na naslovu Dunajska 5" · "v kraju Kranj".
   *  At least one argument is set when called. */
  placePhrase(addr: string | undefined, place: string | undefined): string;
  /** The short subject: en "He"/"She"; sl "" (the verb form carries it). */
  pronoun(sex: Sex): string;
  /** "Ana, Franc and Jožefa" / "Ana, Franc in Jožefa". */
  nameList(names: string[]): string;
  /** "{n} children" with the language's plural (and, for Slovenian, the
   *  accusative case after "imeti"): "one child" / "4 children" —
   *  "1 otroka" / "2 otroka" / "3 otroke" / "5 otrok". */
  childCount(n: number): string;
}
