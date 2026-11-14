/**
 * Video 13 (SCENARIJI.md, "Kraji in naslovi"): the GURS address register
 * downloaded on camera, the Places tree, a place's other names, the naming
 * check of addresses, and geocoding houses — including the way to write a house
 * that has had several numbers: the present address first, the older ones after
 * a slash, an optional note in parentheses.
 *
 * Data: `rodbina-renko.ged` — an anonymised excerpt of the author's tree
 * (GEDCOM 7.0), its places geocoded to the settlement, 255 of its houses placed
 * and 227 not yet. »bolnišnica / klinični center« (13 events in Ljubljana) is
 * the University Medical Centre, Zaloška cesta 2; »Krasinec 11 / 2 (pd Hren)«
 * is today's Krasinec 11, placed so far at the village centre; Klošter 52 is
 * today's Klošter 11.
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

/** The header's Settings button, by its label — the icons beside it differ
 *  before and after a file is open. */
const settingsButton = (d: Director) =>
  d.page.locator(`button.nav-btn.icon-only[aria-label="${d.t({ sl: "Nastavitve", en: "Settings" })}"]`).first();

/** Settings › Map, on camera. */
async function openMapSettings(d: Director): Promise<void> {
  await d.click(settingsButton(d));
  await d.click(tab(d, { sl: "Zemljevid", en: "Map" }));
}

/** Close the coordinate panel if it is still open — Escape with nothing open
 *  leaves Geocoding for the Places page, so it is pressed only when needed. */
async function closeCoordPanel(d: Director): Promise<void> {
  if (await visible(d, ".edit-coord-results").first().isVisible()) {
    await d.page.keyboard.press("Escape");
    await d.wait(800);
  }
  await frameTools(d);
}

/** »Prikaži že umeščene« over the address list. */
const showPlaced = (d: Director) =>
  visible(d, "label.tools-reshape-site").filter({ hasText: d.t({ sl: "Prikaži že umeščene", en: "Show already placed" }) }).first();

/**
 * Scroll the Tools page so the row of tool cards (Statistics, Places, Sources…)
 * sits above the picture and what the step is about fills it — as far as the
 * page is long enough to scroll.
 */
async function frameTools(d: Director): Promise<void> {
  await d.page.evaluate(() => {
    // The Tools page scrolls inside .tools-view, under the app's header.
    const view = document.querySelector<HTMLElement>(".tools-view");
    const tabs = [...document.querySelectorAll<HTMLElement>(".tools-tab")].filter((e) => e.offsetParent);
    if (!view || !tabs.length) return;
    // A click's scroll-into-view can also move the containers around the view
    // (even overflow-hidden ones), taking the app's header out of the
    // picture; they are put back at the top.
    for (let el = view.parentElement; el; el = el.parentElement) if (el.scrollTop) el.scrollTop = 0;
    const bottom = Math.max(...tabs.map((t) => t.getBoundingClientRect().bottom));
    const top = view.getBoundingClientRect().top;
    view.scrollTo({ top: view.scrollTop + bottom - top + 8, behavior: "smooth" });
  });
  await d.wait(350);
}

/** A click for passing through — the pointer travels there quickly — used on
 *  the way between screens, where the default glide would leave a silence. */
async function quickClick(d: Director, target: ReturnType<Director["page"]["locator"]>): Promise<void> {
  await d.point(target, 250);
  const box = await target.boundingBox();
  if (box) await d.overlay("click", box.x + box.width / 2, box.y + box.height / 2);
  await target.click();
  await d.wait(150);
}

/** Scroll the Tools view so `target` sits a little below its top — the view
 *  alone, with the containers around it put back, so the app's header and
 *  footer stay where they belong. */
async function frameAt(d: Director, target: ReturnType<Director["page"]["locator"]>): Promise<void> {
  await target.evaluate((el) => {
    const view = el.closest<HTMLElement>(".tools-view");
    if (!view) return;
    for (let p = view.parentElement; p; p = p.parentElement) if (p.scrollTop) p.scrollTop = 0;
    const offset = el.getBoundingClientRect().top - view.getBoundingClientRect().top;
    view.scrollTo({ top: view.scrollTop + offset - 24, behavior: "smooth" });
  });
  await d.wait(350);
}

