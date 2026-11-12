/**
 * Video 8 (SCENARIJI.md, "Združevanje"): complete your tree from another
 * researcher's file — merge the people both trees hold, then choose, field by
 * field, what to take. Shown with the series display (France as the start
 * person, kinship with the direct line in bold, ages), so every pair says how
 * it is related to France.
 *
 * Real, historical data: the main file is France Prešeren's pedigree from Peter
 * Hawlina's tree as episode 6 leaves it — places as settlement, municipality,
 * country with GURS coordinates, house numbers in the address
 * (`preseren-hawlina-geo.ged`); the incoming file is the same family from
 * contributor Odar's tree in the Slovenian genealogical index, with house
 * numbers inside the place ("Vrba 2, (stara hš 1)", "Kranj 181"), which the
 * merge reshapes to the main file's form.
 *
 * Comparison rows are selected by `data-row-key` (stable, language-neutral).
 * The field choice buttons (`.choice.main` / `.incoming` / `.both`) are locked
 * until the pair is confirmed, so every pair is confirmed before choosing.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import { seriesSettingsWithMaps } from "../lib/series.ts";
import type { Scenario } from "../lib/types.ts";

const DEMO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo");
const MAIN = path.join(DEMO, "preseren-hawlina-geo.ged");
const INCOMING = path.join(DEMO, "preseren-odar.ged");

const row = (d: Director, key: string) => d.page.locator(`.compare-panel tr[data-row-key${key}]`);
const confirm = (d: Director) => d.page.locator(".compare-name-decisions button").first();
const candidate = (d: Director, name: string) => d.page.locator(".candidate", { hasText: name });
/** The kinship filter (»Vse osebe ▾«) above the match list, and one of its options. */
const kinFilter = (d: Director) => d.page.locator(".kin-select").filter({ visible: true }).first();
const menuItem = (d: Director, text: string) =>
  d.page.locator("[role=menuitem], [role=option], .dd-item").filter({ visible: true }).filter({ hasText: new RegExp(`^\\W*${text}\\W*$`) }).first();
const pickKin = async (d: Director, label: { sl: string; en: string }) => {
  await d.click(kinFilter(d));
  await d.wait(700);
  await d.click(menuItem(d, d.t(label)));
  await d.wait(900);
};

