/**
 * Video 3: display settings — make the screen more useful. Start person
 * (France Prešeren), kinship and highlighted direct line, ages, dates in words,
 * married surname (taken from the partner and shown), the file's author, and
 * language and theme. Later videos are recorded with these choices on.
 *
 * Data: France Prešeren's pedigree from Peter Hawlina's tree (videos/demo/).
 * Marija Triplat, Janez Prešeren's second wife, is from contributor Odar's tree
 * in the Slovenian genealogical index.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import type { Scenario, Text } from "../lib/types.ts";

// A copy of the main demo file in which every married wife also carries her
// husband's surname as a married name, so »Prikaži poročni priimek« has
// something to show. France Prešeren and Ana Jelovšek were not married.
const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "preseren-hawlina-porocni.ged");

const settingsButton = (d: Director) =>
  d.page.locator(".nav-btn.icon-only:not(.undo-btn):not(.charts-open-btn):not(.shortcuts-btn)").nth(2);
const modal = (d: Director) => d.page.locator(".settings-modal");
const tab = (d: Director, label: Text) => modal(d).locator("button", { hasText: d.t(label) }).first();
const toggle = (d: Director, label: Text) => modal(d).locator("label.settings-row-toggle", { hasText: d.t(label) }).first();
const type = (d: Director, text: string) => d.page.keyboard.type(text, { delay: 120 });

async function openSettings(d: Director, on?: Text): Promise<void> {
  await d.click(settingsButton(d));
  await modal(d).waitFor();
  if (on) await d.click(tab(d, on));
}
async function closeSettings(d: Director): Promise<void> {
  await d.highlight(null);
  await d.page.keyboard.press("Escape");
  await modal(d).waitFor({ state: "hidden" });
}
/** Ring a settings row, then click its checkbox. */
async function flip(d: Director, label: Text): Promise<void> {
  const row = toggle(d, label);
  await d.highlight(row, 4);
  await d.wait(900);
  await d.click(row.locator("input"));
  await d.wait(900);
}

const GENERAL: Text = { sl: "Splošno", en: "General" };
const EDITING: Text = { sl: "Urejanje", en: "Editing" };

