/**
 * Video 12 (SCENARIJI.md, "Kraji in naslovi"): the GURS address register
 * downloaded on camera, the Places tree, a place's other names, the naming
 * check of addresses, and geocoding houses — including the way to write a house
 * that has had several numbers: the present address first, the older ones after
 * a slash, an optional note in parentheses.
 *
 * Data: `rodbina-renko.ged` — an anonymised excerpt of the author's tree
 * (GEDCOM 7.0), its places geocoded to the settlement, 255 of its houses placed
 * and 227 not yet. »bolnišnica / klinični center« (13 events in Ljubljana) is
 * the University Medical Centre, Zaloška cesta 2; »Hafnarjeva pot 55 / 21« in
 * Kranj was Stražišče 66 before the street was named.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import { seriesSettingsWithMaps } from "../lib/series.ts";
import type { Scenario, Text } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "rodbina-renko.ged");

const modal = (d: Director) => d.page.locator(".settings-modal");
const tab = (d: Director, label: Text) => modal(d).locator("button", { hasText: d.t(label) }).first();
const visible = (d: Director, selector: string) => d.page.locator(selector).filter({ visible: true });
const link = (d: Director, label: Text | RegExp) =>
  visible(d, "button").filter({ hasText: label instanceof RegExp ? label : d.t(label) }).first();
const blur = (d: Director) => d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const filterBox =(d: Director) => visible(d, `input[placeholder="${d.t({ sl: "Filtriraj…", en: "Filter…" })}"]`).last();

/** A row of the Places tree, by the exact text of its label. */
const treeRow = (d: Director, name: string) =>
  d.page.locator(".tools-tree-row").filter({ has: d.page.locator(".tools-tree-label", { hasText: new RegExp(`(^|\\s)${name}$`) }) }).first();

/** The town of Kranj, under the municipality of the same name — the row that
 *  holds records of its own, which is what other names are written to. */
const kranjTown = (d: Director) =>
  d.page.locator(".tools-tree-row").filter({ has: d.page.locator(".tools-tree-label", { hasText: /^Kranj$/ }) }).nth(1);

/** An address row of the geocoding list, by its address. */
const addrRow = (d: Director, address: string) =>
  d.page.locator(".tools-geo-addr-name", { hasText: address }).first();

/** A finding of the naming check, by its address: the innermost element that
 *  holds both the text and the verdict with its buttons. */
const finding = (d: Director, address: string) =>
  visible(d, "*").filter({ hasText: address, has: d.page.locator(".tools-register-end") }).last();

/** The chip counting the house numbers the register no longer has. */
const noSuchAddress = (d: Director) =>
  visible(d, ".tools-chip").filter({ hasText: d.t({ sl: "Ni takega naslova", en: "No such address" }) }).first();

/** A register answer under an address row, by its full line. */
const hit = (d: Director, line: string) => visible(d, "*").getByText(line, { exact: true }).first();

/** »Prikaži že umeščene« over the address list. */
const showPlaced = (d: Director) =>
  visible(d, "label.tools-reshape-site").filter({ hasText: d.t({ sl: "Prikaži že umeščene", en: "Show already placed" }) }).first();

/** »Razširi vse«, unless the list is open already (it then offers »Strni vse«). */
async function expandAll(d: Director): Promise<void> {
  const expand = link(d, { sl: "Razširi vse", en: "Expand all" });
  if (await expand.isVisible()) await d.click(expand);
}

/** Type into the list's filter, the way a viewer would. */
async function filterTo(d: Director, text: string): Promise<void> {
  const box = filterBox(d);
  await d.click(box);
  await box.fill("");
  if (text) await d.page.keyboard.type(text, { delay: 90 });
  await d.wait(900);
}

/** Open a rename box (✎ beside `target`) and replace its text. */
async function rename(d: Director, pencil: ReturnType<Director["page"]["locator"]>, text: string): Promise<void> {
  await d.click(pencil);
  await d.wait(600);
  const input = visible(d, ".tools-place-rename-input").first();
  await input.waitFor();
  await d.click(input);
  await d.page.keyboard.press("ControlOrMeta+a");
  await d.page.keyboard.type(text, { delay: 70 });
  await d.wait(700);
}

