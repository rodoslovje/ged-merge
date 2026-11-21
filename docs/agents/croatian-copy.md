# Writing Croatian copy

Read it before writing any Croatian: `src/locales/hr.ts`, `src/report/lang/hr.ts`, the `hr` meanings in `src/gedcom/vendorTags.ts` / `extensionTerms.ts`. The User's Guide, changelog and legal pages have no Croatian version yet; a Croatian reader is sent to the English ones.

Translate from the English meaning. `sl.ts` is the key-for-key reference for the gender (`_M` / `_F` / `_Mp` / `_Fp`) and case (`_gen`) variants, which Croatian shares with Slovenian. Grep `hr.ts` for a term before writing it: one concept, one name. When a string quotes a button or a menu path, copy the label letter for letter from `hr.ts`.

## Language

- **Standard Croatian (ijekavian)**, never Serbian or Bosnian forms: *tisuća* (not *hiljada*), *tjedan* (not *sedmica*), *povijest*, *računalo*, *datoteka*, *tko*, *točka*, *uvjet*, *obitelj* (not *porodica*), *preglednik*, *izbornik*, *postavke*, *odaberite* (not *izaberite*), *spremi*.
- Infinitive constructions, not *da* + present (*želite li spremiti*).
- Prose addresses the reader with polite lower-case **vi**; never *ti*. Button and menu labels are bare imperatives: *Spremi*, *Odustani*, *Zatvori*, *Učitaj*, *Preuzmi*, *Primijeni*, *Poništi*, *Ponovi*, *Ukloni*. Confirm questions speak in the app's first person (*Uklonim …?*) or as *Želite li …?*.
- Quotes are „…“; asides take a spaced em-dash —; a label's ellipsis is attached (*Učitaj…*).
- Ordinals and years carry a dot: *5. svibnja 1848.* The narrative report folds the year's dot into a sentence's full stop.
- Months, nominative / genitive: siječanj/siječnja, veljača/veljače, ožujak/ožujka, travanj/travnja, svibanj/svibnja, lipanj/lipnja, srpanj/srpnja, kolovoz/kolovoza, rujan/rujna, listopad/listopada, studeni/studenoga, prosinac/prosinca.

## Plurals and variants

i18next uses `Intl.PluralRules("hr")`, which has three categories: **one** (1, 21, 31 … but not 11), **few** (2–4, 22–24 … but not 12–14) and **other** (0, 5–20, 25 …). A counted key gets exactly `_one`, `_few` and `_other` (never `_two`; `keys.test.ts` checks it). Because `_one` also covers 21, 31 …, a Croatian `_one` may show `{{count}}` where the Slovenian singular does not.

## Placeholders

Keep every `{{placeholder}}` of the Slovenian twin (`keys.test.ts` checks it); `{{meaningSl}}` becomes `{{meaningHr}}`. Never decline a name through a gendered participle next to it, and give a count with no plural keys the colon shape (*uklonjeno: {{n}}*). GEDCOM tags and product names stay as they are.

## Terminology

| English | Croatian |
|---|---|
| Merge / Edit / Tools (modes) | Spajanje / Uređivanje / Alati |
| main file / incoming file | glavna datoteka / ulazna datoteka |
| match / match score | podudaranje / stupanj podudaranja |
| chart | dijagram |
| start person | polazna osoba |
| health check (Validate) | Provjera |
| duplicates / kept record | duplikati / zadržani zapis |
| Normalize & batch | Ujednači i skupno uredi |
| privacy scrub | prikriti |
| website (Publish) | Web-stranica |
| record / person / family / event | zapis / osoba / obitelj / događaj |
| source / citation / repository | izvor / navod / spremište |
| note / media | bilješka / mediji |
| place / address / gazetteer | mjesto / adresa / imenik mjesta |
| map / map dot / pin | karta / točkica / pribadača |
| generation / root | generacija / korijen |
| ancestors / descendants / blood relatives | preci / potomci / krvni srodnici |
| preset | predložak |
| undo / redo / apply | Poništi / Ponovi / Primijeni |
| settings / download / load | Postavke / preuzmi / učitaj |
| plain text file / Report (chart kind) | tekstualna datoteka / tekstualno izvješće |
| baptism / burial / godparent | krštenje / pokop / kum, kuma |
| living / deceased | živ / preminuo |

## Undo

As in English and Slovenian: no "you can undo it" in a new string (see [merging.md](merging.md)).
