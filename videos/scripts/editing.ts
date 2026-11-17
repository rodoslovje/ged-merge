/**
 * Video 2 (SCENARIJI.md): basic editing — add an event, children with dates
 * and places, sex, a partner and a marriage; unlink vs delete; save.
 *
 * Data: France Prešeren's pedigree from Peter Hawlina's tree (videos/demo/).
 * Everything typed in is real: Šimen Prešeren was a farmer (owner of the
 * Ribičevina farm); his daughters Jera (b. 3 Nov 1798, Vrba) and Mina (b. 22 Jan
 * 1808, Vrba 1) and Mina's husband Jožef Vovk (b. 4 Jan 1806) are from Hawlina's
 * full tree in the Slovenian genealogical index; the marriage on 28 May 1827 is
 * from the Slovenska biografija (rodbina Prešeren).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import type { Scenario } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "preseren-hawlina.ged");

/** Quick-add chips under the events: 0 »Dodaj dogodek«, 1 Rojstvo, 2 Prebivališče, 3 Poklic, 4 Smrt, 5 Pokop. */
const chip = (d: Director, i: number) => d.page.locator(".edit-person .edit-event-add-row .edit-name-chip-add").nth(i);
const addCard = (d: Director, which: "child" | "partner") =>
  d.page.locator(".person-card-add").filter({ hasText: d.t(which === "child" ? { sl: "otroka", en: "Child" } : { sl: "partnerja", en: "Partner" }) }).first();
const type = (d: Director, text: string) => d.page.keyboard.type(text, { delay: 140 });
const blur = (d: Director) => d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** »+ Dodaj otroka / partnerja« → type the name → »+ Dodaj novo osebo«. Lands on the new person. */
async function addRelative(d: Director, which: "child" | "partner", name: string): Promise<void> {
  const card = addCard(d, which);
  await d.scrollTo(card);
  await d.click(card);
  await type(d, name);
  const create = d.page.locator(".relative-picker-new").first();
  await d.highlight(create, 3);
  await d.wait(1500);
  await d.highlight(null);
  await d.click(create);
  await d.page.locator(".edit-person .edit-event-date").first().waitFor();
}

/** Type a birth date, show how it was read, then Enter to the place and pick a suggestion. */
async function birth(d: Director, date: string, place: string): Promise<void> {
  await type(d, date);
  await d.highlight(d.page.locator(".edit-date-preview").first(), 4);
  await d.wait(2500);
  await d.highlight(null);
  await d.page.keyboard.press("Enter");
  await type(d, place);
  await d.wait(1200);
  await pickPlace(d, place);
  await blur(d);
}

/** Click the suggested place whose text is exactly `place`. */
async function pickPlace(d: Director, place: string): Promise<void> {
  const item = d.page.locator(".suggest-item").filter({ hasText: new RegExp(`^${place}$`) }).first();
  await d.click(item);
}

