/**
 * Fixed pseudonym vocabulary shared by the corpus generator
 * (`scripts/anonymize-corpus.ts`) and the round-trip / match regression tests.
 *
 * The generator replaces every real given/surname with a token from here:
 *   - within a file, the same real name always maps to the same fake one
 *     (family groupings survive); and
 *   - across files, two unrelated families never share a surname *nor a
 *     fuzzy-similar one* — which keeps the cross-family precision test honest
 *     (a shared or look-alike vocabulary would manufacture phantom "strong"
 *     matches between unrelated people, since surname is the engine's gate).
 *
 * Surnames are built stem × ending. The stems are mutually dissimilar, and the
 * generator hands each fixture a *contiguous block of whole stems*, so
 * same-stem look-alikes (e.g. "Ambrožič"/"Ambrožek") only ever co-occur inside
 * one file, never across two. The tests assert every personal-name token in the
 * committed fixtures comes from this vocabulary — a tripwire against a source
 * file leaking a real name.
 */

// ~90 ordinary Slovenian given names. Given-name collisions across files are
// harmless (the surname gate rejects the pair first), so this list stays short.
export const GIVEN_NAMES = [
  "Ana", "Marija", "Ivan", "Jožef", "Franc", "Marko", "Tone", "Neža", "Alojz",
  "Terezija", "Peter", "Katarina", "Anton", "Uršula", "Matija", "Helena",
  "Lovro", "Barbara", "Miha", "Rozalija", "Jakob", "Ema", "Andrej", "Frančiška",
  "Martin", "Julijana", "Jurij", "Apolonija", "Blaž", "Marjeta", "Valentin",
  "Agata", "Simon", "Lucija", "Gašper", "Magdalena", "Luka", "Elizabeta",
  "Tomaž", "Marta", "Filip", "Angela", "Pavel", "Cecilija", "Boštjan",
  "Veronika", "Nace", "Ivana", "Štefan", "Johana", "Vinko", "Amalija", "Rok",
  "Danijela", "Karel", "Zofija", "Janez", "Alojzija", "Mihael", "Jera",
  "Sebastijan", "Kristina", "Urban", "Klara", "Ferdinand", "Ljudmila", "Ignac",
  "Karolina", "Bernard", "Genovefa", "Matevž", "Suzana", "Primož", "Dorotea",
  "Aleš", "Regina", "Benjamin", "Silvester", "Margareta", "Adolf", "Egidij",
  "Fortunat", "Marina", "Valburga", "Kajetan", "Emerik", "Nežka", "Cvetka",
] as const;

// Mutually-dissimilar surname stems (distinct initials, no near-duplicates), so
// that a stem from one file's block never fuzzy-matches a stem from another's.
const SUR_STEMS = [
  "Ambrož", "Berdnik", "Cvetko", "Dolinar", "Erjavec", "Ferjan", "Golob",
  "Hafner", "Intihar", "Jenko", "Kobal", "Lampič", "Mrak", "Novljan", "Oblak",
  "Pirc", "Ramovš", "Sever", "Tavčar", "Uršič", "Verbič", "Zajec", "Žnidar",
  "Bregar", "Cizelj", "Debevec", "Fabjan", "Gruden", "Hrovat", "Jamnik",
  "Kregar", "Logar", "Medved", "Nastran", "Osolnik", "Pučnik", "Rozman",
  "Slabe", "Tomšič", "Vodnik", "Zupan", "Bizjak", "Cerar", "Dovžan", "Frelih",
  "Gostiša", "Hribar", "Jerman", "Koder", "Lah", "Mohar", "Nemec", "Okorn",
  "Peternel", "Rihar", "Skubic", "Trošt", "Vidmar", "Zorko", "Blatnik",
  "Čebulj", "Drnovšek", "Furlan", "Grebenc", "Kavčič", "Lesjak", "Merela",
  "Notar", "Pavlin", "Resnik", "Šraj", "Vrečko",
];
const SUR_ENDINGS = [
  "ič", "ek", "ar", "nik", "šek", "nc", "man", "ovec", "in", "el", "nič",
  "ovič", "ak", "več", "iček", "njak",
];

/** Surnames per stem — the granularity at which the generator allocates blocks. */
export const STEM_SIZE = SUR_ENDINGS.length;

// Stem-major order (all of stem 0's endings, then stem 1's, …) so a contiguous
// slice is a whole number of stems. Unique by construction (distinct stems ×
// distinct endings), so no dedup that would misalign the blocks.
export const SURNAMES: string[] = SUR_STEMS.flatMap((s) => SUR_ENDINGS.map((e) => s + e));

/** Lowercased set of every allowed name word (given name or generated surname). */
export const ALLOWED_NAME_WORDS = new Set(
  [...GIVEN_NAMES, ...SURNAMES].map((w) => w.toLowerCase()),
);