const scenario: Scenario = {
  id: "merge",
  episode: 8,
  settings: seriesSettingsWithMaps,
  title: {
    sl: "GED Merge: dopolnite svoje drevo s podatki iz druge datoteke GEDCOM",
    en: "GED Merge: complete your family tree with data from another GEDCOM file",
  },
  description: {
    sl: "Kako v GED Merge združite podatke dveh raziskovalcev iste rodbine: odprete obe datoteki, potrdite pare oseb, ki so v obeh, pri vsakem podatku izberete, ali obdržite svojega, prevzamete vhodnega ali obdržite oba, in shranite dopolnjeno datoteko. Primer: rodbina Franceta Prešerna iz rodovnikov Petra Hawline in prispevkarja Odar (Slovenski rodoslovni indeks).",
    en: "How to combine two researchers' work on the same family in GED Merge: open both files, confirm the pairs of people who appear in both, choose for each value whether to keep yours, take the incoming one or keep both, and save the completed file. Example: France Prešeren's family from the pedigrees of Peter Hawlina and of contributor Odar (Slovenian genealogical index).",
  },
  thumbnail: {
    tag: { sl: "Združevanje oseb", en: "Merging people" },
    title: { sl: "Dopolnite *drevo* iz druge datoteke", en: "Complete your *tree* from another file" },
  },
  steps: [
    {
      say: {
        sl: "Dva raziskovalca sta raziskovala isto rodbino, rodbino pesnika Franceta Prešerna. Pokažimo, kako njune podatke združite v eno drevo.",
        en: "Two researchers have studied the same family: the family of the poet France Prešeren. Let's combine their work into one tree.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Dopolnite svoje drevo iz druge datoteke", en: "Complete your tree from another file" },
          { sl: "Združevanje oseb in prevzemanje podatkov", en: "Merging people and taking over their data" },
        );
      },
    },
    {
      callout: { sl: "Glavna in vhodna datoteka", en: "Main and incoming file" },
      say: {
        sl: "Odprite svojo datoteko. To je glavna datoteka, vanjo se zapišejo prevzeti podatki. Kraji v njej so že urejeni in geokodirani.",
        en: "Open your own file. This is the main file; the data you take over is written into it. Its places are already tidied and geocoded.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(600);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(800);
        await d.highlight(d.page.locator(".edit-person .edit-event-place").first(), 4);
        await d.wait(2500);
        await d.highlight(d.page.locator(".edit-person-map").first(), 6);
      },
    },
    {
      say: {
        sl: "Na zavihku »Združevanje« odprite drugo drevo, tokrat iz Slovenskega rodoslovnega indeksa. To je vhodna datoteka: iz nje samo prevzemate podatke.",
        en: "On the Merge tab, open the other tree, this one from the Slovenian genealogical index. This is the incoming file: you only take data from it.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(d.page.locator(".seg-btn").nth(1));
        await d.wait(1500);
        await d.upload(d.page.locator(".dropzone").last(), INCOMING);
        await d.page.locator(".candidate").first().waitFor();
      },
    },
    {
      callout: { sl: "Seznam ujemanj", en: "The match list" },
      say: {
        sl: "GED Merge poišče osebe, ki so v obeh drevesih, in jih na levi ponudi kot pare. Vsak par ima stopnjo ujemanja, sestavljeno iz imen, datumov, krajev in sorodnikov.",
        en: "GED Merge finds the people who are in both trees and lists them on the left as pairs. Each pair has a match score, built from names, dates, places and relatives.",
      },
      run: async (d) => {
        await d.highlight(d.page.locator(".candidate-list"));
        await d.wait(4500);
        await d.highlight(d.page.locator(".candidate").first().locator(".badge").first(), 4);
      },
    },
    {
      callout: { sl: "Sorodstvo do izhodiščne osebe", en: "Kinship to the start person" },
      say: {
        sl: "Pod imenom piše, v kakšnem sorodu je oseba s Prešernom. Njegovi neposredni predniki, oče, dedek in praded, so poudarjeni, zato takoj vidite, kje v drevesu ste.",
        en: "Under each name you see how the person is related to Prešeren. His direct ancestors, his father, grandfather and great-grandfather, are in bold, so you always know where in the tree you are.",
      },
      run: async (d) => {
        await d.highlight(candidate(d, "Jernej").locator(".candidate-kinship"), 4);
        await d.wait(3500);
        await d.highlight(candidate(d, "Jelovšek").locator(".candidate-kinship"), 4);
      },
    },
    {
      say: {
        sl: "Seznam lahko zožite, na primer samo na Prešernove prednike. Mi bomo pregledali vse pare, zato filter vrnemo na »Vse osebe«.",
        en: "You can narrow the list down, for example to Prešeren's ancestors only. We'll go through all the pairs, so we set the filter back to All people.",
      },
      run: async (d) => {
        await d.highlight(null);
        await pickKin(d, { sl: "Predniki", en: "Ancestors" });
        await d.highlight(d.page.locator(".candidate-list"));
        await d.wait(2500);
        await d.highlight(null);
        await pickKin(d, { sl: "Vse osebe", en: "All people" });
        await d.click(candidate(d, "France"));
      },
    },
    {
      callout: { sl: "Primerjava para", en: "Comparing a pair" },
      say: {
        sl: "Desno je primerjava para: levo so vaši podatki, desno podatki iz vhodne datoteke. Drugo drevo pozna Prešernov krst v Breznici in pokop v Kranju. Novi podatki so obarvani zeleno.",
        en: "On the right is the pair side by side: your data on the left, the incoming data on the right. The other tree knows Prešeren's baptism in Breznica and his burial in Kranj. New data is shaded green.",
      },
      run: async (d) => {
        await d.highlight(d.page.locator(".compare-panel table").first(), 4);
        await d.wait(4500);
        await d.highlight(row(d, '="BAPM.place"'));
        await d.wait(2500);
        const burial = row(d, '="BURI.date"');
        await d.scrollTo(burial);
        await d.highlight(burial);
      },
    },
    {
      say: {
        sl: "Ob datumih so izpisane starosti: ob smrti 48 let, ob rojstvu pa starost očeta in matere. Tako hitro opazite datum, ki ne more biti pravilen.",
        en: "Next to the dates you see ages: 48 at his death, and at his birth the ages of his father and mother. A date that cannot be right stands out at once.",
      },
      run: async (d) => {
        const birth = row(d, '="BIRT.date"');
        await d.scrollTo(birth);
        await d.highlight(birth);
        await d.wait(3500);
        await d.highlight(row(d, '="DEAT.date"'));
      },
    },
    {
      say: {
        sl: "Drugo drevo zapiše hišno številko kar v kraj: Vrba 2, stara hišna številka 1. GED Merge kraj samodejno prepiše v obliko vaše datoteke: naselje, občina in država, hišna številka pa gre v naslov. Zato se kraj ujema, nov je samo naslov.",
        en: "The other tree writes the house number into the place itself: Vrba 2, old house number 1. GED Merge rewrites it in your file's form on its own: settlement, municipality and country, with the house number moved to the address. So the place agrees, and only the address is new.",
      },
      run: async (d) => {
        const place = row(d, '="BIRT.place"');
        await d.scrollTo(place);
        await d.highlight(place);
        await d.wait(5500);
        await d.highlight(row(d, '="BIRT.addr"'));
        await d.wait(3500);
        const death = row(d, '="DEAT.addr"');
        await d.scrollTo(death);
        await d.highlight(death);
      },
    },
    {
      callout: { sl: "Potrdite par", en: "Confirm the pair" },
      say: {
        sl: "Podatke izbirate šele pri potrjenem paru. Dokler ga ne potrdite, so gumbi za izbiro zaklenjeni. Ker gre za isto osebo, kliknite »Potrdi«.",
        en: "You can choose data only once a pair is confirmed; until then, the choice buttons are locked. Since this is the same person, click Confirm.",
      },
      run: async (d) => {
        await d.point(row(d, '="BIRT.addr"').locator(".choice.incoming"));
        await d.wait(2500);
        await d.highlight(null);
        await d.click(confirm(d));
      },
    },
    {
      callout: { sl: "Izberite podatke", en: "Choose the data" },
      say: {
        sl: "Zdaj pri vsakem podatku izberete, od kod se vzame. Z gumbom G ohranite podatek iz glavne datoteke, z gumbom V prevzamete podatek iz vhodne. Novi podatki, kot je naslov rojstne hiše, so že izbrani.",
        en: "Now, for each value, you choose where it comes from. The M button keeps the value from the main file, and I takes the one from the incoming file. New data, such as the address of the house he was born in, is already selected.",
      },
      run: async (d) => {
        const place = row(d, '="BIRT.addr"');
        await d.highlight(place);
        await d.wait(2000);
        await d.point(place.locator(".choice.main"));
        await d.wait(1500);
        await d.click(place.locator(".choice.incoming"));
      },
    },
    {
      say: {
        sl: "Pri Prešernovem očetu se drevesi razlikujeta v imenu: Šimen in Simon. Potrdite par in z gumbom O obdržite obe obliki imena.",
        en: "For Prešeren's father, the trees differ in the name: Šimen and Simon. Confirm the pair, and with the B button keep both forms of the name.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(candidate(d, "Šimen"));
        const given = row(d, '="given"');
        await d.highlight(given);
        await d.wait(2500);
        await d.click(confirm(d));
        await d.click(given.locator(".choice.both"));
        await d.snapshot();
      },
    },
    {
      callout: { sl: "Sorodnik v primerjavi", en: "A relative in the comparison" },
      say: {
        sl: "Tudi Šimnova mati ima v drevesih dve imeni: pri vas je Mina, v drugem drevesu Marija. Mina je domača oblika imena Marija. S klikom na ime odprete njen par.",
        en: "Šimen's mother, too, goes by two names: Mina in your tree, Marija in the other. Mina is a familiar form of Marija. Click her name to open her pair.",
      },
      run: async (d) => {
        const mother = row(d, '="mother"');
        await d.scrollTo(mother);
        await d.highlight(mother);
        await d.wait(4500);
        await d.highlight(null);
        await d.click(mother.locator(".rel-incoming .person-link"));
      },
    },
    {
      say: {
        sl: "To je Prešernova babica. Datum rojstva in smrti se ujemata, zato gre za isto osebo. Potrdite par in obdržite obe obliki imena.",
        en: "This is Prešeren's grandmother. Her birth and death dates agree, so this is the same person. Confirm the pair and keep both forms of her name.",
      },
      run: async (d) => {
        await d.highlight(d.page.locator(".person-kinship").first(), 4);
        await d.wait(2500);
        const birth = row(d, '="BIRT.date"');
        await d.highlight(birth);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(confirm(d));
        await d.click(row(d, '="given"').locator(".choice.both"));
      },
    },
    {
      say: {
        sl: "Ko se vrnete k Šimnu, se zdaj ujema tudi vrstica »Mati«, saj gre v obeh drevesih za isto osebo.",
        en: "Back at Šimen, the Mother row now agrees too: both trees name the same person.",
      },
      run: async (d) => {
        await d.click(candidate(d, "Šimen"));
        const mother = row(d, '="mother"');
        await d.scrollTo(mother);
        await d.highlight(mother);
      },
    },
    {
      callout: { sl: "Nove osebe", en: "New people" },
      say: {
        sl: "Ana Jelovšek ima v drugem drevesu starša, ki ju pri vas ni: Martina Jelovška in Marijo Bobek. Ko par potrdite, se oba takoj dodata v vaše drevo, kar pove oznaka »dodano«.",
        en: "In the other tree, Ana Jelovšek has parents your tree lacks: Martin Jelovšek and Marija Bobek. When you confirm the pair, both are added to your tree at once, marked Added.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(candidate(d, "Jelovšek"));
        const father = row(d, '="father"');
        await d.scrollTo(father);
        await d.highlight(father);
        await d.wait(3500);
        await d.highlight(null);
        await d.click(confirm(d));
        await d.wait(500);
        await d.highlight(row(d, '="mother"'));
      },
    },
    {
      say: {
        sl: "Drugo drevo pozna tudi drugo ženo Janeza Prešerna, Marijo Triplat. Ob potrditvi se doda kot nova družina.",
        en: "The other tree also knows Janez Prešeren's second wife, Marija Triplat. Confirming adds her as a new family.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(candidate(d, "Janez"));
        const partner = d.page.locator(".compare-panel tr[data-row-key]", { hasText: "Triplat" });
        await d.scrollTo(partner);
        await d.highlight(partner);
        await d.wait(3500);
        await d.highlight(null);
        await d.click(confirm(d));
      },
    },
    {
      callout: { sl: "Primerjalno drevo", en: "Compare Tree" },
      say: {
        sl: "Primerjalno drevo pokaže obe drevesi skupaj. Barva vsake osebe pove, ali se drevesi ujemata, se razlikujeta ali je oseba samo v enem od njiju. Pod imenom je tudi tu sorodstvo s Prešernom.",
        en: "The Compare Tree shows both trees together. Each person's colour tells you whether the trees agree, differ, or have the person in only one of them. Here too, each name shows the kinship to Prešeren.",
      },
      run: async (d) => {
        await d.click(candidate(d, "France"));
        await d.click(d.page.locator(".tree-open-btn").filter({ visible: true }).first());
        await d.wait(2000);
        await d.highlight(d.page.locator(".tree-legend").filter({ visible: true }).first(), 4);
        await d.wait(5000);
        await d.highlight(null);
        await d.wait(3500);
        await d.page.keyboard.press("Escape");
      },
    },
    {
      callout: { sl: "Shranite dopolnjeno datoteko", en: "Save the completed file" },
      say: {
        sl: "Na koncu kliknite »Shrani GEDCOM«. Predogled pokaže vse spremembe, preden se zapišejo v datoteko.",
        en: "Finally, click Save GEDCOM. A preview lists every change before it is written to the file.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".app-head-actions .export-btn"));
        await d.wait(2500);
        await d.page.mouse.move(960, 500);
        await d.page.mouse.wheel(0, 300);
      },
    },
    {
      say: {
        sl: "Kliknite »Prenesi GEDCOM« in dopolnjeno drevo se shrani kot nova datoteka. Izvirna datoteka ostane nespremenjena.",
        en: "Click Download GEDCOM and your completed tree is saved as a new file. Your original file stays as it was.",
      },
      run: async (d) => {
        const download = d.page.locator(".preview-actions .export-btn");
        await d.highlight(download);
        await d.wait(1500);
        await d.click(download);
        await d.highlight(null);
      },
    },
    {
      callout: null,
      say: {
        sl: "GED Merge je vaš rodoslovni program v brskalniku. V njem urejate drevo, ga dopolnjujete iz drugih datotek ter rišete diagrame in zemljevide. Je brezplačen, ne potrebuje računa, najdete pa ga na naslovu gedmerge.com.",
        en: "GED Merge is your genealogy program in the browser. You edit your tree, complete it from other files, and draw charts and maps. It is free, needs no account, and you will find it at gedmerge.com.",
      },
      run: async (d) => {
        await d.overlay("hideCursor");
        await d.card(
          { sl: "Brezplačno · brez računa · v brskalniku", en: "Free · no account · in your browser" },
          { sl: "GED Merge — vaš rodoslovni program", en: "GED Merge — your genealogy program" },
          { sl: "gedmerge.com", en: "gedmerge.com" },
        );
      },
    },
  ],
};

export default scenario;
