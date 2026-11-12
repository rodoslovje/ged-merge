/**
 * Video 7 (SCENARIJI.md, "Zemljevidi"): the map of places — clusters, finding a
 * place, the event and year filters, life paths, historical borders, free
 * historical maps added in Settings (the Austro-Hungarian Spezialkarte and the
 * Franciscan cadastre of Bitnje, 1826), layer opacity, the side-by-side view and
 * the PNG export.
 *
 * Data: `rodbina-renko.ged` — an anonymised excerpt of the author's tree (living
 * people other than the author and his parents have made-up names, dates and
 * sex), its places geocoded: Gorenjska around Kranj and Bitnje, Bela
 * krajina, Gorski kotar. The Bitnje cadastre is one of the bundled presets.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import { seriesSettings } from "../lib/series.ts";
import type { Lang, Scenario, Text } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "rodbina-renko.ged");

const modal = (d: Director) => d.page.locator(".settings-modal");
const chip = (d: Director, cls: string) => d.page.locator(`.map-kind-chip.${cls}`).first();
const kindChip = (d: Director, label: Text) => d.page.locator(".map-kind-chip", { hasText: d.t(label) }).first();
const yearTo = (d: Director) => d.page.locator(".map-year-input").nth(1);
const findField = (d: Director) =>
  d.page.locator(`input[placeholder*="${d.t({ sl: "Poišči osebo ali kraj", en: "Find a person or place" })}"]`).first();
const layerPick = (d: Director, name: string) => d.page.locator("label.map-overlay-pick", { hasText: name }).first();
const BITNJE = { sl: "Bitnje, vsa tri", en: "Bitnje" };
const GURS_LAYERS: Text[] = [
  { sl: "Katastrske občine", en: "Cadastral municipalities" },
  { sl: "Katastrske parcele", en: "Cadastral parcels" },
  { sl: "Hišne številke", en: "House numbers" },
];

/** Type into the map's find field and let the map fly to the first match. */
async function findOnMap(d: Director, text: string): Promise<void> {
  const field = findField(d);
  await d.click(field);
  await d.page.keyboard.press("ControlOrMeta+a");
  await d.page.keyboard.type(text, { delay: 90 });
  await d.page.keyboard.press("Enter");
  // The find opens the first match's events once the map has flown there;
  // the map is the point here, so the panel is closed as soon as it shows.
  const close = d.page.locator(".map-panel .modal-close").first();
  await close.waitFor({ timeout: 5000 }).catch(() => {});
  await d.wait(600);
  if (await close.isVisible()) {
    await d.click(close);
    await d.wait(500);
  }
  // An answered find stays live and opens its match again whenever the map
  // redraws (a year changed, a layer toggled); emptied, it leaves the map be.
  await field.fill("");
  await d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Click into the biggest cluster until a single place opens its list of events
 *  on the right — Srednje Bitnje, some thirty events since 1679. */
async function openCrowdedPlace(d: Director): Promise<void> {
  for (let k = 0; k < 6 && !(await d.page.locator(".map-panel").first().isVisible()); k++) {
    const idx = await d.page.evaluate(() => {
      let best = -1;
      let most = 0;
      document.querySelectorAll(".leaflet-marker-icon").forEach((e, i) => {
        const r = e.getBoundingClientRect();
        if (r.top < 330 || r.left < 120 || r.right > window.innerWidth - 120 || r.bottom > window.innerHeight - 60) return;
        const n = Number((e.textContent ?? "").trim());
        if (n > most) [best, most] = [i, n];
      });
      return best;
    });
    if (idx < 0) break;
    await d.click(d.page.locator(".leaflet-marker-icon").nth(idx));
    await d.wait(1800);
  }
}

/** Zoom the map in or out by clicking its own +/− control: the pointer moves
 *  there once, then clicks in quick succession. */
async function zoom(d: Director, by: number): Promise<void> {
  const btn = d.page.locator(by > 0 ? ".leaflet-control-zoom-in" : ".leaflet-control-zoom-out").first();
  await d.point(btn, 500);
  const box = await btn.boundingBox();
  for (let i = 0; i < Math.abs(by); i++) {
    if (box) await d.overlay("click", box.x + box.width / 2, box.y + box.height / 2);
    await btn.click();
    await d.wait(350);
  }
  await d.wait(500);
}

/** Move a range input to a fraction of its span, as a drag would. */
async function setRange(slider: ReturnType<Director["page"]["locator"]>, fraction: number): Promise<void> {
  await slider.evaluate((el, f) => {
    const input = el as HTMLInputElement;
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, String(Math.round(min + (max - min) * f)));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, fraction);
}

/** The Layers panel, opened unless it already is (its chip toggles it). */
async function openLayers(d: Director): Promise<void> {
  if (await d.page.locator("label.map-split-toggle").first().isVisible()) return;
  await d.click(chip(d, "map-overlays-chip"));
  await d.page.locator("label.map-split-toggle").first().waitFor();
  await d.wait(600);
}

/** …and closed again. Never with Escape: in the charts that leaves for Edit. */
async function closeLayers(d: Director): Promise<void> {
  if (!(await d.page.locator("label.map-split-toggle").first().isVisible())) return;
  await d.click(chip(d, "map-overlays-chip"));
  await d.wait(400);
}

/** Settings → Map: the base-map row, and one base map picked in it while
 *  the sample below redraws. */
const baseRow = (d: Director) =>
  modal(d).locator("label.settings-format-row", { hasText: d.t({ sl: "Osnovni zemljevid", en: "Base map" }) }).first();
async function pickBase(d: Director, label: Text): Promise<void> {
  const row = baseRow(d);
  await d.click(row.locator(".select-menu").first());
  await d.wait(400);
  await d.click(d.page.locator(".dd-item", { hasText: d.t(label) }).first());
  await d.skippable(() => d.wait(1000));
  await d.wait(900);
}

/** Close the place panel on the right, if one is open. */
async function closePanel(d: Director): Promise<void> {
  const close = d.page.locator(".map-panel .modal-close").first();
  if (await close.isVisible()) {
    await d.click(close);
    await d.wait(400);
  }
}

/** Drag the (left) map by an offset, as a hand would, with the pointer shown. */
async function pan(d: Director, dx: number, dy: number): Promise<void> {
  const box = await d.page.locator(".leaflet-container").first().boundingBox();
  if (!box) return;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await d.overlay("cursor", x, y, 600);
  await d.wait(700);
  await d.page.mouse.move(x, y);
  await d.page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    const px = x + (dx * i) / 20;
    const py = y + (dy * i) / 20;
    await d.page.mouse.move(px, py);
    await d.overlay("cursor", px, py, 40);
    await d.wait(50);
  }
  await d.page.mouse.up();
  // The real mouse off the map, so no cluster under it shows its tooltip.
  await d.page.mouse.move(2, 2);
}