const applyRename = (d: Director) =>
  visible(d, "button").filter({ hasText: new RegExp(`^(${d.t({ sl: "Preimenuj", en: "Rename" })}|${d.t({ sl: "Združi", en: "Merge" })})$`) }).first();

const scenario: Scenario = {
  id: "addresses",
  episode: 12,
  settings: (lang) => ({ ...seriesSettingsWithMaps(lang), allowLinkFetch: true }),
  title: {
    sl: "GED Merge: kraji in naslovi — register naslovov GURS in hišne številke",
    en: "GED Merge: places and addresses — the GURS address register and house numbers",
  },
  description: {
    sl: "Kako v GED Merge uredite kraje in naslove: prenos registra naslovov GURS, drevo krajev, druga imena kraja, primerjava naslovov z registrom in geokodiranje hiš. Pokažemo tudi, kako zapišete hišo, ki je v zgodovini dobila več številk: najprej današnji naslov, nato starejši, ločeni s poševnico, na koncu pripis v oklepaju.",
    en: "How GED Merge handles places and addresses: downloading the GURS address register, the places tree, a place's other names, checking addresses against the register and geocoding houses. We also show how to write a house that has had several numbers: the present address first, then the older ones after a slash, and a note in parentheses at the end.",
  },
  thumbnail: {
    tag: { sl: "Naslovi", en: "Addresses" },
    title: { sl: "Vsaka *hiša* na svojem mestu", en: "Every *house* in its place" },
  },
  steps: [
    {
      say: {
        sl: "Kraj pove vas, naslov pove hišo. Pokažimo, kako v GED Merge uredite oboje — tudi hišne številke, ki so se skozi zgodovino spreminjale.",
        en: "A place names the village, an address names the house. Let's see how GED Merge handles both — including house numbers that changed over time.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Kraji in naslovi", en: "Places and addresses" },
          { sl: "Register naslovov GURS in hišne številke", en: "The GURS address register and house numbers" },
        );
      },
    },
    {
      say: {
        sl: "Odprimo večje drevo. Kraji imajo že koordinate, mnoge hiše pa še ne.",
        en: "Let's open a larger tree. Its places already have coordinates, but many of its houses do not.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(700);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.overlay("hideCursor");
        await d.wait(2500);
      },
    },
    {
      callout: { sl: "Register naslovov", en: "The address register" },
      say: {
        sl: "Za hišne številke najprej prenesite register naslovov. V Nastavitvah na zavihku »Zemljevid« ob imeniku krajev GURS kliknite »Naslovi«. To je vseh petsto osemdeset tisoč hiš v Sloveniji, vsaka s svojo koordinato. Prenos traja nekaj minut, register pa ostane v brskalniku. Nastavitve lahko medtem zaprete in delate naprej, saj se register nalaga v ozadju.",
        en: "For house numbers, first download the address register. In Settings, on the Map tab, click Addresses beside the GURS place directory. That is all five hundred and eighty thousand houses in Slovenia, each with its own coordinate. The download takes a few minutes, and the register stays in your browser. Meanwhile you can close Settings and carry on working: the register loads in the background.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".nav-btn.icon-only:not(.undo-btn):not(.charts-open-btn):not(.shortcuts-btn)").nth(2));
        await d.click(tab(d, { sl: "Zemljevid", en: "Map" }));
        const sources = modal(d).locator(".tools-geo-sources").first();
        await d.scrollTo(sources);
        // The settlements first, quietly: the geocoding lists need them too.
        await sources.locator("button", { hasText: d.t({ sl: "Kraji", en: "Places" }) }).first().click();
        await d.skippable(() => modal(d).getByText("SI-GURS").first().waitFor({ timeout: 120_000 }));
        const addresses = sources.locator("button", { hasText: d.t({ sl: "Naslovi", en: "Addresses" }) }).first();
        await d.highlight(addresses, 6);
        await d.wait(1200);
        await d.click(addresses);
        await d.highlight(null);
        // The progress bar, for a moment — then Settings closes and the episode
        // carries on while the register downloads (geoImport.ts runs it
        // outside the dialog); the naming step waits for it.
        await d.wait(6000);
        await d.click(modal(d).locator(".modal-close"));
        await modal(d).waitFor({ state: "detached" });
        await d.wait(800);
      },
    },
    {
      callout: { sl: "Drevo krajev", en: "The places tree" },
      say: {
        sl: "V Orodjih, pod »Kraji«, so kraji zbrani v drevo: država, občina, naselje in hiša. Ob vsakem je število zapisov in koordinata.",
        en: "In Tools, under Places, the places form a tree: country, municipality, settlement and house. Each shows how many records use it, and its coordinate.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".seg-btn").nth(2));
        await d.wait(800);
        await d.click(d.page.locator(".tools-tab", { hasText: d.t({ sl: "Kraji", en: "Places" }) }).first());
        await d.wait(1200);
        await d.click(treeRow(d, "Slovenia").locator(".tools-tree-label"));
        await d.wait(1200);
        await d.click(treeRow(d, "Kranj").locator(".tools-tree-label"));
        await d.wait(1200);
        await d.highlight(kranjTown(d), 4);
        await d.wait(2500);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Druga imena", en: "Other names" },
      say: {
        sl: "Kraj ima lahko tudi stara ali tuja imena. Kliknite svinčnik, dodajte ime, na primer nemško Krainburg, in kliknite »Zapiši imena«. Iskanje kraj odslej najde tudi po tem imenu.",
        en: "A place can also carry old or foreign names. Click the pencil, add a name — the German Krainburg, say — and click Write names. From then on the search finds the place by that name too.",
      },
      run: async (d) => {
        await d.click(kranjTown(d).locator(".tools-place-edit-btn").first());
        await d.wait(800);
        // The box opens on its own completions; they cover the names below.
        await blur(d);
        await d.wait(500);
        const add = link(d, { sl: "+ Dodaj ime", en: "+ Add a name" });
        await d.scrollTo(add);
        await d.click(add);
        await d.wait(500);
        const name = visible(d, ".tools-place-tran-input").last();
        await d.click(name);
        await d.page.keyboard.type("Krainburg", { delay: 90 });
        await d.wait(900);
        await d.click(link(d, { sl: "Zapiši imena", en: "Write names" }));
        await d.wait(1200);
        await filterTo(d, "Krainburg");
        await d.wait(1800);
        await filterTo(d, "");
        // Naming opens here, after this step's narration, and waits for the
        // address register still downloading behind it: the Addresses tab
        // appears only once the register is stored. The wait is cut to two
        // seconds, so the next step's narration starts on a page that is ready.
        await d.click(link(d, { sl: "Poimenovanje", en: "Naming" }));
        await d.skippable(() => link(d, /^(Naslovi|Addresses)/).waitFor({ timeout: 2_400_000 }), 2);
      },
    },
    {
      callout: { sl: "Poimenovanje", en: "Naming" },
      say: {
        sl: "Poimenovanje primerja kraje in naslove z uradnim registrom. Ko je register naslovov naložen, se pokaže zavihek »Naslovi«. Tu so trije rojstni dogodki v kranjski porodnišnici zapisani kot »Kidričeva 38a«, register pa ulico piše »Kidričeva cesta«.",
        en: "Naming compares places and addresses with the official register. Once the address register has loaded, the Addresses tab appears. Here three births at the Kranj maternity hospital are written as »Kidričeva 38a«, while the register spells the street »Kidričeva cesta«.",
      },
      run: async (d) => {
        await d.wait(1500);
        await d.highlight(link(d, /^(Naslovi|Addresses)/), 4);
        await d.wait(1500);
        await d.highlight(null);
        await d.click(link(d, /^(Naslovi|Addresses)/));
        await d.skippable(() => noSuchAddress(d).waitFor({ timeout: 120_000 }));
        await d.wait(800);
        await expandAll(d);
        await d.wait(800);
        await d.highlight(finding(d, "Kidričeva 38a"), 4);
        await d.wait(3500);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Gumb »Prevzemi« naslov prepiše v uradni zapis, pripis v oklepaju pa ostane. Hišnih številk, ki jih register nima več, seznam ne našteje, ampak jih le prešteje — vasi so hiše v dvajsetem stoletju na novo oštevilčile, zato je stara številka praviloma pravilna.",
        en: "The Use official name button rewrites the address in the official spelling, and the note in parentheses stays. House numbers the register no longer has are counted, not listed — villages renumbered their houses in the twentieth century, so an old number is usually right.",
      },
      run: async (d) => {
        const take = finding(d, "Kidričeva 38a").locator(".tools-issue-link").filter({ hasText: new RegExp(`^${d.t({ sl: "Prevzemi", en: "Use official name" })}$`) }).first();
        await d.highlight(take, 4);
        await d.wait(1200);
        await d.highlight(null);
        await d.click(take);
        await d.wait(2000);
        await d.highlight(noSuchAddress(d), 6);
        await d.wait(3500);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Geokodiranje naslovov", en: "Geocoding addresses" },
      say: {
        sl: "Pod »Geokodiranje« so na zavihku »Naslovi« vse hiše, razvrščene po krajih. Naložen imamo le slovenski register, zato izberemo Slovenijo. Hiša brez svoje lege podeduje koordinato naselja.",
        en: "Under Geocoding, the Addresses tab lists every house, grouped by place. We have only the Slovenian register loaded, so we pick Slovenia. A house without a position of its own inherits the settlement's coordinate.",
      },
      run: async (d) => {
        await d.click(link(d, { sl: "Nazaj na kraje", en: "Back to places" }));
        await d.wait(800);
        await d.click(visible(d, "button.tools-chip").filter({ hasText: d.t({ sl: "Geokodiranje", en: "Geocoding" }) }).first());
        await d.wait(1200);
        await d.click(link(d, /^(Naslovi|Addresses) \d/));
        await d.wait(1200);
        // Only Slovenia's register is loaded, so the list is narrowed to it.
        await d.click(visible(d, "button.tools-chip").filter({ hasText: /Sloven(ija|ia)/ }).first());
        await d.wait(1500);
      },
    },
    {
      callout: { sl: "Pripis v oklepaju", en: "A note in parentheses" },
      say: {
        sl: "Trinajst dogodkov ima naslov »bolnišnica / klinični center«. Napišimo pravi naslov, Zaloška cesta 2, opis pa dodajmo v oklepaju. Register hišo takoj najde. Zadetek potrdimo, da se zapiše tudi njegova koordinata.",
        en: "Thirteen events have the address »hospital / medical centre«. Let's write the real address, Zaloška cesta 2, and add the description in parentheses. The register finds the house at once. We confirm the answer, so its coordinate is written too.",
      },
      run: async (d) => {
        // Both houses of these two steps already carry a position.
        await d.click(showPlaced(d).locator("input"));
        await filterTo(d, "klinični");
        await expandAll(d);
        await d.wait(800);
        const row = addrRow(d, "bolnišnica / klinični center");
        await d.highlight(row, 4);
        await d.wait(1200);
        await d.highlight(null);
        await rename(d, row.locator("xpath=following-sibling::button[contains(@class,'tools-place-edit-btn')][1]"), "Zaloška cesta 2 (klinični center)");
        await d.click(applyRename(d));
        await d.wait(1500);
        const answer = hit(d, "Zaloška cesta 2, Ljubljana, 1000 Ljubljana");
        await d.highlight(answer.locator(".."), 4);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(answer);
        await d.wait(1500);
      },
    },
    {
      callout: { sl: "Več hišnih številk", en: "Several house numbers" },
      say: {
        sl: "Ta hiša je v zgodovini dobila tri številke. Najprej zapišemo današnji naslov, nato starejše, ločene s poševnico: Hafnarjeva pot 55, prej 21, še prej Stražišče 66.",
        en: "This house has had three numbers. We write the present address first, then the older ones, separated by slashes: Hafnarjeva pot 55, before that 21, and earlier still Stražišče 66.",
      },
      run: async (d) => {
        await filterTo(d, "Hafnarjeva pot 55");
        await expandAll(d);
        await d.wait(800);
        const row = addrRow(d, "Hafnarjeva pot 55 / 21");
        await rename(d, row.locator("xpath=following-sibling::button[contains(@class,'tools-place-edit-btn')][1]"), "Hafnarjeva pot 55 / 21 / Stražišče 66");
        await d.click(applyRename(d));
        await d.wait(1500);
      },
    },
    {
      say: {
        sl: "Program vsako številko poišče posebej in zadetke oštevilči. Številka 21 danes pripada drugi hiši, zato pravo lego izberete sami: današnjo številko 55. Stare vaške številke register nima več, zato ostane zapisana le kot zgodovina.",
        en: "The program looks each number up on its own and numbers the answers. Number 21 belongs to another house today, so you pick the right position yourself: today's number 55. The register no longer has the old village number, so it stays on record only as history.",
      },
      run: async (d) => {
        await d.highlight(hit(d, "Hafnarjeva pot 55, Kranj, 4000 Kranj").locator(".."), 4);
        await d.wait(2200);
        await d.highlight(hit(d, "Hafnarjeva pot 21, Kranj, 4000 Kranj").locator(".."), 4);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(hit(d, "Hafnarjeva pot 55, Kranj, 4000 Kranj"));
        await d.wait(1500);
        await d.snapshot();
        await filterTo(d, "");
        await d.click(showPlaced(d).locator("input"));
        await d.wait(800);
      },
    },
    {
      callout: { sl: "Zanesljivi zadetki", en: "Confident matches" },
      say: {
        sl: "Register je že odgovoril za vse hiše v Sloveniji. Nedvoumne zadetke izberete z enim klikom, »Izberi zanesljive«. A pozor: zadetek je zanesljiv le zato, ker se zapis ujema z današnjim registrom, ne pa zato, ker bi bila to zagotovo prava hiša. Če je hiša zapisana s staro številko, je register ne pozna ali pa pod isto številko najde drugo hišo. Izbrane zadetke zato pred zapisom preglejte.",
        en: "The register has already answered for every house in Slovenia. Select the unambiguous matches in one click, Select confident. But beware: a match is confident only because the spelling agrees with today's register, not because it is surely the right house. If a house is written with an old number, the register does not know it, or finds another house under the same number. So review the selected matches before writing them.",
      },
      run: async (d) => {
        const pick = visible(d, ".tools-issue-link").filter({ hasText: d.t({ sl: "Izberi zanesljive", en: "Select confident" }) }).first();
        await d.highlight(pick, 4);
        await d.wait(1200);
        await d.click(pick);
        await d.wait(1500);
        await d.highlight(null);
        // The picks, for review: the »Izbrani« chip lists exactly them.
        const chosen = visible(d, "button.tools-chip").filter({ hasText: d.t({ sl: "Izbrani", en: "Picked" }) }).first();
        await d.click(chosen);
        await d.wait(800);
        await expandAll(d);
        await d.wait(6000);
      },
    },
    {
      callout: { sl: "Zapisano dvakrat", en: "Written twice" },
      say: {
        sl: "Ista hiša je včasih zapisana dvakrat: enkrat s hišnim imenom v oklepaju, enkrat brez njega. Gumb »Združi« oba zapisa poenoti.",
        en: "The same house is sometimes written twice: once with its farm name in parentheses, once without. The Merge button makes the two one.",
      },
      run: async (d) => {
        await d.click(visible(d, "button.tools-chip").filter({ hasText: d.t({ sl: "Zapisano dvakrat", en: "Written twice" }) }).first());
        await d.wait(800);
        // Krasinec 26 and Krasinec 26 (pd Jelin): neither has a position of its
        // own yet, so joining them raises no disagreement about where it is.
        await filterTo(d, "Krasinec 26");
        await expandAll(d);
        await d.wait(1000);
        const join = visible(d, ".tools-issue-link").filter({ hasText: new RegExp(`^${d.t({ sl: "Združi", en: "Join" })}$`) }).first();
        await d.highlight(join.locator(".."), 4);
        await d.wait(1800);
        await d.highlight(null);
        await d.click(join);
        await d.wait(1500);
        await filterTo(d, "");
        await d.click(visible(d, "button.tools-chip").filter({ hasText: new RegExp(`^${d.t({ sl: "Vsi", en: "All" })}`) }).last());
        await d.wait(800);
      },
    },
    {
      callout: { sl: "Zapiši koordinate", en: "Write coordinates" },
      say: {
        sl: "Koordinate se zapišejo šele, ko kliknete »Zapiši koordinate«, in sicer kot standardni zapis v GEDCOM, ki ga berejo tudi drugi programi.",
        en: "The coordinates are written only when you click Write coordinates — as standard GEDCOM, which other programs read too.",
      },
      run: async (d) => {
        const apply = visible(d, ".tools-run.primary").filter({ hasText: d.t({ sl: "Zapiši koordinate", en: "Write coordinates" }) }).first();
        await d.highlight(apply, 4);
        await d.wait(1200);
        await d.highlight(null);
        await d.click(apply);
        await d.wait(2500);
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
