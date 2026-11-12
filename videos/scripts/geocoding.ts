/**
 * Video 6 (SCENARIJI.md, "Kraji in geokodiranje"): the place directories — the
 * GURS settlement register for Slovenia, OpenStreetMap for the rest of the
 * world — then a place looked up while editing (written as settlement,
 * municipality, country, with its coordinate and map pin), an old bare place
 * converted to that form for all its mentions at once, and geocoding the rest.
 * House addresses get their own episode.
 *
 * Data: `preseren-hawlina-kraji.ged` — the Hawlina pedigree with most places
 * already in the full form (Vrba, Žirovnica, Slovenija) and a few left bare:
 * Kranj, Radovljica, Žirovnica, Osoje na Koroškem, and house numbers written into
 * the place (Žirovnica 7, Vrba 1), as many older files do; Mina Svetina's is moved
 * to the address on camera. Settlements and
 * municipalities as in the GURS register of spatial units; France Prešeren's
 * mother Mina Svetina died in Osoje (Ossiach) in Carinthia (Slovenska biografija).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import { seriesSettings } from "../lib/series.ts";
import type { Scenario, Text } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "preseren-hawlina-kraji.ged");

const modal = (d: Director) => d.page.locator(".settings-modal");
const tab = (d: Director, label: Text) => modal(d).locator("button", { hasText: d.t(label) }).first();
const blur = (d: Director) => d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const eventPlace = (d: Director, i: number) => d.page.locator(".edit-person .edit-event-place").nth(i);
const eventPin = (d: Director, i: number) => d.page.locator(".edit-person .edit-event-coord").nth(i);
const proposal = (d: Director, register: string, text?: string) => {
  const items = d.page.locator(".suggest-item").filter({ visible: true }).filter({ hasText: register });
  return (text ? items.filter({ hasText: text }) : items).first();
};

/** »Poišči ta kraj v imenikih« at the foot of the open place dropdown, then
 *  the wait for the registers to answer (online ones take a moment). */
async function lookUp(d: Director, register: string): Promise<void> {
  const foot = d.page.locator(".suggest-list-foot button").filter({ visible: true }).first();
  await d.click(foot);
  await d.skippable(() => proposal(d, register).waitFor({ timeout: 60_000 }));
  await d.wait(600);
}

/** The row of a bare place in the Tools → Places tree. The last match: once a
 *  place has been converted the tree groups Slovenia by municipality, so the
 *  name can also head a municipality above, while the bare entries stay last,
 *  under »Neznana država«. */
const placeRow = (d: Director, name: string) =>
  d.page.locator(".tools-tree-row").filter({ has: d.page.getByText(name, { exact: true }) }).last();

/** Rename one bare place from the directories: ✎, look up, pick, apply. */
async function convert(d: Director, name: string, pick: string): Promise<void> {
  const row = placeRow(d, name);
  await d.click(row.locator(".tools-place-edit-btn").first());
  await d.wait(600);
  await lookUp(d, "SI-GURS");
  await d.highlight(d.page.locator(".suggest-list").filter({ visible: true }).first(), 4);
  await d.wait(1500);
  await d.highlight(null);
  await d.click(proposal(d, "SI-GURS", pick));
  await d.wait(900);
  const apply = d.page
    .locator("button")
    .filter({ visible: true })
    .filter({ hasText: new RegExp(`^(${d.t({ sl: "Preimenuj", en: "Rename" })}|${d.t({ sl: "Združi", en: "Merge" })})$`) })
    .first();
  await d.highlight(apply, 4);
  await d.wait(900);
  await d.click(apply);
  await d.highlight(null);
  await d.wait(900);
}