const scenario: Scenario = {
  id: "editing",
  episode: 2,
  title: {
    sl: "GED Merge: osnovno urejanje — dogodki, otroci, partnerji",
    en: "GED Merge: basic editing — events, children, partners",
  },
  description: {
    sl: "Kako v GED Merge dopolnjujete drevo: dodate dogodek, otroka z datumom in krajem rojstva, partnerja in poroko, nastavite spol ter odklopite ali izbrišete osebo. Primer: Prešernove sestre Jera in Mina ter Minin mož Jožef Vovk, po rodovniku Petra Hawline in Slovenski biografiji.",
    en: "How to build up your tree in GED Merge: add an event, a child with birth date and place, a partner and a marriage, set the sex, and unlink or delete a person. Example: Prešeren's sisters Jera and Mina and Mina's husband Jožef Vovk, from Peter Hawlina's pedigree and the Slovenska biografija.",
  },
  thumbnail: {
    tag: { sl: "Urejanje", en: "Editing" },
    title: { sl: "Dopolnite *drevo* korak za korakom", en: "Build your *tree* step by step" },
  },
  steps: [
    {
      say: {
        sl: "V tem videu dopolnimo drevo pesnika Franceta Prešerna: dodamo poklic, sestri in njuni rojstvi ter Minino poroko.",
        en: "In this video we add to France Prešeren's tree: an occupation, his two sisters with their births, and Mina's marriage.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Osnovno urejanje", en: "Basic editing" },
          { sl: "Dogodki, otroci, partnerji", en: "Events, children, partners" },
        );
      },
    },
    {
      say: {
        sl: "Odprimo njegov rodovnik in pojdimo k Prešernovemu očetu Šimnu.",
        en: "Let's open France Prešeren's pedigree and go to his father, Šimen.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(700);
        const zone = d.page.locator(".lb-drop");
        await d.upload(zone, MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(1200);
        await d.click(d.page.locator(".person-card").first());
      },
    },
    {
      callout: { sl: "Dodajte dogodek", en: "Add an event" },
      say: {
        sl: "Pod dogodki so gumbi za najpogostejše dogodke. Črtkan gumb doda nov dogodek, poln skoči na obstoječega. Šimen je bil kmet, zato dodajmo poklic.",
        en: "Below the events are buttons for the most common ones. A dashed button adds a new event; a solid one jumps to the existing event. Šimen was a farmer, so let's add an occupation.",
      },
      run: async (d) => {
        await d.highlight(d.page.locator(".edit-person .edit-event-add-row"), 4);
        await d.wait(5000);
        await d.highlight(null);
        await d.click(chip(d, 3));
        await d.page.keyboard.press("Enter");
        await type(d, "kmet");
        await d.wait(800);
        await d.page.keyboard.press("Escape");
        await blur(d);
      },
    },
    {
      say: {
        sl: "Vse druge dogodke najdete pod »Dodaj dogodek«, urejene po življenjskih obdobjih.",
        en: "Every other event is under Add Event, grouped by stage of life.",
      },
      run: async (d) => {
        await d.click(chip(d, 0));
        await d.wait(3500);
        await d.page.keyboard.press("Escape");
      },
    },
    {
      callout: { sl: "Dodajte otroka", en: "Add a child" },
      say: {
        sl: "Prešeren je imel več sorojencev. Otroka dodate kar pri starših: kliknite »Dodaj otroka«, vpišite ime in izberite »Dodaj novo osebo«. Priimek in povezava na družino se zapišeta sama.",
        en: "Prešeren had several brothers and sisters. You add a child right at the parents: click Add Child, type the name and choose to add a new person. The surname and the link to the family are filled in for you.",
      },
      run: async (d) => {
        await addRelative(d, "child", "Jera");
      },
    },
    {
      callout: { sl: "Datum in kraj", en: "Date and place" },
      say: {
        sl: "Program odpre novo osebo in postavi kazalec v datum rojstva. Datum vpišete po svoje, na primer s pikami. Pod poljem vidite, kako ga je program razumel.",
        en: "The program opens the new person and puts the cursor in the birth date. Type the date your own way, for example with dots. Below the field you see how the program read it.",
      },
      run: async (d) => {
        await d.overlay("hideCursor");
        await type(d, "3. 11. 1798");
        await d.highlight(d.page.locator(".edit-date-preview").first(), 4);
        await d.wait(3000);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "S tipko Enter skočite na kraj. Program predlaga kraje, ki so že v datoteki, zato se isti kraj vedno zapiše enako.",
        en: "Press Enter to move to the place. The program suggests places already in the file, so the same place is always written the same way.",
      },
      run: async (d) => {
        await d.page.keyboard.press("Enter");
        await type(d, "Vrb");
        await d.highlight(d.page.locator(".suggest-item").first().locator(".."), 3);
        await d.wait(2500);
        await d.highlight(null);
        await pickPlace(d, "Vrba");
        await blur(d);
      },
    },
    {
      callout: { sl: "Spol", en: "Sex" },
      say: {
        sl: "Spol nastavite v meniju ali z bližnjico Alt+Shift+X.",
        en: "Set the sex from the menu or with the shortcut Alt+Shift+X.",
      },
      run: async (d) => {
        const sex = d.page.locator(".edit-person .sex-select").first();
        await d.highlight(sex, 4);
        await d.page.keyboard.press("Alt+Shift+X");
        await d.wait(1200);
        await d.page.keyboard.press("Alt+Shift+X");
        await d.wait(800);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Enako dodamo še sestro Mino, rojeno 22. januarja 1808 v Vrbi.",
        en: "In the same way we add her sister Mina, born on 22 January 1808 in Vrba.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".tree-back-btn").filter({ visible: true }).first());
        await d.wait(600);
        await addRelative(d, "child", "Mina");
        await birth(d, "22. 1. 1808", "Vrba 1");
        await d.page.keyboard.press("Alt+Shift+X");
        await d.wait(300);
        await d.page.keyboard.press("Alt+Shift+X");
      },
    },
    {
      callout: { sl: "Partner in poroka", en: "Partner and marriage" },
      say: {
        sl: "Mina se je poročila z Jožefom Vovkom. Partnerja dodate pri osebi z gumbom »Dodaj partnerja«. Spol se nastavi sam.",
        en: "Mina married Jožef Vovk. You add a partner at the person with Add Partner; the sex is set for you.",
      },
      run: async (d) => {
        await addRelative(d, "partner", "Jožef Vovk");
        await d.overlay("hideCursor");
        await type(d, "4. 1. 1806");
        await d.wait(800);
        await d.page.keyboard.press("Escape");
        await blur(d);
      },
    },
    {
      say: {
        sl: "Poroko vpišete z gumbom »Dodaj družinski dogodek«. Mina in Jožef sta se poročila 28. maja 1827.",
        en: "You record the marriage with Add Family Event. Mina and Jožef married on 28 May 1827.",
      },
      run: async (d) => {
        const fam = d.page.locator(".add-chip").filter({ visible: true }).first();
        await d.scrollTo(fam);
        await d.click(fam);
        await d.wait(1200);
        await d.page.keyboard.press("Enter");
        await d.wait(500);
        await d.overlay("hideCursor");
        await type(d, "28. 5. 1827");
        await d.highlight(d.page.locator(".edit-date-preview").filter({ visible: true }).first(), 4);
        await d.wait(2500);
        await d.snapshot();
        await d.highlight(null);
        await d.page.keyboard.press("Enter");
        await d.page.keyboard.press("Escape");
        await blur(d);
      },
    },
    {
      callout: { sl: "Odklop in brisanje", en: "Unlink and delete" },
      say: {
        sl: "Znak minus osebo samo odklopi iz družine. Oseba ostane v datoteki. Koš osebo izbriše, a šele po potrditvi.",
        en: "The minus sign only unlinks a person from the family; the person stays in the file. The bin deletes the person, but only after you confirm.",
      },
      run: async (d) => {
        const detach = d.page.locator(".person-card-detach").filter({ visible: true }).first();
        await d.scrollTo(detach);
        await d.highlight(detach, 6);
        await d.point(detach);
        await d.wait(2500);
        const del = d.page.locator(".edit-delete-btn").filter({ visible: true }).first();
        await d.scrollTo(del);
        await d.highlight(del, 6);
        await d.point(del);
      },
    },
    {
      callout: { sl: "Sorodniki", en: "Relatives" },
      say: {
        sl: "Na desni vidite širše sorodstvo osebe, po očetovi in materini strani: stare starše, strice, tete ter bratrance in sestrične.",
        en: "On the right you see the wider family, on the father's and the mother's side: grandparents, uncles, aunts and cousins.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(d.page.locator(".person-card").filter({ hasText: "Mina" }).filter({ visible: true }).first());
        await d.wait(800);
        await d.highlight(d.page.locator("aside.edit-wider").filter({ visible: true }).first(), 4);
      },
    },
    {
      callout: { sl: "Shranjevanje", en: "Saving" },
      say: {
        sl: "Predogled pred shranjevanjem pokaže vse, kar ste dodali: poklic, sestri, Jožefa Vovka in poroko.",
        en: "The preview before saving lists everything you added: the occupation, the two sisters, Jožef Vovk and the marriage.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(d.page.locator(".app-head-actions .export-btn"));
        await d.wait(7000);
        await d.page.keyboard.press("Escape");
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