const scenario: Scenario = {
  id: "settings",
  episode: 3,
  title: {
    sl: "GED Merge: nastavitve prikaza — sorodstvo, starosti, datumi, poročni priimek",
    en: "GED Merge: display settings — kinship, ages, dates, married surname",
  },
  description: {
    sl: "Kako si v GED Merge prilagodite prikaz, da je še bolj uporaben: izhodiščna oseba in sorodstvo ob vsakem imenu, poudarjeni predniki in potomci, starosti, datumi z besedami, poročni priimek, avtor datoteke ter jezik in temna tema. Primer: rodovnik Franceta Prešerna iz drevesa Petra Hawline.",
    en: "How to set up GED Merge's display to be even more useful: a start person and kinship by every name, highlighted ancestors and descendants, ages, dates in words, the married surname, the file's author, and language and dark theme. Example: France Prešeren's pedigree from Peter Hawlina's tree.",
  },
  thumbnail: {
    tag: { sl: "Nastavitve", en: "Settings" },
    title: { sl: "Prikaz po *vaši* meri", en: "A display made *for you*" },
  },
  steps: [
    {
      say: {
        sl: "V tem videu si prikaz prilagodimo tako, da je še bolj uporaben: s sorodstvom, starostmi in datumi, kot jih berete vi.",
        en: "In this video we tune the display to be even more useful: with kinship, ages, and dates the way you read them.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Nastavitve prikaza", en: "Display settings" },
          { sl: "Prilagodite prikaz po svoje", en: "Make the display your own" },
        );
      },
    },
    {
      say: {
        sl: "Odprimo rodovnik pesnika Franceta Prešerna. Program privzeto pokaže imena in letnice.",
        en: "Let's open France Prešeren's pedigree. By default the program shows names and years.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(700);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.overlay("hideCursor");
      },
    },
    {
      callout: { sl: "Izhodiščna oseba", en: "Start person" },
      say: {
        sl: "Najprej izberite izhodiščno osebo, okoli katere je vaše drevo. Kliknite gumb ob imenu in izberite »Nastavi to osebo kot izhodiščno«. Pri nas je to pesnik France Prešeren.",
        en: "First choose the start person your tree centres on. Click the button next to the name and choose to make this person the start person. Here, that is France Prešeren.",
      },
      run: async (d) => {
        const chip = d.page.locator(".edit-person .start-chip").first();
        await d.highlight(chip, 4);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(chip);
        await d.wait(1800);
        await d.page.keyboard.press("Enter");
      },
    },
    {
      say: {
        sl: "Zdaj je ob vsaki osebi zapisano, v kakšnem sorodstvu je s Prešernom: oče, mati, dedek, babica. Predniki in potomci so izpisani krepko, da izstopajo.",
        en: "Now every person shows how they are related to France: father, mother, grandfather, grandmother. Ancestors and descendants are in bold, so they stand out.",
      },
      run: async (d) => {
        await d.wait(800);
        await d.highlight(d.page.locator(".person-card").first(), 4);
        await d.wait(3500);
        await d.highlight(d.page.locator("aside.edit-wider").filter({ visible: true }).first(), 4);
      },
    },
    {
      callout: { sl: "Sorodstvo", en: "Kinship" },
      say: {
        sl: "Oboje vklopite ali izklopite v Nastavitvah, na zavihku »Splošno«: »Prikaži sorodstvo« in »Poudari prednike in potomce«.",
        en: "Both are switched on or off in Settings, on the General tab: Show kinship, and Highlight ancestors and descendants.",
      },
      run: async (d) => {
        await d.highlight(null);
        await openSettings(d);
        const rows = [toggle(d, { sl: "Prikaži sorodstvo", en: "Show kinship" }), toggle(d, { sl: "Poudari prednike", en: "Highlight ancestors" })];
        await rows[0].scrollIntoViewIfNeeded();
        for (const r of rows) {
          await d.highlight(r, 4);
          await d.wait(2200);
        }
      },
    },
    {
      callout: { sl: "Starosti", en: "Ages" },
      say: {
        sl: "Vklopite še »Prikaži starosti«. Ob dogodkih se izpiše starost osebe: Prešeren je umrl star 48 let. Ob rojstvu se izpiše še starost staršev: oče je bil takrat star 38 let, mati pa 26.",
        en: "Switch on Show ages as well. Each event shows the person's age: Prešeren died aged 48. A birth also shows the parents' ages: his father was 38 at the time, and his mother 26.",
      },
      run: async (d) => {
        await flip(d, { sl: "Prikaži starosti", en: "Show ages" });
        await closeSettings(d);
        const ages = d.page.locator(".edit-person .edit-event-age");
        // Death (the person's own age) first, then birth (the parents' ages).
        await d.highlight(ages.nth(1), 6);
        await d.point(ages.nth(1));
        await d.wait(3200);
        await d.highlight(ages.first(), 6);
        await d.point(ages.first());
      },
    },
    {
      callout: { sl: "Prikaz datumov", en: "Date display" },
      say: {
        sl: "Datume lahko prikažete z besedami, na primer »3. decembra 1800«. Datoteka ohrani svoj zapis, spremeni se samo prikaz na zaslonu.",
        en: "Dates can be shown in words, for example 3 December 1800. The file keeps its own form; only what you see on screen changes.",
      },
      run: async (d) => {
        await d.highlight(null);
        await openSettings(d);
        const menu = modal(d).locator(".settings-format-row .select-menu").first();
        await menu.scrollIntoViewIfNeeded();
        await d.highlight(menu.locator(".."), 4);
        await d.click(menu);
        await d.wait(900);
        await d.click(d.page.getByText(d.t({ sl: "Z besedami", en: "In words" }), { exact: true }).first());
        await d.wait(1800);
        await closeSettings(d);
        await d.overlay("hideCursor");
        await d.wait(600);
        await d.snapshot();
        await d.highlight(d.page.locator(".edit-person").first(), 4);
      },
    },
    {
      callout: { sl: "Poročni priimek", en: "Married surname" },
      say: {
        sl: "Na zavihku »Splošno« vklopite »Prikaži poročni priimek«, na zavihku »Urejanje« pa »Poročni priimek po partnerju«. Pri poročenih ženah se zdaj ob dekliškem priimku izpiše še poročni. Prešernova mati Mina Svetina je tako zapisana tudi s poročnim priimkom Prešeren.",
        en: "On the General tab, switch on Show married surname, and on the Editing tab, Married surname from partner. Married women now show their married surname next to the maiden name: Prešeren's mother Mina Svetina, for example, also carries her married name, Prešeren.",
      },
      run: async (d) => {
        await d.highlight(null);
        await openSettings(d);
        await flip(d, { sl: "Prikaži poročni priimek", en: "Show married surname" });
        await d.click(tab(d, EDITING));
        await flip(d, { sl: "Poročni priimek po partnerju", en: "Married surname from partner" });
        await closeSettings(d);
        await d.overlay("hideCursor");
        await d.highlight(d.page.locator(".person-card").nth(1), 4);
      },
    },
    {
      say: {
        sl: "Janez Prešeren je imel drugo ženo, Marijo Triplat. Ko jo dodamo kot partnerko, program sam zapiše njen poročni priimek, Prešeren. Vidite ga pod glavnim imenom, med dodatnimi imeni.",
        en: "Janez Prešeren had a second wife, Marija Triplat. When we add her as his partner, the program records her married surname, Prešeren. You see it below the main name, among the other names.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.page.keyboard.press("/");
        await d.wait(400);
        await type(d, "janez");
        await d.wait(900);
        await d.page.keyboard.press("Enter");
        await d.wait(900);
        const add = d.page.locator(".person-card-add").filter({ hasText: d.t({ sl: "partnerja", en: "Partner" }) }).filter({ visible: true }).first();
        await d.scrollTo(add);
        await d.click(add);
        await type(d, "Marija Triplat");
        await d.click(d.page.locator(".relative-picker-new").first());
        await d.page.keyboard.press("Escape");
        await d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await d.wait(600);
        const married = d.page.locator(".edit-person .edit-name-chip-wrap").first();
        await d.highlight(married, 6);
        await d.point(married);
      },
    },
    {
      callout: { sl: "Avtor datoteke", en: "File author" },
      say: {
        sl: "Na zavihku »Urejanje« vpišete tudi sebe kot avtorja: ime, e-pošto in spletno stran. Zapišejo se v novo datoteko in v datoteko, ki avtorja še nima.",
        en: "On the Editing tab you also enter yourself as the author: name, e-mail and website. They are written into a new file, and into a file that has no author yet.",
      },
      run: async (d) => {
        await d.highlight(null);
        await openSettings(d, EDITING);
        const inputs = modal(d).locator(".settings-text-input");
        await d.highlight(inputs.first().locator("../.."), 4);
        await d.click(inputs.first());
        await type(d, "Luka Renko");
        await d.click(inputs.nth(2));
        await type(d, "https://luka.renko.fyi");
        await d.wait(800);
      },
    },
    {
      say: {
        sl: "Za nadaljnje videe izberimo slovenski zapis datumov: dan, mesec in leto s pikami.",
        en: "For the rest of this series we keep dates the way GEDCOM writes them.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(tab(d, GENERAL));
        const menu = modal(d).locator(".settings-format-row .select-menu").first();
        await menu.scrollIntoViewIfNeeded();
        await d.highlight(menu.locator(".."), 4);
        await d.click(menu);
        await d.wait(900);
        // Slovenian: 3. 12. 1800; English: back to the file's own GEDCOM form.
        await d.click(d.page.getByText(d.t({ sl: "D. M. YYYY", en: "As in the file" }), { exact: true }).first());
        await d.wait(1500);
      },
    },
    {
      callout: { sl: "Jezik in videz", en: "Language and theme" },
      say: {
        sl: "Na koncu še jezik in videz. Program deluje v slovenščini in angleščini, s svetlo ali temno temo.",
        en: "Finally, language and theme. The program works in English and Slovenian, with a light or a dark theme.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(tab(d, GENERAL));
        const radios = modal(d).locator("label.settings-radio");
        await d.click(radios.nth(4)); // dark
        await d.wait(2500);
        await d.click(radios.nth(d.lang === "sl" ? 0 : 1)); // the other language
        await d.wait(2500);
        await d.click(radios.nth(d.lang === "sl" ? 1 : 0)); // back
        await d.click(radios.nth(2)); // automatic theme
        await d.wait(800);
        await closeSettings(d);
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