const scenario: Scenario = {
  id: "geocoding",
  episode: 6,
  settings: seriesSettings,
  title: {
    sl: "GED Merge: kraji in geokodiranje — imenik GURS in OpenStreetMap",
    en: "GED Merge: places and geocoding — the GURS register and OpenStreetMap",
  },
  description: {
    sl: "Kako v GED Merge kraje poiščete v imenikih: prenos uradnega imenika naselij GURS za Slovenijo, OpenStreetMap za preostali svet, iskanje kraja pri urejanju dogodka, pretvorba starih zapisov v obliko naselje, občina, država ter geokodiranje, ki krajem doda koordinate za zemljevid. Primer: rodovnik pesnika Franceta Prešerna.",
    en: "How GED Merge looks places up in directories: downloading the official GURS settlement register for Slovenia, OpenStreetMap for the rest of the world, looking a place up while editing an event, converting old entries to the settlement, municipality, country form, and geocoding, which gives places the coordinates a map needs. Example: the pedigree of the poet France Prešeren.",
  },
  thumbnail: {
    tag: { sl: "Kraji", en: "Places" },
    title: { sl: "Vsak kraj na *pravem* mestu", en: "Every place in the *right* spot" },
  },
  steps: [
    {
      say: {
        sl: "Kraj brez koordinate ne pride na zemljevid. Pokažimo, kako v GED Merge kraje poiščete v imenikih, jih zapišete enotno in postavite na zemljevid.",
        en: "A place without a coordinate never reaches the map. Let's see how GED Merge looks places up in directories, writes them consistently and puts them on the map.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Kraji in geokodiranje", en: "Places and geocoding" },
          { sl: "Imenik GURS in OpenStreetMap", en: "The GURS register and OpenStreetMap" },
        );
      },
    },
    {
      say: {
        sl: "Odprimo rodovnik pesnika Franceta Prešerna. Večina krajev je zapisana kot naselje, občina in država, nekaj pa jih je še v stari obliki: samo ime naselja, včasih skupaj s hišno številko.",
        en: "Let's open the pedigree of the poet France Prešeren. Most of its places are written as settlement, municipality and country, but a few are still in the old form: the settlement's name alone, sometimes with a house number.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(700);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.overlay("hideCursor");
        await d.wait(1500);
        await d.highlight(eventPlace(d, 0), 4);
        await d.wait(2500);
        await d.highlight(eventPlace(d, 1), 4);
        await d.wait(2000);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Spletna iskanja", en: "Online lookups" },
      say: {
        sl: "Program bo podatke o krajih dobil s spleta: prenesel bo imenik GURS in kraje iskal na OpenStreetMap. Zato najprej v Nastavitvah na zavihku »Napredno« vklopite »Poišči podatke na spletu«. Poslano je le ime kraja, nikoli vaše drevo.",
        en: "The program gets its place data from the web: it downloads the GURS directory and searches OpenStreetMap. So first, in Settings on the Advanced tab, switch on Look up details online. Only the place's name is sent, never your tree.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".nav-btn.icon-only:not(.undo-btn):not(.charts-open-btn):not(.shortcuts-btn)").nth(2));
        await d.click(tab(d, { sl: "Napredno", en: "Advanced" }));
        const row = modal(d).locator("label", { hasText: d.t({ sl: "Poišči podatke na spletu", en: "Look up details online" }) }).first();
        await d.highlight(row, 4);
        await d.wait(1200);
        await d.click(row.locator("input"));
        await d.wait(1200);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Zemljevidi", en: "Maps" },
      say: {
        sl: "Na zavihku »Zemljevid« vklopite še »Nalagaj ploščice zemljevida«, da zemljevidi dobijo pravo podlago.",
        en: "On the Map tab, also switch on Load base-map tiles, so the maps get a real background.",
      },
      run: async (d) => {
        await d.click(tab(d, { sl: "Zemljevid", en: "Map" }));
        const row = modal(d).locator("label", { hasText: d.t({ sl: "Nalagaj ploščice zemljevida", en: "Load base-map tiles" }) }).first();
        await d.scrollTo(row);
        await d.highlight(row, 4);
        await d.wait(1000);
        await d.click(row.locator("input"));
        await d.wait(1200);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Imenik GURS", en: "The GURS register" },
      say: {
        sl: "Nato zgoraj, pri imenikih krajev, prenesite imenik. Za Slovenijo izberite GURS, uradni register vseh šest tisoč slovenskih naselij skupaj z občinami. Prenos traja nekaj sekund, imenik pa ostane v brskalniku in služi vsem vašim datotekam.",
        en: "Then, up under the place directories, download a directory. For Slovenia choose GURS, the official register of all six thousand Slovenian settlements with their municipalities. It downloads in seconds and stays in your browser for every file you open.",
      },
      run: async (d) => {
        const sources = modal(d).locator(".tools-geo-sources").first();
        await d.scrollTo(sources);
        const gurs = sources.locator("button", { hasText: d.t({ sl: "Kraji", en: "Places" }) }).first();
        await d.highlight(gurs.locator(".."), 6);
        await d.wait(1500);
        await d.click(gurs);
        await d.skippable(() => modal(d).getByText("SI-GURS").first().waitFor({ timeout: 120_000 }));
        await d.wait(800);
        await d.highlight(modal(d).getByText("SI-GURS").first().locator(".."), 6);
        await d.wait(1500);
      },
    },
    {
      say: {
        sl: "Gumb »Naslovi« prenese še vse hišne številke; te si ogledamo v posebnem videu. OpenStreetMap pa je najbolj uporaben za kraje zunaj Slovenije.",
        en: "The Addresses button also downloads every house number; those get a video of their own. OpenStreetMap is most useful for places outside Slovenia.",
      },
      run: async (d) => {
        const sources = modal(d).locator(".tools-geo-sources").first();
        await d.highlight(sources.locator("button", { hasText: d.t({ sl: "Naslovi", en: "Addresses" }) }).first(), 6);
        await d.wait(3000);
        await d.highlight(sources.locator(".tools-geo-osm").first(), 6);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(modal(d).locator(".modal-close"));
        await modal(d).waitFor({ state: "detached" });
      },
    },
    {
      callout: { sl: "Kraj iz imenika", en: "A place from the directory" },
      say: {
        sl: "Prešernova smrt ima kraj še v stari obliki, samo »Kranj«. Kliknite polje kraja in izberite »Poišči ta kraj v imenikih«.",
        en: "Prešeren's death still has its place in the old form, just Kranj. Click the place field and choose Look this place up in the directories.",
      },
      run: async (d) => {
        await d.click(eventPlace(d, 1));
        await d.wait(700);
        await lookUp(d, "SI-GURS");
      },
    },
    {
      say: {
        sl: "Predlogi so zapisani tako kot drugi kraji v vaši datoteki: naselje, občina, država. Oznaka ob predlogu pove, iz katerega imenika je. Izberimo Kranj.",
        en: "The offers are written like the other places in your file: settlement, municipality, country. The tag beside each says which directory it comes from. Let's pick Kranj.",
      },
      run: async (d) => {
        await d.highlight(d.page.locator(".suggest-list").filter({ visible: true }).first(), 4);
        await d.wait(3500);
        await d.highlight(null);
        await d.click(proposal(d, "SI-GURS", "Kranj, Kranj,"));
        await blur(d);
        await d.wait(800);
        await d.snapshot();
      },
    },
    {
      callout: { sl: "Žebljiček", en: "The pin" },
      say: {
        sl: "Kraj je dobil tudi koordinato. Zelen žebljiček ob kraju pomeni, da ima koordinato, siv pa, da je še nima. Pod dogodki se zato pokaže zemljevid krajev.",
        en: "The place has received a coordinate too. A green pin beside a place means it has a coordinate; a grey one means it has none yet. That is why a map of places now appears below the events.",
      },
      run: async (d) => {
        await d.highlight(eventPin(d, 1), 8);
        await d.point(eventPin(d, 1));
        await d.wait(2200);
        await d.highlight(eventPin(d, 0), 8);
        await d.point(eventPin(d, 0));
        await d.wait(2200);
        const map = d.page.locator(".edit-person-map").first();
        await d.scrollTo(map);
        await d.highlight(map, 6);
        await d.wait(2000);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Naslov", en: "Address" },
      say: {
        sl: "Prešernova mati Mina se je rodila na hišni številki Žirovnica 7, ki je zapisana kar v kraju. Poiščimo kraj v imeniku. Žirovnic je v Sloveniji več, zato se odločimo po občini: Mina je doma iz občine Žirovnica.",
        en: "Prešeren's mother Mina was born at house number Žirovnica 7, written straight into the place. Let's look the place up. Slovenia has several Žirovnicas, so the municipality decides: Mina came from the municipality of Žirovnica.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".person-card").filter({ hasText: "Mina Svetina" }).filter({ visible: true }).first());
        await d.wait(900);
        await d.highlight(eventPlace(d, 0), 4);
        await d.wait(1200);
        await d.highlight(null);
        await d.click(eventPlace(d, 0));
        await d.wait(600);
        await lookUp(d, "SI-GURS");
        await d.highlight(d.page.locator(".suggest-list").filter({ visible: true }).first(), 4);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(proposal(d, "SI-GURS", "Žirovnica, Žirovnica,"));
        await blur(d);
        await d.wait(900);
      },
    },
    {
      say: {
        sl: "Hišno številko vpišemo v polje »Naslov«, ki ga dodate z gumbom »Dodaj«. To je standardni zapis v GEDCOM: kraj pove naselje, občino in državo, naslov pa ulico in hišno številko.",
        en: "The house number goes into the Address field, which you add with the Add button. That is the standard way GEDCOM writes it: the place names the settlement, municipality and country, the address the street and house number.",
      },
      run: async (d) => {
        const add = d.page.locator(".edit-person .edit-event-addfield").first();
        await add.hover({ force: true });
        await d.click(add);
        await d.click(d.page.locator(".dd-item", { hasText: d.t({ sl: "Naslov", en: "Address" }) }).first());
        const addr = d.page.locator(".edit-person .edit-event-addr").first();
        await addr.waitFor();
        await d.click(addr);
        await d.page.keyboard.type("Žirovnica 7", { delay: 120 });
        await blur(d);
        await d.wait(900);
        await d.highlight(addr, 4);
        await d.wait(2000);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "OpenStreetMap", en: "OpenStreetMap" },
      say: {
        sl: "Mina je umrla v Osojah na Koroškem, v Avstriji. Tega kraja GURS ne pozna, OpenStreetMap pa ga najde pod nemškim imenom Ossiach in ga zapiše po slovensko.",
        en: "Mina died in Ossiach in Carinthia, Austria. GURS does not know it, but OpenStreetMap finds it under its German name and writes it in the language of your file.",
      },
      run: async (d) => {
        const place = eventPlace(d, 1);
        await d.click(place);
        await d.page.keyboard.press("ControlOrMeta+a");
        await d.page.keyboard.type("Ossiach", { delay: 120 });
        await d.wait(700);
        await lookUp(d, "OSM");
        await d.highlight(proposal(d, "OSM"), 4);
        await d.wait(1800);
        await d.highlight(null);
        await d.click(proposal(d, "OSM"));
        await blur(d);
        await d.wait(1200);
        await d.highlight(eventPin(d, 1), 8);
        await d.wait(1500);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Stari zapisi", en: "Old entries" },
      say: {
        sl: "Druge stare zapise pretvorite v Orodjih, pod »Kraji«. Kraji brez države so zbrani pod »Neznana država«.",
        en: "Convert the other old entries in Tools, under Places. Places without a country are gathered under Unspecified country.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".seg-btn").nth(2));
        await d.wait(800);
        await d.click(d.page.locator(".tools-tab", { hasText: d.t({ sl: "Kraji", en: "Places" }) }).first());
        await d.wait(1000);
        await d.click(d.page.getByText(d.t({ sl: "Neznana država", en: "Unspecified country" }), { exact: true }).first());
        await d.wait(1200);
      },
    },
    {
      say: {
        sl: "Kliknite svinčnik ob kraju, ga poiščite v imenikih in kliknite »Preimenuj«. Sprememba velja za vse zapise tega kraja naenkrat, pri Radovljici kar za tri.",
        en: "Click the pencil beside a place, look it up in the directories and click Rename. The change applies to every entry of that place at once, three of them for Radovljica.",
      },
      run: async (d) => {
        await convert(d, "Radovljica", "Radovljica, Radovljica,");
      },
    },
    {
      say: {
        sl: "Enako pretvorimo še Žirovnico, spet tisto v občini Žirovnica. Ker je tak kraj v datoteki že zapisan, se zapisa združita.",
        en: "Žirovnica is converted the same way, again the one in the municipality of Žirovnica. Since the file already has that place, the two entries are merged.",
      },
      run: async (d) => {
        await convert(d, "Žirovnica", "Žirovnica, Žirovnica,");
      },
    },
    {
      callout: { sl: "Geokodiranje", en: "Geocoding" },
      say: {
        sl: "Ostalim krajem dodamo koordinate z geokodiranjem. Program vsak kraj primerja z imenikom. Zanesljive predloge izberete z enim klikom, dvoumne pregledate sami.",
        en: "The remaining places get their coordinates through geocoding. The program compares every place with the directory. You select the confident matches in one click and review the ambiguous ones yourself.",
      },
      run: async (d) => {
        await d.click(d.page.locator("button.tools-chip").nth(1));
        await d.wait(1500);
        const pick = d.page.locator(".tools-issue-link", { hasText: d.t({ sl: "Izberi zanesljive", en: "Select confident" }) }).first();
        await d.highlight(pick, 4);
        await d.wait(1200);
        await d.click(pick);
        await d.wait(1500);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Koordinate se zapišejo šele, ko kliknete »Zapiši koordinate«.",
        en: "The coordinates are written only when you click Write coordinates.",
      },
      run: async (d) => {
        const apply = d.page.locator(".tools-run.primary", { hasText: d.t({ sl: "Zapiši koordinate", en: "Write coordinates" }) }).first();
        await d.highlight(apply, 4);
        await d.wait(1200);
        await d.click(apply);
        await d.wait(1500);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Na zemljevidu", en: "On the map" },
      say: {
        sl: "V Urejanju imata zdaj oba Prešernova kraja zelen žebljiček, zemljevid pa pokaže pot od rojstva v Vrbi do smrti v Kranju.",
        en: "Back in Edit, both of Prešeren's places now have a green pin, and the map shows the way from his birth in Vrba to his death in Kranj.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".seg-btn").nth(0));
        await d.wait(600);
        await blur(d);
        await d.page.keyboard.press("h");
        await d.wait(1200);
        await d.highlight(eventPin(d, 0), 8);
        await d.wait(1500);
        await d.highlight(eventPin(d, 1), 8);
        await d.wait(1500);
        const map = d.page.locator(".edit-person-map").first();
        await d.scrollTo(map);
        await d.highlight(map, 6);
        await d.wait(2500);
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