/** One overlay preset picked in Settings → Map. */
async function addPreset(d: Director, label: Text): Promise<void> {
  const picker = modal(d).locator(".settings-overlay-preset").first();
  await d.click(picker);
  await d.wait(900);
  await d.click(d.page.locator(".dd-item", { hasText: d.t(label) }).first());
  await d.wait(500);
  // Each added layer lengthens the list below, so the picker can climb
  // further up the window: keep it as high as it goes, the list in view.
  await pickerToTop(d);
  await d.wait(700);
}

async function pickerToTop(d: Director): Promise<void> {
  await modal(d)
    .locator(".settings-overlay-preset")
    .first()
    .evaluate((e) => e.scrollIntoView({ behavior: "smooth", block: "start" }));
  await d.wait(500);
}

const settings = (lang: Lang) => ({ ...seriesSettings(lang), allowMapTiles: true, allowLinkFetch: true });

const scenario: Scenario = {
  id: "maps",
  episode: 7,
  settings,
  title: {
    sl: "GED Merge: zemljevidi — poti, meje in zgodovinske karte",
    en: "GED Merge: maps — paths, borders and historical maps",
  },
  description: {
    sl: "Kako v GED Merge postavite prednike na zemljevid: gruče dogodkov, iskanje kraja, izbira vrst dogodkov in obdobja, življenjske poti, meje v izbranem letu, brezplačne zgodovinske karte (avstrijska specialka, franciscejski kataster), vzporedni pogled in izvoz slike.",
    en: "How GED Merge puts your ancestors on the map: event clusters, finding a place, choosing event kinds and a period, life paths, borders in a chosen year, free historical maps (the Austrian Spezialkarte, the Franciscan cadastre), the side-by-side view and image export.",
  },
  thumbnail: {
    tag: { sl: "Zemljevid", en: "Maps" },
    title: { sl: "Prednik na *zgodovinski* karti", en: "Ancestors on a *historical* map" },
  },
  steps: [
    {
      say: {
        sl: "Kje so živeli vaši predniki? Postavimo jih na zemljevid, tudi na zgodovinskega.",
        en: "Where did your ancestors live? Let's put them on the map, a historical one included.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Zemljevidi", en: "Maps" },
          { sl: "Poti, meje in zgodovinske karte", en: "Paths, borders and historical maps" },
        );
      },
    },
    {
      say: {
        sl: "Tokrat odpremo večje drevo, rodbino Renko. Kraji v njem že imajo koordinate, kot smo jih dodali v prejšnjem videu.",
        en: "This time we open a larger tree, the Renko family. Its places already have their coordinates, added as in the previous video.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(700);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.overlay("hideCursor");
        await d.wait(1500);
      },
    },
    {
      callout: { sl: "Osnovni zemljevid", en: "Base map" },
      say: {
        sl: "Najprej si v Nastavitvah na zavihku »Zemljevid« izberite osnovni zemljevid, ki vam je najljubši: enostaven, OpenStreetMap, relief, satelitski ali topografski. Vzorec nad izbiro takoj pokaže, kako je videti.",
        en: "First, in Settings on the Map tab, choose the base map you like best: plain, OpenStreetMap, relief, satellite or topographic. The sample above the choice shows at once how it looks.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".nav-btn.icon-only:not(.undo-btn):not(.charts-open-btn):not(.shortcuts-btn)").nth(2));
        await d.click(modal(d).locator("button", { hasText: d.t({ sl: "Zemljevid", en: "Map" }) }).first());
        const row = baseRow(d);
        await d.scrollTo(row);
        await d.highlight(row, 4);
        await d.wait(800);
        await d.highlight(null);
        for (const label of [
          { sl: "Relief", en: "Relief" },
          { sl: "Satelitski", en: "Satellite" },
        ]) await pickBase(d, label);
      },
    },
    {
      say: {
        sl: "Mi izberemo OpenStreetMap, ki ob veliki povečavi pokaže tudi hišne številke.",
        en: "We pick OpenStreetMap, which at a close zoom even shows house numbers.",
      },
      run: async (d) => {
        await pickBase(d, { sl: "OpenStreetMap", en: "OpenStreetMap" });
        await d.highlight(null);
        await d.click(modal(d).locator(".modal-close"));
        await modal(d).waitFor({ state: "detached" });
        await d.wait(600);
      },
    },
    {
      callout: { sl: "Zemljevid krajev", en: "The map of places" },
      say: {
        sl: "Diagrame odprete s tipko V, zemljevid pa nato s tipko 6 ali z gumbom »Zemljevid«. Pokaže dogodke prednikov in potomcev izhodiščne osebe. Kraji, kjer je dogodkov več, se združijo v gruče s številom dogodkov.",
        en: "Open the charts with the V key, then the map with the 6 key or the Map button. It shows the events of the start person's ancestors and descendants. Where a place holds several events, they gather into a cluster with their count.",
      },
      run: async (d) => {
        await d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await d.page.keyboard.press("v");
        await d.wait(1500);
        const mapTab = d.page.locator(".charts-kind [role=tab]", { hasText: d.t({ sl: "Zemljevid", en: "Map" }) }).first();
        await d.highlight(mapTab, 4);
        await d.wait(900);
        await d.page.keyboard.press("6");
        await d.wait(1200);
        await d.highlight(null);
        await d.wait(2300);
        await d.highlight(d.page.locator(".leaflet-container").first(), 2);
        await d.wait(2000);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Iskalno polje desno zgoraj zemljevid premakne na kraj ali osebo. Poiščimo Zgornje Bitnje pri Kranju. Klik na gručo jo približa. Ko pridete do posameznega kraja, se na desni odpre seznam vseh dogodkov na njem: v Srednjih Bitnjah je to več kot trideset dogodkov, od leta 1679 naprej.",
        en: "The find field at the top right moves the map to a place or a person. Let's find Zgornje Bitnje near Kranj. Clicking a cluster zooms into it. Once you reach a single place, the list of all its events opens on the right: in Srednje Bitnje, more than thirty events from 1679 on.",
      },
      run: async (d) => {
        await findOnMap(d, "Zgornje Bitnje");
        await openCrowdedPlace(d);
        await d.highlight(d.page.locator(".map-panel").first(), 4);
        await d.wait(5000);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Nov koren", en: "A new root" },
      say: {
        sl: "Ikona z drevesom ob osebi v seznamu to osebo postavi za koren zemljevida. Njeno ime je zdaj v glavi, zemljevid pa pokaže le njene prednike in potomce, zato je dogodkov precej manj. S tipko H se vrnete k izhodiščni osebi.",
        en: "The tree icon beside a person in the list makes that person the root of the map. Their name is now in the header, and the map shows only their ancestors and descendants, so there are far fewer events. The H key brings you back to the start person.",
      },
      run: async (d) => {
        const root = d.page.locator(".map-panel .map-panel-rootbtn").first();
        await d.highlight(root, 6);
        await d.point(root);
        await d.wait(1800);
        await d.highlight(null);
        await d.click(root);
        await d.wait(600);
        await closePanel(d);
        // The name first, while it is being spoken of; then the map fitted to
        // the new root's places and the event count that has dropped.
        const name = d.page.locator(".tree-title-name").filter({ visible: true }).first();
        await d.highlight(name, 6);
        await d.wait(2200);
        await d.highlight(null);
        await d.click(d.page.locator(`[title="${d.t({ sl: "Prilagodi pogled prikazanim krajem", en: "Fit to the plotted places" })}"]`).first());
        await d.skippable(() => d.wait(2000));
        await d.highlight(d.page.locator(".map-count").first(), 6);
        await d.wait(2500);
        await d.highlight(null);
        await d.page.keyboard.press("h");
        await d.wait(1500);
        await d.highlight(d.page.locator(".tree-title-name").filter({ visible: true }).first(), 6);
        await d.wait(1800);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Poglejmo še vas od blizu. OpenStreetMap ob taki povečavi na hišah pokaže hišne številke. To so današnje hišne številke, ne zgodovinske.",
        en: "Let's zoom in on the village. At this zoom OpenStreetMap shows the house numbers on the houses. These are today's house numbers, not historical ones.",
      },
      run: async (d) => {
        await findOnMap(d, "Srednje Bitnje");
        await zoom(d, 5);
        await d.skippable(() => d.wait(2500));
        await d.wait(3500);
        await zoom(d, -5);
        await d.wait(1000);
      },
    },
    {
      callout: { sl: "Dogodki in obdobje", en: "Events and period" },
      say: {
        sl: "Zgoraj izberete, katere vrste dogodkov zemljevid riše, na primer rojstva, poroke, smrti ali bivališča. Z drsnikom let ali z vpisom letnic omejite obdobje. Prikažimo samo dogodke do leta 1870.",
        en: "At the top you choose which events the map draws: births, marriages, deaths, burials or residences. The year slider, or typing the years, limits the period. Let's show only events up to 1870.",
      },
      run: async (d) => {
        await closePanel(d);
        const marriage = kindChip(d, { sl: "Poroka", en: "Marriage" });
        await d.click(marriage);
        await d.wait(1500);
        await d.click(marriage);
        await d.wait(1000);
        const to = yearTo(d);
        await d.click(to);
        await d.page.keyboard.press("ControlOrMeta+a");
        await d.page.keyboard.type("1870", { delay: 120 });
        await d.page.keyboard.press("Enter");
        await d.wait(1500);
        await d.highlight(d.page.locator(".map-year-input").first().locator(".."), 4);
        await d.wait(1500);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Poti", en: "Paths" },
      say: {
        sl: "Gumb »Poti« poveže kraje v življenju vsake osebe, od rojstva prek bivališč do smrti, s puščicami v smeri poti. Tako hitro vidite, kdo se je priselil od drugod in kam so se odselili potomci.",
        en: "The Paths button joins the places of each person's life, from birth through residences to death, with arrows in the direction of travel. You see at a glance who moved in from elsewhere and where the descendants moved away to.",
      },
      run: async (d) => {
        await closePanel(d);
        await d.click(chip(d, "map-paths-chip"));
        await d.wait(8000);
        await d.click(chip(d, "map-paths-chip"));
        await d.wait(600);
      },
    },
    {
      callout: { sl: "Meje", en: "Borders" },
      say: {
        sl: "Gumb »Meje« nariše upravne meje v letu, ki ste ga vpisali pri »Do leta«: cesarstva, dežele in okraje iz zbirke OpenHistoricalMap. Leta 1870 je Kranj ležal v deželi Kranjski, Ravna Gora pa v Hrvaški.",
        en: "The Borders button draws the administrative borders in the year entered under To year: empires, lands and districts from OpenHistoricalMap. In 1870, Kranj lay in the Duchy of Carniola and Ravna Gora in Croatia.",
      },
      run: async (d) => {
        await zoom(d, -6);
        await d.click(chip(d, "map-borders-chip"));
        await d.skippable(() => d.wait(4000));
        await d.wait(3000);
      },
    },
    {
      callout: { sl: "Zgodovinske karte", en: "Historical maps" },
      say: {
        sl: "Dodatne sloje dodate v Nastavitvah na zavihku »Zemljevid«, pri »Dodaj brezplačen sloj«. Izberimo tri sloje GURS, katastrske občine, parcele in hišne številke, ter dve zgodovinski karti: avstro-ogrsko specialko in franciscejski kataster za Bitnje iz leta 1826. Sloj, ki je na seznamu višje, se izriše na vrhu.",
        en: "Extra layers are added in Settings, on the Map tab, under Add a free layer. Let's pick three GURS layers, cadastral municipalities, parcels and house numbers, and two historical maps: the Austro-Hungarian Spezialkarte and the Franciscan cadastre of Bitnje from 1826. A layer higher in the list is drawn on top.",
      },
      run: async (d) => {
        await d.click(chip(d, "map-borders-chip"));
        await d.click(d.page.locator(".nav-btn.icon-only:not(.undo-btn):not(.charts-open-btn):not(.shortcuts-btn)").nth(2));
        await d.click(modal(d).locator("button", { hasText: d.t({ sl: "Zemljevid", en: "Map" }) }).first());
        // The picker at the top of the window, so the layers it adds can be
        // seen joining the list below it.
        await pickerToTop(d);
        await d.wait(400);
        // The GURS layers first: the list's order is the drawing order, top
        // first, so the thin vector layers stay above the full-sheet maps.
        for (const layer of GURS_LAYERS) await addPreset(d, { sl: `${d.t(layer)} (GURS)`, en: `${d.t(layer)} (GURS)` });
        await addPreset(d, { sl: "Spezialkarte", en: "Spezialkarte" });
        await addPreset(d, BITNJE);
        await d.wait(1000);
        await d.click(modal(d).locator(".modal-close"));
        await modal(d).waitFor({ state: "detached" });
        await d.wait(800);
      },
    },
    {
      callout: { sl: "Sloji", en: "Layers" },
      say: {
        sl: "Na zemljevidu jih vklopite pod »Sloji«. Vklopljenih je lahko več slojev hkrati, sloji, katerih obdobje ustreza izbranim letom, pa so označeni. Vklopimo kataster in poglejmo Bitnje od blizu.",
        en: "On the map you switch them on under Layers. Several layers can be on at once, and layers whose period suits the chosen years are marked. Let's switch on the cadastre and zoom in on Bitnje.",
      },
      run: async (d) => {
        await findOnMap(d, "Srednje Bitnje");
        await openLayers(d);
        await d.highlight(layerPick(d, d.t(BITNJE)), 4);
        await d.wait(1200);
        await d.click(layerPick(d, d.t(BITNJE)).locator("input").first());
        await d.highlight(null);
        await d.skippable(() => d.wait(3000));
        await closeLayers(d);
        await zoom(d, 2);
        await d.wait(2500);
      },
    },
    {
      say: {
        sl: "Prosojnost je namenjena slikovnim kartam, kot je kataster, ki osnovni zemljevid v celoti prekrijejo. Z drsnikom pod slojem jo nastavite tako, da pod staro karto vidite današnji zemljevid.",
        en: "Opacity is meant for image maps, such as the cadastre, that cover the base map entirely. Set it with the slider under the layer so today's map shows through the old one.",
      },
      run: async (d) => {
        await openLayers(d);
        const slider = d.page.locator("input.map-overlay-opacity").first();
        await d.highlight(slider, 4);
        await d.point(slider);
        await setRange(slider, 0.35);
        await d.wait(2000);
        await setRange(slider, 0.85);
        await d.wait(1500);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Vzporedni pogled", en: "Side by side" },
      say: {
        sl: "Prikažimo spet dogodke vseh let. »Vzporedni pogled« razdeli zemljevid na dve polovici. Levo je današnji zemljevid, desno kataster iz leta 1826. Ko približate ali premaknete eno polovico, ji druga sledi, zato na ravni hiš vidite, katere so v vasi stale že takrat.",
        en: "Let's show the events of every year again. Side by side splits the map into two halves. On the left is today's map, on the right the cadastre of 1826. When you zoom or move one half, the other follows, so at the level of houses you see which of them stood in the village already then.",
      },
      run: async (d) => {
        await closePanel(d);
        // Every year again: the burials in the cemetery are recent ones.
        await d.click(yearTo(d));
        await d.page.keyboard.press("ControlOrMeta+a");
        await d.page.keyboard.type("2025", { delay: 90 });
        await d.page.keyboard.press("Enter");
        await d.wait(800);
        await openLayers(d);
        // The cadastre fully opaque here: beside today's map, the old one alone.
        const opacity = d.page.locator("input.map-overlay-opacity").first();
        await d.point(opacity);
        await setRange(opacity, 1);
        await d.wait(600);
        const split = d.page.locator("label.map-split-toggle").first();
        await d.highlight(split, 4);
        await d.wait(1000);
        await d.click(split.locator("input"));
        await d.highlight(null);
        await closeLayers(d);
        await d.skippable(() => d.wait(3000));
        await d.overlay("hideCursor");
        await d.snapshot();
        await zoom(d, 2);
        await d.skippable(() => d.wait(2500));
        await pan(d, -60, 280);
        await d.skippable(() => d.wait(2000));
        await d.wait(2500);
      },
    },
    {
      callout: { sl: "Izvoz", en: "Export" },
      say: {
        sl: "Pod »Izvoz« pogled shranite kot sliko PNG, z navedbo virov kart. V vzporednem pogledu izvozite obe polovici skupaj ali vsako posebej.",
        en: "Under Export you save the view as a PNG image, with the maps' credits. Side by side, you export both halves together or each on its own.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".tree-export-btn").first());
        await d.wait(1200);
        await d.highlight(d.page.locator(".export-menu-popover").first(), 4);
        await d.wait(1500);
        await d.click(d.page.locator(".export-menu-item", { hasText: d.t({ sl: "vzporedni pogled", en: "side by side" }) }).first());
        await d.highlight(null);
        await d.wait(1500);
      },
    },
    {
      callout: { sl: "Sloji GURS", en: "GURS layers" },
      say: {
        sl: "Sloji GURS so vektorski izrisi, ki se narišejo čez osnovni zemljevid ali čez zgodovinsko karto: meje katastrskih občin, današnje parcele in hišne številke. Da bodo lepo vidni, preklopimo na enostaven osnovni zemljevid in kataster izklopimo.",
        en: "The GURS layers are vector drawings laid over the base map or over a historical map: cadastral municipality borders, today's parcels and house numbers. To see them clearly, we switch to the plain base map and turn the cadastre off.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".nav-btn.icon-only:not(.undo-btn):not(.charts-open-btn):not(.shortcuts-btn)").nth(2));
        await d.click(modal(d).locator("button", { hasText: d.t({ sl: "Zemljevid", en: "Map" }) }).first());
        await d.scrollTo(baseRow(d));
        await d.highlight(baseRow(d), 4);
        await pickBase(d, { sl: "Enostaven", en: "Plain" });
        await d.highlight(null);
        await d.click(modal(d).locator(".modal-close"));
        await modal(d).waitFor({ state: "detached" });
        await closePanel(d);
        await openLayers(d);
        await d.click(d.page.locator("label.map-split-toggle input").first());
        await d.wait(600);
        await d.click(layerPick(d, d.t(BITNJE)).locator("input").first());
        await d.wait(800);
        for (const layer of GURS_LAYERS) {
          const pick = layerPick(d, d.t(layer));
          await d.highlight(pick, 4);
          await d.click(pick.locator("input").first());
          await d.wait(700);
        }
        await d.highlight(null);
        await closeLayers(d);
        // From the houses out to the cadastral municipalities: parcels and
        // house numbers first, then the borders they sit in.
        await zoom(d, -4);
        await d.skippable(() => d.wait(1500));
        await d.wait(1200);
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
