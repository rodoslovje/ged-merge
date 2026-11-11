/**
 * Video 7 (SCENARIJI.md): complete your tree from another researcher's file —
 * merge the people both trees hold, then choose, field by field, what to take.
 *
 * Real, historical data: the main file is France Prešeren's pedigree from Peter
 * Hawlina's tree, the incoming file the same family from contributor Odar's
 * tree in the Slovenian genealogical index (videos/demo/).
 *
 * Comparison rows are selected by `data-row-key` (stable, language-neutral).
 * The field choice buttons (`.choice.main` / `.incoming` / `.both`) are locked
 * until the pair is confirmed, so every pair is confirmed before choosing.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import type { Scenario } from "../lib/types.ts";

const DEMO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo");
const MAIN = path.join(DEMO, "preseren-hawlina.ged");
const INCOMING = path.join(DEMO, "preseren-odar.ged");

const row = (d: Director, key: string) => d.page.locator(`.compare-panel tr[data-row-key${key}]`);
const confirm = (d: Director) => d.page.locator(".compare-name-decisions button").first();
const candidate = (d: Director, name: string) => d.page.locator(".candidate", { hasText: name });

const scenario: Scenario = {
  id: "merge",
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
        sl: "Dva raziskovalca sta raziskovala isto rodbino, rodbino Franceta Prešerna. Pokažimo, kako njune podatke združite v eno drevo.",
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
      callout: { sl: "Odprite svojo datoteko", en: "Open your own file" },
      say: {
        sl: "Najprej odprite svojo datoteko GEDCOM: povlecite jo v okvir ali kliknite nanj. Datoteka ostane na vašem računalniku in se nikamor ne pošlje.",
        en: "First, open your own GEDCOM file: drag it onto the box, or click the box. The file stays on your computer; nothing is uploaded.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(900);
        const zone = d.page.locator(".lb-drop");
        await d.highlight(zone);
        await d.point(zone);
        await d.wait(3000);
        await d.highlight(null);
        await d.upload(zone, MAIN);
        await d.page.locator(".edit-person").first().waitFor();
      },
    },
    {
      say: {
        sl: "To je vaša glavna datoteka, rodovnik Petra Hawline. Vanjo se zapišejo podatki, ki jih boste prevzeli iz druge datoteke.",
        en: "This is your main file, Peter Hawlina's pedigree. The data you take over from the other file is written into it.",
      },
      run: async (d) => {
        await d.highlight(d.page.locator(".edit-person").first());
      },
    },
    {
      callout: { sl: "Odprite vhodno datoteko", en: "Open the incoming file" },
      say: {
        sl: "Na zavihku »Združevanje« odprite drugo drevo, tokrat iz Slovenskega rodoslovnega indeksa. Tej pravimo vhodna datoteka. Iz nje samo prevzemate podatke, zato ostane nespremenjena.",
        en: "On the Merge tab, open the other tree, this one from the Slovenian genealogical index. We call it the incoming file. You only take data from it, so it stays unchanged.",
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
        sl: "Kraj rojstva je v drugem drevesu natančnejši, s hišno številko: Vrba 2, stara hišna številka 1.",
        en: "The birthplace is more precise in the other tree, down to the house number: Vrba 2, old house number 1.",
      },
      run: async (d) => {
        const place = row(d, '="BIRT.place"');
        await d.scrollTo(place);
        await d.highlight(place);
      },
    },
    {
      callout: { sl: "Potrdite par", en: "Confirm the pair" },
      say: {
        sl: "Podatke izbirate šele pri potrjenem paru. Dokler ga ne potrdite, so gumbi za izbiro zaklenjeni. Ker gre za isto osebo, kliknite »Potrdi«.",
        en: "You can choose data only once a pair is confirmed; until then, the choice buttons are locked. Since this is the same person, click Confirm.",
      },
      run: async (d) => {
        await d.point(row(d, '="BIRT.place"').locator(".choice.incoming"));
        await d.wait(2500);
        await d.highlight(null);
        await d.click(confirm(d));
      },
    },
    {
      callout: { sl: "Izberite podatke", en: "Choose the data" },
      say: {
        sl: "Zdaj pri vsakem podatku izberete, od kod se vzame. Z gumbom G obdržite svoj podatek, z gumbom V prevzamete vhodnega. Pri kraju rojstva izberimo natančnejši, vhodni zapis.",
        en: "Now, for each value, you choose where it comes from. The M button keeps your own value, and I takes the incoming one. For the birthplace, let's take the more precise incoming value.",
      },
      run: async (d) => {
        const place = row(d, '="BIRT.place"');
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
      callout: { sl: "Nove osebe", en: "New people" },
      say: {
        sl: "Ana Jelovšek ima v drugem drevesu starša, ki ju pri vas ni: Martina Jelovška in Marijo Bobek. Ko par potrdite, se oba dodata v vaše drevo.",
        en: "In the other tree, Ana Jelovšek has parents your tree lacks: Martin Jelovšek and Marija Bobek. When you confirm the pair, both are added to your tree.",
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
        sl: "Primerjalno drevo pokaže obe drevesi skupaj. Barva vsake osebe pove, ali se drevesi ujemata, se razlikujeta ali je oseba samo v enem od njiju.",
        en: "The Compare Tree shows both trees together. Each person's colour tells you whether the trees agree, differ, or have the person in only one of them.",
      },
      run: async (d) => {
        await d.click(candidate(d, "France"));
        await d.click(d.page.locator(".tree-open-btn").filter({ visible: true }).first());
        await d.wait(6500);
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
