/**
 * Pilot: complete your tree from a cousin's file — merge the people both trees
 * hold, then choose, field by field, what to take over.
 *
 * Demo data: videos/demo/moje-drevo.ged (main) and videos/demo/bratranec.ged
 * (incoming) — a fictional family; nobody in it is a real person.
 *
 * Comparison rows are selected by `data-row-key` (stable, language-neutral).
 * The field choice buttons (`.choice.main` / `.incoming` / `.both`) are locked
 * until the pair is confirmed, so the video confirms first and chooses after.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import type { Scenario } from "../lib/types.ts";

const DEMO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo");
const MAIN = path.join(DEMO, "moje-drevo.ged");
const INCOMING = path.join(DEMO, "bratranec.ged");

const row = (d: Director, key: string) => d.page.locator(`.compare-panel tr[data-row-key${key}]`);
const confirm = (d: Director) => d.page.locator(".compare-name-decisions button").first();

const scenario: Scenario = {
  id: "merge",
  title: {
    sl: "GED Merge: dopolnite svoje drevo s podatki iz druge datoteke GEDCOM",
    en: "GED Merge: complete your family tree with data from another GEDCOM file",
  },
  description: {
    sl: "Kako v GED Merge dopolnite svoje rodoslovno drevo s podatki iz sorodnikovega: odprete obe datoteki, potrdite pare oseb, ki so v obeh, pri vsakem podatku izberete, ali obdržite svojega, prevzamete vhodnega ali obdržite oba, in shranite dopolnjeno datoteko. Podatki v videu so izmišljeni.",
    en: "How to complete your family tree with data from a relative's tree in GED Merge: open both files, confirm the pairs of people who appear in both, choose for each value whether to keep yours, take the incoming one or keep both, and save the completed file. The people in this video are fictional.",
  },
  thumbnail: {
    tag: { sl: "Združevanje oseb", en: "Merging people" },
    title: { sl: "Dopolnite *drevo* iz druge datoteke", en: "Complete your *tree* from another file" },
  },
  steps: [
    {
      say: {
        sl: "V tem videu bomo vaše drevo dopolnili s podatki iz drevesa, ki vam ga je poslal bratranec. Osebe, ki so v obeh drevesih, bomo združili in prevzeli podatke, ki vam manjkajo.",
        en: "In this video we complete your family tree with data from a tree your cousin sent you. We merge the people who appear in both trees and take over the data you are missing.",
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
        sl: "Najprej odprite svojo datoteko GEDCOM. Povlecite jo v okvir ali kliknite nanj in jo izberite. Datoteka ostane na vašem računalniku in se nikamor ne pošlje.",
        en: "First, open your own GEDCOM file. Drag it onto the box, or click the box and pick the file. The file stays on your computer; nothing is uploaded.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(900);
        const zone = d.page.locator(".lb-drop");
        await d.highlight(zone);
        await d.point(zone);
        await d.wait(3500);
        await d.highlight(null);
        await d.upload(zone, MAIN);
        await d.page.locator(".edit-person").first().waitFor();
      },
    },
    {
      say: {
        sl: "To je vaša glavna datoteka. Vanjo se zapišejo podatki, ki jih boste prevzeli iz druge datoteke.",
        en: "This is your main file. The data you take over from the other file is written into it.",
      },
      run: async (d) => {
        await d.highlight(d.page.locator(".edit-person").first());
      },
    },
    {
      callout: { sl: "Odprite vhodno datoteko", en: "Open the incoming file" },
      say: {
        sl: "Zdaj preklopite na zavihek »Združevanje« in odprite še bratrančevo datoteko. Tej pravimo vhodna datoteka. Iz nje samo prevzemate podatke, zato ostane nespremenjena.",
        en: "Now switch to the Merge tab and open your cousin's file. We call it the incoming file. You only take data from it, so it stays unchanged.",
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
        sl: "GED Merge poišče osebe, ki so verjetno v obeh datotekah, in jih na levi ponudi kot pare. Vsak par ima svojo stopnjo ujemanja. Višja kot je, bolj se ujemajo imena, datumi in sorodniki.",
        en: "GED Merge finds the people who are probably in both files and lists them on the left as pairs. Each pair has a match score: the higher it is, the more closely the names, dates and relatives agree.",
      },
      run: async (d) => {
        await d.highlight(d.page.locator(".candidate-list"));
        await d.wait(5500);
        await d.point(d.page.locator(".candidate").first());
      },
    },
    {
      callout: { sl: "Primerjava para", en: "Comparing a pair" },
      say: {
        sl: "Desno je primerjava izbranega para: levo so vaši podatki, desno podatki iz vhodne datoteke. Enaki podatki so označeni z enačajem.",
        en: "On the right you see the selected pair side by side: your data on the left, the incoming data on the right. Values that agree are marked with an equals sign.",
      },
      run: async (d) => {
        await d.highlight(d.page.locator(".compare-panel table").first(), 4);
      },
    },
    {
      say: {
        sl: "Bratranec pozna datum in kraj Janezove smrti, ki ju v vašem drevesu ni. Taki novi podatki so obarvani zeleno. Pri poklicu pa se datoteki razlikujeta: pri vas je Janez kmet, pri bratrancu kovač.",
        en: "Your cousin knows when and where Janez died, which your tree is missing; new data like this is shaded green. The occupation differs, though: in your tree Janez is a farmer, in your cousin's a blacksmith.",
      },
      run: async (d) => {
        await d.highlight(row(d, '="DEAT.date"'));
        await d.wait(5500);
        await d.highlight(row(d, '="OCCU.value"'));
      },
    },
    {
      callout: { sl: "Potrdite par", en: "Confirm the pair" },
      say: {
        sl: "Če gre res za isto osebo, kliknite gumb »Potrdi«. Podatke lahko izbirate šele pri potrjenem paru. Dokler ga ne potrdite, so gumbi za izbiro zaklenjeni.",
        en: "If this really is the same person, click Confirm. You can choose the data only once the pair is confirmed; until then, the choice buttons are locked.",
      },
      run: async (d) => {
        await d.point(row(d, '="OCCU.value"').locator(".choice.both"));
        await d.wait(1500);
        await d.highlight(null);
        await d.click(confirm(d));
      },
    },
    {
      callout: { sl: "Izberite podatke", en: "Choose the data" },
      say: {
        sl: "Zdaj pri vsakem podatku izberete, od kod se vzame. Z gumbom G obdržite svoj podatek, z gumbom V prevzamete vhodnega, z gumbom O pa obdržite oba. Janez je bil lahko kmet in kovač, zato pri poklicu izberimo oba.",
        en: "Now, for each value, you choose where it comes from. The M button keeps your own value, I takes the incoming one, and B keeps both. Janez may well have been a farmer and a blacksmith, so for the occupation let's keep both.",
      },
      run: async (d) => {
        const occ = row(d, '="OCCU.value"');
        await d.highlight(occ);
        await d.wait(2200);
        await d.point(occ.locator(".choice.main"));
        await d.wait(1200);
        await d.point(occ.locator(".choice.incoming"));
        await d.wait(1400);
        await d.click(occ.locator(".choice.both"));
        await d.snapshot();
      },
    },
    {
      say: {
        sl: "Pri poroki je vhodni datum natančnejši, zato je že izbran. Bratranec pozna tudi Janezovo hčer Katarino, ki je v vašem drevesu ni. Dodate jo z gumbom »+ dodaj«.",
        en: "For the marriage, the incoming date is more exact, so it is already selected. Your cousin also knows Janez's daughter Katarina, who is missing from your tree. Add her with the + add button.",
      },
      run: async (d) => {
        const marr = row(d, '$=".MARR.date"');
        await d.scrollTo(marr);
        await d.highlight(marr);
        await d.wait(4200);
        const children = row(d, '$=".children"');
        await d.scrollTo(children);
        await d.highlight(children);
        await d.wait(3500);
        await d.click(children.locator(".choice.take"));
      },
    },
    {
      callout: { sl: "Nova oseba", en: "A new person" },
      say: {
        sl: "Poglejmo še Ano. V vhodni datoteki ima moža, Matevža Hafnerja, ki ga v vašem drevesu ni. Ko par potrdite, se Matevž doda kot nova oseba, skupaj s poroko.",
        en: "Now let's look at Ana. In the incoming file she has a husband, Matevž Hafner, who is not in your tree. Confirming the pair adds Matevž as a new person, together with the marriage.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(d.page.locator(".candidate", { hasText: "Ana" }));
        const partner = row(d, '$=".partner"');
        await d.scrollTo(partner);
        await d.highlight(partner);
        await d.wait(4500);
        await d.highlight(null);
        await d.click(confirm(d));
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
