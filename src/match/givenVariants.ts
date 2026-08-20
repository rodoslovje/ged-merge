import { foldToken, jaroWinkler } from "./text";

/**
 * Cross-language equivalents of one given name.
 *
 * Parish registers are kept in Latin (and, in these lands, German), while the
 * tree built from them carries the Slovenian form: the same child is
 * "Bartholomeus" in the book and "Jernej" at home. Spelling similarity cannot
 * see that — `Neža`/`Agnes` share no letters in Jaro-Winkler's matching window
 * and score a flat **0.000**, `Jurij`/`Georg` 0.47, `Jera`/`Gertrud` 0.60 —
 * so without this table the given name, the one part that tells siblings
 * apart, contributes nothing to a Latin-vs-Slovenian comparison and the
 * surname plus the birth year are left to carry the identity alone.
 *
 * Each row lists the forms of a single name, already folded the way
 * {@link foldToken} folds them (lowercase, no diacritics). Membership of one
 * row means "the same name in another language or era", scored as an exact
 * match. Short forms belong to their full name's row when a record may carry
 * either for the same person (`Rudi` for Rudolf, `Meta` for Marjeta, `Polona`
 * for Apolonija, `Reza` for Terezija) — between children the given name is the
 * whole comparison, so a short form left out of the table shows one child as
 * two. Names that merely share a root but name two different children —
 * `Matej` vs `Matija`, `Neža` vs `Ana` — are deliberately in separate rows.
 */
const VARIANT_GROUPS: readonly (readonly string[])[] = [
  // male
  ["andrej", "andreas", "andrija", "andrew", "andre"],
  ["anton", "antonius", "antonij", "antun", "tone"],
  ["alojz", "aloysius", "alois", "lojze"],
  ["baltazar", "balthasar", "balthasarus"],
  ["blaz", "blasius", "blasij"],
  ["bostjan", "sebastian", "sebastianus", "sebastijan"],
  ["bernard", "bernardus", "bernhard"],
  ["ciril", "cyrillus", "cyrill"],
  ["danijel", "daniel", "danielis"],
  ["filip", "philippus", "philipp", "philip"],
  ["florijan", "florianus", "florian"],
  ["franc", "franciscus", "franz", "francisek", "franjo", "france", "fran", "franci"],
  ["gasper", "gaspar", "casparus", "kaspar", "caspar"],
  ["gregor", "gregorius", "gregorij"],
  ["ignacij", "ignatius", "ignac", "ignaz", "nace"],
  ["jakob", "jacobus", "jakov", "jacob", "jaka"],
  ["janez", "joannes", "johannes", "joanes", "ioannes", "johann", "ivan", "hans", "anze", "janko"],
  ["jernej", "bartholomeus", "bartholomaeus", "bartholomaus", "bartolomej", "bartol"],
  ["jozef", "josephus", "joseph", "josef", "joze", "josip", "jozeph"],
  ["jurij", "georgius", "georg", "jure", "juri", "juraj", "george"],
  ["karel", "carolus", "karl", "karol", "karlo"],
  ["kristijan", "christianus", "christian", "kristjan"],
  ["lenart", "leonardus", "leonhard", "lenard"],
  ["leopold", "leopoldus"],
  ["lovrenc", "laurentius", "lorenz", "lovro"],
  ["ludvik", "ludovicus", "ludwig"],
  ["luka", "lucas", "lukas"],
  ["maksimilijan", "maximilianus", "maximilian", "maks", "max"],
  ["marko", "marcus", "markus"],
  ["martin", "martinus"],
  ["matej", "matthaeus", "mattheus", "matthaus", "matevz"],
  ["matija", "matthias", "mathias", "matthia"],
  ["mihael", "michael", "mihail", "michel", "miha", "miko"],
  ["miklavz", "nicolaus", "nikolaj", "nikola", "niklas"],
  ["pavel", "paulus", "paul", "pavle", "pavao"],
  ["peter", "petrus"],
  ["primoz", "primus"],
  ["rok", "rochus", "roch"],
  ["rudolf", "rudolphus", "rudolph", "rudi"],
  ["simon", "simeon"],
  ["stefan", "stephanus", "stephan", "stjepan"],
  ["tomaz", "thomas", "toma", "tomo"],
  ["urban", "urbanus"],
  ["valentin", "valentinus"],
  ["vid", "vitus"],
  ["vincenc", "vincentius", "vinko", "vincenz"],
  // female
  ["ana", "anna"],
  ["alojzija", "aloysia"],
  ["antonija", "antonia"],
  ["apolonija", "apollonia", "polona", "polonija"],
  ["barbara", "barbe"],
  ["brigita", "brigida", "birgitta"],
  ["cecilija", "caecilia", "cecilia"],
  ["doroteja", "dorothea"],
  ["elizabeta", "elisabetha", "elisabeth", "elizabeth", "spela"],
  ["eva", "ewa"],
  ["franciska", "francisca", "franziska"],
  ["genovefa", "genoveva"],
  ["gertruda", "gertrudis", "gertrud", "jera"],
  ["helena", "helene", "jelena"],
  ["johana", "joanna", "johanna", "ivana"],
  ["jozefa", "josepha", "josipa"],
  ["julijana", "juliana"],
  ["karolina", "carolina"],
  ["katarina", "catharina", "katharina", "catarina", "katra", "kata"],
  ["kristina", "christina"],
  ["lucija", "lucia", "luzia"],
  ["magdalena", "magdalene"],
  ["marija", "maria"],
  ["marjana", "mariana", "marianna"],
  ["marjeta", "margaretha", "margareta", "margaret", "margarita", "meta"],
  ["neza", "agnes", "agnetha", "agneza", "agnesa"],
  ["rozalija", "rosalia", "rozalia"],
  ["suzana", "susanna", "susana"],
  ["terezija", "theresia", "theresa", "teresa", "tereza", "reza", "rezka"],
  ["urska", "ursula", "urszula"],
  ["veronika", "veronica"],
  ["viktorija", "victoria"],
];

const VARIANT_KEYS: Map<string, number> = (() => {
  const m = new Map<string, number>();
  VARIANT_GROUPS.forEach((group, i) => group.forEach((name) => m.set(name, i)));
  return m;
})();

/** The equivalence group a folded given-name token belongs to, or undefined
 *  when the name isn't in the table (most names aren't — they only need one). */
export function givenVariantKey(token: string): number | undefined {
  return VARIANT_KEYS.get(token);
}

/**
 * Similarity of two *given-name tokens*: spelling distance, except that two
 * forms of one name (see {@link VARIANT_GROUPS}) count as the same name
 * whatever their spelling. Inputs are folded here, so callers may pass raw or
 * already-folded tokens.
 */
export function givenTokenSimilarity(a: string, b: string): number {
  const fa = foldToken(a);
  const fb = foldToken(b);
  if (fa === fb) return 1;
  const ka = givenVariantKey(fa);
  return ka !== undefined && ka === givenVariantKey(fb) ? 1 : jaroWinkler(fa, fb);
}
