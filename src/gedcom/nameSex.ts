import type { Sex } from "./types";
import { isUnknownNameToken } from "./name";

/**
 * A person's sex read off their given name, for records that carry no `SEX` of
 * their own — chiefly the genealogical-index CSV, whose export has no sex
 * column at all (see `src/csv/giMatches.ts`).
 *
 * Deliberately conservative, because a wrong answer is expensive: the matching
 * engine treats a sex disagreement as a hard veto (`sexConflicts`), so an
 * invented sex can silently delete a real candidate. The verdict therefore
 * comes from a name list first, and only one morphological rule is trusted
 * beyond it — the Slovenian feminine `-a` ending, with its male exceptions
 * listed. Anything else stays unknown rather than guessed.
 *
 * Names are compared without diacritics, since the same registers are written
 * both ways ("Jožef"/"Jozef", "Neža"/"Neza").
 */

/** Fold to the form the name lists are keyed by: lower case, no diacritics. */
function fold(token: string): string {
  return token
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/ł/g, "l");
}

function set(names: string): Set<string> {
  return new Set(names.split(/\s+/).filter(Boolean).map(fold));
}

/**
 * Male given names, in the spellings the Slovenian parish registers and their
 * indexes use — Slovenian, plus the Latin and German forms the older books are
 * written in. Names ending in "-a" must be listed here, or the feminine rule
 * below claims them.
 */
const MALE = set(`
  janez ivan johann johannes joannes john juan hans jan
  franc france franci franjo fran francisek franz franciscus francesco
  anton antun antonio tone toncek
  jozef josip joseph josef joze
  jakob jacob jaka jakov jacobus
  martin martinus peter petar petrus
  andrej andrija andreas
  valentin valentino jurij juraj jure georg georgius
  gregor gregorij gregorius jernej bartolomej bartholomaus
  matevz matej matija matjaz mathias matthias matthaus mateo matic
  gasper gaspar kaspar casper
  alojz alojzij alois aloysius lojze
  lovrenc lovro lorenc lavrencij laurentius laurenz
  stefan stjepan stephan stephanus steven
  marko mark marcus pavel pavle paul paulus
  mihael miha mihec miko michael nikolaj nikola niko mikula miklavz nicolaus
  ferdinand ferdo ignac ignacij ignaz ignatius
  stanko stanislav stane leopold rudolf rudi rado
  tomaz tomo thomas ales aleksander alexander sandi
  vincenc vincencij vinko vincentius julij julius janko
  simon simen ciril cyril urban urbanus viktor victor
  florjan florijan florian primoz avgust august avgustin augustin
  igor ludvik ludwig milan jost marijan marjan
  kazimir mirko filip philipp karol karel karlo karl charles
  edvard eduard edward branko zvonimir zvonko drago dragan
  damjan damijan edvin vladislav vladimir vlado
  gabrijel gabriel izidor isidor ksaver xaver
  milos blaz blasius bozidar dimitrije dimitrij
  frank rok albert ernest baltazar balthasar
  sebastijan sebastjan sebastian bostjan anze srecko rajko
  benedikt bernard adam abraham david danijel daniel samuel
  emil ervin oskar oton otmar konrad rihard richard robert roman
  rafael silvester tobija tobias urh ulrich valter walter
  henrik heinrich herman hermann egidij ahac
  luka lukas lucas maks maksimiljan maximilian
  kristijan kristjan christian klemen clemens leon lenart leonhard
  mitja nejc nace fabijan fabian feliks felix gal gorazd gvido hinko
  hubert ivo justin kajetan lado ladislav lambert lucijan
  maver metod ozbolt oswald radovan sigmund ziga sigismund
  teodor theodor tilen timotej tomislav valerij vekoslav velimir
  viljem wilhelm william vitomir zdravko zoran zarko matjaz
  grega toma jura dimitrija ilija kuzma bela
  aljosa vlastja vasja borja fedja fedia zika franta
  kosta ostoja novica sekula nemanja grujica tomica dragisa
  mustafa hamza musa joshua elisha luca
`);

/**
 * Female given names that the "-a" rule cannot reach — the German and Latin
 * forms the older books use, and the Slovenian names built without it.
 */
const FEMALE = set(`
  agnes ingrid karmen carmen edith edit gertrud gertrude jedert
  elizabeth elisabeth elisabet elsbeth margareth margarethe margaret
  mary marie anne sophie therese rosalie julie luise louise
  josephine josefine karoline wilhelmine christine katharine kathrin catherine
  nives ines doris rut ruth judit karin fani fanny mimi rezi mici
  ingeborg ester esther jozefin
`);

/**
 * Names that are male in one tradition and female in another, or too often
 * both — never worth a guess.
 */
const AMBIGUOUS = set(`
  sasa vanja ivica andrea aleksa jovica nikica misa nicola nikita
  jasa asa sava pepi petja
`);

/** The Marian first name the Catholic books give to sons as well as daughters —
 *  "Maria KARL EUGEN von Neipperg" is a man. It settles nothing on its own when
 *  another name part follows it. */
const MARIAN = set("maria marija mary marie");

/** True for a token that is not a name at all: a placeholder, or an initial. */
function isNotAName(token: string): boolean {
  return isUnknownNameToken(token) || /^\p{L}\.?$/u.test(token) || !/\p{L}/u.test(token);
}

/** The verdict for one name token, if it has one. */
function sexFromToken(token: string): Sex | undefined {
  if (isNotAName(token)) return undefined;
  const folded = fold(token.replace(/[()[\]{}.,;]/g, ""));
  if (!folded || AMBIGUOUS.has(folded)) return undefined;
  if (MALE.has(folded)) return "M";
  if (FEMALE.has(folded)) return "F";
  // The one rule trusted beyond the lists: a Slovenian given name ending in
  // "-a" is female unless it is one of the male names listed above.
  if (folded.length >= 3 && folded.endsWith("a")) return "F";
  return undefined;
}

/**
 * The sex a given name states, or `undefined` when the name doesn't settle it.
 *
 * Which part of a multi-part given name is read matters more than the lists do,
 * so two conventions of the church books are honoured:
 *
 *  - the call name written in capitals among ordinary-case parts
 *    ("Maria BENEDIKT Reinhard von Neipperg" is a man) is the part that counts;
 *  - a leading Marian name is skipped when other parts follow, since sons were
 *    given it too.
 *
 * Otherwise the *first* real part decides and later parts are not consulted: a
 * man's Marian or saint's second name ("Johann Maria") would otherwise make a
 * woman of him — measured against real files, reading on was most of the errors.
 */
export function sexFromGivenName(given: string | undefined): Sex | undefined {
  const parts = (given ?? "").split(/[\s\-‐-―]+/).filter((p) => p && !isNotAName(p));
  if (!parts.length) return undefined;

  // The call name, where the writer marked it in capitals and wrote the rest
  // ordinarily. A file that capitalises *every* given name says nothing by it,
  // and falls through to the parts in order.
  const shouted = parts.filter((p) => p === p.toUpperCase() && p !== p.toLowerCase());
  if (shouted.length && shouted.length < parts.length) {
    const sex = sexFromToken(shouted[0]);
    if (sex) return sex;
  }

  const first = parts[0];
  if (parts.length > 1 && MARIAN.has(fold(first))) return sexFromToken(parts[1]) ?? sexFromToken(first);
  return sexFromToken(first);
}