/** »Razširi vse«, unless the list is open already (it then offers »Strni vse«). */
async function expandAll(d: Director): Promise<void> {
  const expand = link(d, { sl: "Razširi vse", en: "Expand all" });
  if (await expand.isVisible()) await quickClick(d, expand);
  await frameTools(d);
}

/** Type into the list's filter, the way a viewer would. */
async function filterTo(d: Director, text: string): Promise<void> {
  const box = filterBox(d);
  // The filter sits just under the tool cards: framing first brings it to the
  // top, so the click needs no scroll that would show the cards again.
  await frameTools(d);
  await quickClick(d, box);
  await box.fill("");
  if (text) await d.page.keyboard.type(text, { delay: 35 });
  await d.wait(400);
  await frameTools(d);
}

/** Open a rename box (✎ beside `target`) and replace its text. */
async function rename(
  d: Director,
  pencil: ReturnType<Director["page"]["locator"]>,
  text: string,
  how: "replace" | "append" | "prepend" = "replace",
): Promise<void> {
  await d.click(pencil);
  await d.wait(600);
  const input = visible(d, ".tools-place-rename-input").first();
  await input.waitFor();
  await d.click(input);
  // The box opens holding the address as written: append types after it,
  // prepend before it, replace writes over it.
  await d.page.keyboard.press(how === "append" ? "End" : how === "prepend" ? "Home" : "ControlOrMeta+a");
  await d.page.keyboard.type(text, { delay: 70 });
  await d.wait(700);
}

const applyRename = (d: Director) =>
  visible(d, "button").filter({ hasText: new RegExp(`^(${d.t({ sl: "Preimenuj", en: "Rename" })}|${d.t({ sl: "Združi", en: "Merge" })})$`) }).first();

