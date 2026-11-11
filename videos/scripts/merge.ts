/**
 * Pilot: merge a cousin's file into your own tree.
 *
 * Demo data: videos/demo/moje-drevo.ged (main) and videos/demo/bratranec.ged
 * (incoming) — a fictional family; nobody in it is a real person.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario } from "../lib/types.ts";

const DEMO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo");
const MAIN = path.join(DEMO, "moje-drevo.ged");
const INCOMING = path.join(DEMO, "bratranec.ged");

const scenario: Scenario = {
  id: "merge",
  title: {
    sl: "GED Merge: združevanje dveh datotek GEDCOM",
    en: "GED Merge: merging two GEDCOM files",
  },
  description: {
    sl: "Kako v GED Merge prevzamete podatke iz sorodnikovega rodoslovnega drevesa v svoje: odprete obe datoteki, pregledate predlagane pare, izberete podatke in shranite združeno datoteko. Podatki v videu so izmišljeni.",
    en: "How to take data from a relative's family tree into your own with GED Merge: open both files, review the suggested pairs, choose the data and save the merged file. The people in this video are fictional.",
  },
  steps: [
    {
      say: {
        sl: "V tem videu bomo združili dve rodoslovni datoteki: vaše drevo in drevo, ki vam ga je poslal bratranec.",
        en: "In this video we merge two family-tree files: your own tree, and one that a cousin sent you.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Združevanje dveh datotek GEDCOM", en: "Merging two GEDCOM files" },
          { sl: "Prevzemite podatke iz sorodnikovega drevesa", en: "Take data from a relative's tree into yours" },
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
        sl: "To je vaša glavna datoteka. Vse, kar boste prevzeli iz druge datoteke, se doda vanjo.",
        en: "This is your main file. Everything you take over from the other file is added to it.",
      },
      run: async (d) => {
        await d.highlight(d.page.locator(".edit-person").first());
      },
    },
    {
      callout: { sl: "Odprite vhodno datoteko", en: "Open the incoming file" },
      say: {
        sl: "Zdaj preklopite na zavihek »Združevanje« in odprite še bratrančevo datoteko. Tej pravimo vhodna datoteka.",
        en: "Now switch to the Merge tab and open your cousin's file. We call it the incoming file.",
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
        sl: "GED Merge primerja osebe iz obeh datotek. Na levi so pari, ki so verjetno ista oseba, vsak s svojo stopnjo ujemanja. Višja kot je stopnja, bolj se ujemajo imena, datumi in sorodniki.",
        en: "GED Merge compares the people in both files. On the left are the pairs that are probably the same person, each with its match score. The higher the score, the more closely the names, dates and relatives agree.",
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
        sl: "Bratranec pozna datum in kraj Janezove smrti, ki ju v vašem drevesu ni. Novi podatki so obarvani zeleno in so že izbrani za prevzem.",
        en: "Your cousin knows when and where Janez died, which your tree is missing. New data is shaded green and is already selected to be taken over.",
      },
      run: async (d) => {
        const row = d.page.locator(".compare-panel tr.field", { hasText: "1941" });
        await d.highlight(row);
        await d.wait(3000);
        await d.point(row.locator(".choice").last());
      },
    },
    {
      say: {
        sl: "Pri poroki ima vhodna datoteka natančnejši datum. Z gumboma na desni izberete, ali obdržite svoj podatek ali prevzamete vhodnega.",
        en: "For the marriage, the incoming file has a more exact date. The buttons on the right choose whether you keep your value or take the incoming one.",
      },
      run: async (d) => {
        const row = d.page.locator(".compare-panel tr.field", { hasText: "12 FEB 1898" });
        await d.scrollTo(row);
        await d.highlight(row);
        await d.wait(2500);
        await d.point(row.locator(".choice").first());
        await d.wait(700);
        await d.point(row.locator(".choice").last());
      },
    },
    {
      callout: { sl: "Potrdite par", en: "Confirm the pair" },
      say: {
        sl: "Ko ste zadovoljni, kliknite gumb »Potrdi«. Izbrani podatki se zapišejo v datoteko ob shranjevanju.",
        en: "When you are happy with it, click Confirm. The chosen data is written to the file when you save.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(d.page.locator(".compare-name-decisions button").first());
        await d.wait(600);
        await d.highlight(d.page.locator(".app-head-actions .export-btn"));
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
        const row = d.page.locator(".compare-panel tr.field", { hasText: "Hafner" });
        await d.scrollTo(row);
        await d.highlight(row);
        await d.wait(4500);
        await d.highlight(null);
        await d.click(d.page.locator(".compare-name-decisions button").first());
      },
    },
    {
      callout: { sl: "Shranite združeno datoteko", en: "Save the merged file" },
      say: {
        sl: "Na koncu kliknite »Shrani GEDCOM«. Predogled pokaže vse spremembe, preden se zapišejo: Janezovo smrt, datum poroke in Anino novo družino.",
        en: "Finally, click Save GEDCOM. A preview lists every change before it is written: Janez's death, the marriage date and Ana's new family.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".app-head-actions .export-btn"));
        await d.wait(2500);
        await d.page.mouse.move(960, 500);
        await d.page.mouse.wheel(0, 250);
      },
    },
    {
      say: {
        sl: "Kliknite »Prenesi GEDCOM« in združeno drevo se shrani kot nova datoteka. Izvirna datoteka ostane nespremenjena.",
        en: "Click Download GEDCOM and the merged tree is saved as a new file. Your original file stays as it was.",
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
        sl: "To je vse. GED Merge je brezplačen, ne potrebuje računa in deluje v vašem brskalniku na naslovu gedmerge.com.",
        en: "That's it. GED Merge is free, needs no account, and runs in your browser at gedmerge.com.",
      },
      run: async (d) => {
        await d.overlay("hideCursor");
        await d.card(
          { sl: "Brezplačno · brez računa · v brskalniku", en: "Free · no account · in your browser" },
          { sl: "gedmerge.com", en: "gedmerge.com" },
          { sl: "Več video navodil najdete na kanalu.", en: "More tutorials on the channel." },
        );
      },
    },
  ],
};

export default scenario;