const scenario: Scenario = {
  id: "addresses",
  episode: 13,
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
  // The GURS settlements, downloaded on camera in episode 6, are already in
  // this browser when the episode opens; only the addresses are new.
  prepare: async (d) => {
    await settingsButton(d).click();
    await tab(d, { sl: "Zemljevid", en: "Map" }).click();
    await modal(d).locator(".tools-geo-sources button", { hasText: d.t({ sl: "Kraji", en: "Places" }) }).first().click();
    await modal(d).getByText("SI-GURS").first().waitFor({ timeout: 120_000 });
    await modal(d).locator(".modal-close").click();
    await modal(d).waitFor({ state: "detached" });
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
        // Room below every page, so a short Tools list can still be scrolled
        // past the tool cards (frameTools) — the recording's, not the app's.
        await d.page.addStyleTag({ content: ".tools-view { padding-bottom: 100vh; } .app { overflow: clip !important; }" });
        // Only the Tools view scrolls: a click's scroll-into-view would also
        // move the containers around it and take the app's header out of the
        // picture, so any of them that moves is put straight back.
        await d.page.evaluate(() =>
          document.addEventListener(
            "scroll",
            (e) => {
              const el = e.target === document ? document.scrollingElement : (e.target as Element);
              const view = document.querySelector(".tools-view");
              if (el && view && el !== view && el.contains(view) && el.scrollTop) el.scrollTop = 0;
            },
            true,
          ),
        );
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
        sl: "Imenik krajev GURS smo naložili že v videu o geokodiranju. Za hišne številke zdaj v Nastavitvah na zavihku »Zemljevid« ob njem kliknite še »Naslovi«. To je vseh petsto osemdeset tisoč hiš v Sloveniji, vsaka s svojo koordinato. Prenos traja nekaj minut, register pa ostane v brskalniku. Nastavitve lahko medtem zaprete in delate naprej, saj se register nalaga v ozadju.",
        en: "We loaded the GURS place directory in the geocoding video. For house numbers, now click Addresses beside it, in Settings on the Map tab. That is all five hundred and eighty thousand houses in Slovenia, each with its own coordinate. The download takes a few minutes, and the register stays in your browser. Meanwhile you can close Settings and carry on working: the register loads in the background.",
      },
      run: async (d) => {
        await openMapSettings(d);
        const sources = modal(d).locator(".tools-geo-sources").first();
        await d.scrollTo(sources);
        await d.highlight(modal(d).getByText("SI-GURS").first().locator(".."), 6);
        await d.wait(2000);
        const addresses = sources.locator("button", { hasText: d.t({ sl: "Naslovi", en: "Addresses" }) }).first();
        await d.highlight(addresses, 6);
        await d.wait(1200);
        await d.click(addresses);
        await d.highlight(null);
        // The progress bar stays up while the narration explains it; Settings
        // closes on its last sentence — »Nastavitve lahko medtem zaprete« —
        // and the episode carries on while the register downloads
        // (geoImport.ts runs it outside the dialog); the naming step waits for it.
        await d.untilSaid(4.5);
        await d.click(modal(d).locator(".modal-close"));
        await modal(d).waitFor({ state: "detached" });
        // The next chapter is named as soon as Settings has closed; the way to
        // its screen runs once the narration is done, so the next sentence
        // starts on the screen it talks about.
        await d.calloutAhead();
        await d.untilSaid();
        await d.click(d.page.locator(".seg-btn").nth(2));
        await d.wait(400);
        await d.click(d.page.locator(".tools-tab", { hasText: d.t({ sl: "Kraji", en: "Places" }) }).first());
        await frameTools(d);
      },
    },
    {
      callout: { sl: "Drevo krajev", en: "The places tree" },
      say: {
        sl: "V Orodjih, pod »Kraji«, so kraji zbrani v drevo: država, občina, naselje in hiša. Ob vsakem je število zapisov in koordinata.",
        en: "In Tools, under Places, the places form a tree: country, municipality, settlement and house. Each shows how many records use it, and its coordinate.",
      },
      run: async (d) => {
        await d.click(treeRow(d, "Slovenia").locator(".tools-tree-label"));
        await d.wait(1200);
        await d.click(treeRow(d, "Kranj").locator(".tools-tree-label"));
        await d.wait(800);
        // Kranj near the top, so the names editor of the next step opens
        // below it without scrolling anything else.
        await frameAt(d, kranjTown(d));
        await d.highlight(kranjTown(d), 4);
        await d.wait(2500);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Druga imena", en: "Other names" },
      say: {
        sl: "Kraj ima lahko tudi stara ali tuja imena — to omogoča le zapis GEDCOM 7, v katerem je ta datoteka. Kliknite svinčnik, dodajte ime, na primer nemško Krainburg, in kliknite »Zapiši imena«. Iskanje kraj odslej najde tudi po tem imenu.",
        en: "A place can also carry old or foreign names — only GEDCOM 7 can record them, and this file is GEDCOM 7. Click the pencil, add a name — the German Krainburg, say — and click Write names. From then on the search finds the place by that name too.",
      },
      run: async (d) => {
        await d.click(kranjTown(d).locator(".tools-place-edit-btn").first());
        await d.wait(800);
        // The box opens on its own completions; they cover the names below.
        await blur(d);
        await d.wait(500);
        const add = link(d, { sl: "+ Dodaj ime", en: "+ Add a name" });
        await frameAt(d, kranjTown(d));
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
        // Naming opens once this step's narration is done; its own narration
        // starts on it while the address register may still be downloading.
        await d.untilSaid();
        await d.calloutAhead();
        await quickClick(d, link(d, { sl: "Poimenovanje", en: "Naming" }));
        await frameTools(d);
      },
    },
    {
      callout: { sl: "Poimenovanje", en: "Naming" },
      say: {
        sl: "Poimenovanje primerja kraje in naslove z uradnim registrom: kako je ime zapisano, kam kraj spada in kje leži. Kraji se v tem drevesu ujemajo vsi.",
        en: "Naming compares places and addresses with the official register: how a name is spelt, where a place belongs and where it lies. In this tree the places all agree.",
      },
      run: async (d) => {
        await d.wait(1500);
        await d.highlight(visible(d, ".tools-clean").first(), 4);
        await d.wait(3000);
        await d.highlight(null);
        // The address register downloads behind all this; the Addresses tab
        // appears once it is stored. The wait is cut to two seconds.
        await d.untilSaid();
        await d.skippable(() => link(d, /^(Naslovi|Addresses)/).waitFor({ timeout: 2_400_000 }), 2);
        await frameTools(d);
      },
    },
    {
      say: {
        sl: "Register naslovov se je medtem naložil, zato je tu še zavihek »Naslovi«. »Drugo naselje«: hiša Krasinec 1 je zapisana pod Gradcem, kjer je pošta, register pa jo vodi v Krasincu. »Zapis«: naslov Kidričeva 38a register piše kot »Kidričeva cesta 38a«.",
        en: "The address register has loaded meanwhile, so there is now an Addresses tab too. »Other settlement«: the house Krasinec 1 is written under Gradac, where the post office is, but the register files it under Krasinec. »Spelling«: the register spells Kidričeva 38a as »Kidričeva cesta«.",
      },
      run: async (d) => {
        await d.wait(400);
        await d.highlight(visible(d, "*").getByText("SI-ADR", { exact: true }).first().locator(".."), 4);
        await d.wait(2000);
        await d.highlight(null);
        await d.click(link(d, /^(Naslovi|Addresses)/));
        await frameTools(d);
        await d.skippable(() => noSuchAddress(d).waitFor({ timeout: 120_000 }));
        await d.wait(600);
        await expandAll(d);
        await d.wait(1200);
        await d.highlight(finding(d, "Krasinec 1"), 4);
        await d.wait(4500);
        await d.highlight(finding(d, "Kidričeva 38a"), 4);
        await d.wait(3500);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "»Premakni dogodke« prestavi dogodke v pravo naselje, naslov pa ostane. »Prevzemi« naslov prepiše v uradni zapis, pripis v oklepaju pa ostane. Hišnih številk, ki jih register nima več, seznam ne našteje, ampak jih le prešteje: vasi so hiše v dvajsetem stoletju na novo oštevilčile. Za tako staro številko je treba najti današnji naslov hiše in koordinato vzeti od tam.",
        en: "Move events puts the events in the right settlement, and the address stays. Use official name rewrites the address in the official spelling, and the note in parentheses stays. House numbers the register no longer has are counted, not listed: villages renumbered their houses in the twentieth century. For such an old number, find the house's present address and take the coordinate from there.",
      },
      run: async (d) => {
        const move = finding(d, "Krasinec 1").locator(".tools-issue-link").filter({ hasText: d.t({ sl: "Premakni dogodke", en: "Move events" }) }).first();
        await d.highlight(move, 4);
        await d.wait(1500);
        await d.highlight(null);
        await d.click(move);
        await d.wait(2500);
        const take = finding(d, "Kidričeva 38a").locator(".tools-issue-link").filter({ hasText: new RegExp(`^${d.t({ sl: "Prevzemi", en: "Use official name" })}$`) }).first();
        await d.highlight(take, 4);
        await d.wait(1500);
        await d.highlight(null);
        await d.click(take);
        await d.wait(2000);
        await d.highlight(noSuchAddress(d), 6);
        await d.wait(3500);
        await d.highlight(null);
        await d.untilSaid();
        await d.calloutAhead();
      },
    },
    {
      callout: { sl: "Geokodiranje naslovov", en: "Geocoding addresses" },
      say: {
        sl: "Zdaj hišam dodamo koordinate. V Geokodiranju so na zavihku »Naslovi« vse hiše, razvrščene po krajih. Naložen imamo le slovenski register, zato je izbrana Slovenija. Hiša brez svoje lege podeduje koordinato naselja.",
        en: "Now the houses get their coordinates. In Geocoding, the Addresses tab lists every house, grouped by place. We have only the Slovenian register loaded, so Slovenia is picked. A house without a position of its own inherits the settlement's coordinate.",
      },
      run: async (d) => {
        // The way to Geocoding › Addresses, narrowed to Slovenia, runs under
        // the first sentence; the rest is said on that screen.
        await quickClick(d, link(d, { sl: "Nazaj na kraje", en: "Back to places" }));
        await quickClick(d, visible(d, "button.tools-chip").filter({ hasText: d.t({ sl: "Geokodiranje", en: "Geocoding" }) }).first());
        await quickClick(d, link(d, /^(Naslovi|Addresses) \d/));
        await quickClick(d, visible(d, "button.tools-chip").filter({ hasText: /Sloven(ija|ia)/ }).first());
        await frameTools(d);
        await d.wait(1500);
        await d.highlight(visible(d, "button.tools-chip").filter({ hasText: /Sloven(ija|ia)/ }).first(), 4);
        await d.wait(2500);
        await d.highlight(null);
        await d.untilSaid();
        await d.calloutAhead();
        // The hospital's house already carries a position: the list shows it
        // only with »Prikaži že umeščene«, switched without the pointer.
        await showPlaced(d).locator("input").check();
        await filterTo(d, "klinični");
        await expandAll(d);
      },
    },
    {
      callout: { sl: "Pripis v oklepaju", en: "A note in parentheses" },
      say: {
        sl: "Trinajst dogodkov ima naslov »bolnišnica / klinični center«. Napišimo pravi naslov, Zaloška cesta 2, opis pa dodajmo v oklepaju. Register hišo takoj najde. Zadetek potrdimo, da se zapiše tudi njegova koordinata.",
        en: "Thirteen events have the address »hospital / medical centre«. Let's write the real address, Zaloška cesta 2, and add the description in parentheses. The register finds the house at once. We confirm the answer, so its coordinate is written too.",
      },
      run: async (d) => {
        const row = addrRow(d, "bolnišnica / klinični center");
        await d.highlight(row, 4);
        await d.wait(1200);
        await d.highlight(null);
        await rename(d, row.locator("xpath=following-sibling::button[contains(@class,'tools-place-edit-btn')][1]"), "Zaloška cesta 2 (klinični center)");
        await d.click(applyRename(d));
        await d.wait(1500);
        const answer = hit(d, "Zaloška cesta 2, Ljubljana, 1000 Ljubljana");
        await d.highlight(answer, 4);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(answer);
        await d.wait(1500);
        await d.untilSaid();
        await d.calloutAhead();
        await filterTo(d, "Krasinec 11 /");
        await expandAll(d);
      },
    },
    {
      callout: { sl: "Več hišnih številk", en: "Several house numbers" },
      say: {
        sl: "Ta hiša je v zgodovini dobila dve številki. Zapisana je tako, kot priporočamo: najprej današnji naslov, Krasinec 11, nato za poševnico stara številka 2, na koncu pa v oklepaju še hišno ime.",
        en: "This house has had two numbers. It is written the way we recommend: the present address first, Krasinec 11, then the old number 2 after a slash, and the farm name in parentheses at the end.",
      },
      run: async (d) => {
        await d.wait(1500);
        await d.highlight(addrRow(d, "Krasinec 11 / 2 (pd Hren)"), 4);
        await d.wait(5000);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Program vsako številko poišče posebej in zadetke pokaže na zemljevidu. Hiša je bila doslej postavljena le na sredino vasi. Danes je to Krasinec 11, številka 2 pa pripada drugi hiši, zato izberemo Krasinec 11.",
        en: "The program looks each number up on its own and shows the answers on a map. So far the house was placed only at the village centre. Today it is Krasinec 11, while number 2 belongs to another house, so we pick Krasinec 11.",
      },
      run: async (d) => {
        // A click on an answer's coordinate opens the panel with every answer
        // on one map, under the numbers of the list — which is the house is a
        // question the map answers.
        await d.click(visible(d, "*").getByText("45.59111, 15.28021", { exact: true }).first());
        const panelHit = (line: string) => visible(d, ".edit-coord-results *").getByText(line, { exact: false }).first();
        await visible(d, ".leaflet-marker-icon").filter({ hasText: /^2$/ }).last().waitFor();
        await d.wait(1500);
        // In the order the narration names them: the village centre the house
        // stood at so far (3), then today's Krasinec 11 (1, the first number
        // written).
        await d.highlight(visible(d, ".leaflet-marker-icon").filter({ hasText: /^3$/ }).last(), 10);
        await d.wait(3000);
        await d.highlight(visible(d, ".leaflet-marker-icon").filter({ hasText: /^1$/ }).last(), 10);
        await d.wait(3000);
        await d.highlight(null);
        await d.snapshot();
        await d.click(panelHit("Krasinec 11, 8332 Gradac"));
        await d.wait(1500);
        await closeCoordPanel(d);
        await d.untilSaid();
        await d.calloutAhead();
        await filterTo(d, "Klošter 52");
        await expandAll(d);
      },
    },
    {
      callout: { sl: "Stara hišna številka", en: "An old house number" },
      say: {
        sl: "Hiša Klošter 52 ima staro številko, ki je register ne pozna. Danes je to Klošter 11. Današnji naslov zapišemo spredaj, staro številko za poševnico, in register hišo najde.",
        en: "The house Klošter 52 has an old number the register does not know. Today it is Klošter 11. We write the present address first and the old number after the slash, and the register finds the house.",
      },
      run: async (d) => {
        const row = addrRow(d, "Klošter 52");
        await d.highlight(row, 4);
        await d.wait(1500);
        await d.highlight(null);
        await rename(d, row.locator("xpath=following-sibling::button[contains(@class,'tools-place-edit-btn')][1]"), "Klošter 11 / ", "prepend");
        await d.click(applyRename(d));
        await d.wait(1500);
        const answer = hit(d, "Klošter 11, 8332 Gradac");
        await d.highlight(answer, 4);
        await d.wait(2000);
        await d.highlight(null);
        await d.click(answer);
        await d.wait(1200);
      },
    },
    {
      say: {
        sl: "Klik na koordinato odpre zemljevid. Povečajmo ga do posameznih hiš. Stara hiša je stala nekoliko nižje in desno od današnje številke 11, zato kliknemo nanjo in koordinato nastavimo tam. Tako hišo poiščete tudi, kadar je register sploh ne pozna.",
        en: "Clicking the coordinate opens a map. Let's zoom in to single houses. The old house stood a little lower and to the right of today's number 11, so we click there and set the coordinate on it. That is also how you find a house the register does not know at all.",
      },
      run: async (d) => {
        const coord = visible(d, ".tools-geo-coord-btn").first();
        await d.click(coord);
        const pin = visible(d, ".leaflet-marker-icon").filter({ hasText: /^1$/ }).last();
        await pin.waitFor();
        await d.wait(2000);
        // Zoomed with the wheel over pin 1: Leaflet zooms around the pointer,
        // so the house stays in view (the + control zooms around the centre
        // and pushes it out; a double click would also pick a point).
        await d.point(pin, 700);
        for (let i = 0; i < 2; i++) {
          const box = await pin.boundingBox();
          if (!box) break;
          await d.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await d.page.mouse.wheel(0, -240);
          await d.wait(1800);
        }
        await d.wait(1500);
        // The old house, a little below and to the right of today's number 11
        // (where the author places it): a click on the map types its
        // position into the box, and »Nastavi« takes it.
        const box = await pin.boundingBox();
        if (box) {
          const x = box.x + box.width / 2 + 38;
          const y = box.y + box.height / 2 + 30;
          await d.overlay("click", x, y);
          await d.page.mouse.click(x, y);
        }
        await d.wait(1500);
        const set = visible(d, "button, .tools-issue-link").filter({ hasText: new RegExp(`^${d.t({ sl: "Nastavi", en: "Set" })}$`) }).first();
        await d.highlight(set, 4);
        await d.wait(1000);
        await d.highlight(null);
        await d.click(set);
        await d.wait(2000);
        await d.untilSaid();
        await d.calloutAhead();
        await closeCoordPanel(d);
        await filterTo(d, "");
        // The hospital's placed house was listed with »Prikaži že umeščene«;
        // the switch goes off again here, where the whole list shows it, and
        // without the pointer.
        const placedSwitch = showPlaced(d).locator("input");
        if (await placedSwitch.isVisible()) await placedSwitch.uncheck();
      },
    },
    {
      callout: { sl: "Zapiši koordinate", en: "Write coordinates" },
      say: {
        sl: "Te lege smo preverili sami, zato jih zapišemo takoj, z gumbom »Zapiši koordinate«. Koordinate se zapišejo kot standardni zapis v GEDCOM, ki ga berejo tudi drugi programi.",
        en: "We checked these positions ourselves, so we write them now, with Write coordinates. They are written as standard GEDCOM, which other programs read too.",
      },
      run: async (d) => {
        const apply = visible(d, ".tools-run.primary").filter({ hasText: d.t({ sl: "Zapiši koordinate", en: "Write coordinates" }) }).first();
        await d.wait(1500);
        await d.highlight(apply, 4);
        await d.wait(1500);
        await d.highlight(null);
        await d.click(apply);
        await d.wait(2500);
        await d.untilSaid();
        await d.calloutAhead();
        await quickClick(d, visible(d, "button.tools-chip").filter({ hasText: d.t({ sl: "Zapisano dvakrat", en: "Written twice" }) }).first());
        // Krasinec 26 and Krasinec 26 (pd Jelin): neither has a position of its
        // own yet, so joining them raises no disagreement about where it is.
        await filterTo(d, "Krasinec 26");
        await expandAll(d);
      },
    },
    {
      callout: { sl: "Zapisano dvakrat", en: "Written twice" },
      say: {
        sl: "Ista hiša je včasih zapisana dvakrat: enkrat s hišnim imenom v oklepaju, enkrat brez njega. Gumb »Združi« oba zapisa poenoti.",
        en: "The same house is sometimes written twice: once with its farm name in parentheses, once without. The Merge button makes the two one.",
      },
      run: async (d) => {
        const join = visible(d, ".tools-issue-link").filter({ hasText: new RegExp(`^${d.t({ sl: "Združi", en: "Join" })}$`) }).first();
        await d.highlight(join.locator(".."), 4);
        await d.wait(1800);
        await d.highlight(null);
        await d.click(join);
        await d.wait(1500);
        await d.untilSaid();
        await d.calloutAhead();
        await quickClick(d, visible(d, "button.tools-chip").filter({ hasText: new RegExp(`^${d.t({ sl: "Vsi", en: "All" })}`) }).last());
        await filterTo(d, "");
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
      say: {
        sl: "Ker teh zadetkov še nismo pregledali, izbor počistimo z gumbom »Počisti izbor«. Tako se nobena hiša ne postavi na napačno mesto.",
        en: "Since we have not reviewed these matches yet, we clear the selection with Select none. That way no house is placed in the wrong spot.",
      },
      run: async (d) => {
        const clear = visible(d, ".tools-issue-link").filter({ hasText: d.t({ sl: "Počisti izbor", en: "Select none" }) }).first();
        await d.highlight(clear, 4);
        await d.wait(1500);
        await d.highlight(null);
        await d.click(clear);
        await d.wait(1200);
        // Back from the picks (none now) to the whole list.
        await quickClick(d, visible(d, "button.tools-chip").filter({ hasText: new RegExp(`^${d.t({ sl: "Vsi", en: "All" })}`) }).last());
        await d.wait(2000);
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
