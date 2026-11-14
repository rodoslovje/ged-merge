/**
 * Video 12 (SCENARIJI.md, "Fotografije"): photos on people — browser support
 * first (the guide's table), then a media folder sorted into subfolders, a
 * portrait, a group photo on which each person is marked, and the photos on
 * the charts.
 *
 * Data: `rodbina-renko.ged` (the anonymised excerpt of the author's tree, as in
 * episodes 9 and 11) and photos from the author's own media folder, which is
 * not in this repository: `~/Work/rod/renko-ged/media`, or `VIDEO_MEDIA_DIR`.
 * Only the files in MEDIA_FILES are copied into the browser's private file
 * system (OPFS), as a folder named »media« with its subfolders, and the
 * directory picker is stubbed to hand that folder over — a headless browser
 * cannot show the native picker.
 *
 * People: Franc Renko (1901–1964), the author's grandfather, on his portrait;
 * the wedding photo of his son Edvard and Cvetka Renko with their witnesses,
 * Edvard's brother Jože Renko (1938–1975) and Cvetka's brother Peter Jekovec
 * (1935–2023). Edvard and Cvetka are living — the author's parents, shown with
 * their permission. The marked regions are the ones the author's own file
 * records for that photo.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import { seriesSettingsWithMaps } from "../lib/series.ts";
import type { Scenario } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "rodbina-renko.ged");
const MEDIA_DIR = process.env.VIDEO_MEDIA_DIR ?? path.join(os.homedir(), "Work", "rod", "renko-ged", "media");

const PORTRAIT = "portraits/Renko-Franc-1901.jpg";
const WEDDING = "weddings/Renko-Edvard+Jekovec-Cvetka-1962.jpg";
/** The folder the video connects: deceased people only, plus the author's parents (with permission). */
const MEDIA_FILES = [
  PORTRAIT,
  "portraits/Renko-Franc-1901-2.jpg",
  "portraits/Starasinic-Neza-1906.jpg",
  "portraits/Rakar-Alojzija-1903.jpg",
  "portraits/Rakar-Antonija-1908.jpg",
  "portraits/Jekovec-Peter-1935.jpg",
  "family/Rakar-Tonka-Palcic-Toni.jpg",
  "family/Jekovec-Pavle+Cvetka+Peter.jpg",
  WEDDING,
];

/** Regions on the wedding photo (natural pixels), from the author's file. */
const CROP = {
  edvard: { left: 1811, top: 1256, width: 738, height: 943 },
  cvetka: { left: 1064, top: 1461, width: 789, height: 957 },
  joze: { left: 597, top: 572, width: 697, height: 994 },
  peter: { left: 1816, top: 6, width: 660, height: 888 },
};
type Crop = (typeof CROP)[keyof typeof CROP];

/**
 * Copy the media files into the page's private file system and make the
 * directory picker return that folder. The app then works with a real
 * directory handle, exactly as after a pick in Chrome.
 */
async function prepareFolder(d: Director): Promise<void> {
  const files = MEDIA_FILES.map((rel) => ({ rel, b64: readFileSync(path.join(MEDIA_DIR, rel)).toString("base64") }));
  await d.page.evaluate(async (list) => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry("media", { recursive: true });
    } catch { /* first run */ }
    const media = await root.getDirectoryHandle("media", { create: true });
    for (const { rel, b64 } of list) {
      const segs = rel.split("/");
      let dir = media;
      for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create: true });
      const fh = await dir.getFileHandle(segs[segs.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      await w.close();
    }
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => media;
  }, files);
}

const card = (d: Director, name: string) => d.page.locator(".person-card").filter({ hasText: name }).filter({ visible: true }).first();
const addMediaChip = (d: Director) =>
  d.page.locator(".edit-name-chip-add").filter({ hasText: d.lang === "sl" ? "Dodaj medij" : /Add media/i }).filter({ visible: true }).first();
const picker = (d: Director) => d.page.locator(".add-media-dialog");
const cell = (d: Director, file: string) => picker(d).locator(`.add-media-cell[title^="${file}"]`).first();
const thumb = (d: Director) => d.page.locator(".edit-person .person-media-btn").filter({ visible: true });
const viewerImage = (d: Director) => d.page.locator(".person-media-overlay .person-media-full").first();

/** Open the Add-media picker and wait until it has read the folder. */
async function openPicker(d: Director): Promise<void> {
  const chip = addMediaChip(d);
  if (await chip.count()) await d.click(chip);
  else await d.click(d.page.locator(".edit-person .person-media-add").first());
  await picker(d).locator(".add-media-cell").first().waitFor();
  await d.wait(500);
}

async function pick(d: Director, file: string): Promise<void> {
  await d.scrollTo(cell(d, file));
  await d.click(cell(d, file));
  await d.wait(500);
  await d.click(picker(d).locator(".add-media-footer button").last());
  await picker(d).waitFor({ state: "detached" });
  await d.wait(600);
}

/** Open the person's last photo in the viewer — unless adding it already did. */
async function openLast(d: Director): Promise<void> {
  if (!(await d.page.locator(".person-media-overlay").count())) await d.click(thumb(d).last());
  await viewerImage(d).waitFor();
  await d.wait(700);
}

async function setTitle(d: Director, title: string): Promise<void> {
  const input = d.page.locator(".media-lightbox-edit .media-edit-field input").first();
  await d.click(input);
  await input.fill("");
  await d.page.keyboard.type(title, { delay: 70 });
  await d.page.keyboard.press("Enter");
  await d.wait(500);
}

/** »Označi območje osebe«, drag the region with the visible pointer, »Shrani območje«. */
async function markRegion(d: Director, crop: Crop): Promise<void> {
  await d.click(d.page.locator(".media-crop-controls button").first());
  await d.wait(600);
  const img = viewerImage(d);
  const box = (await img.boundingBox())!;
  const nat = await img.evaluate((e: HTMLImageElement) => ({ w: e.naturalWidth, h: e.naturalHeight }));
  const sx = box.width / nat.w;
  const sy = box.height / nat.h;
  const x1 = box.x + crop.left * sx;
  const y1 = box.y + crop.top * sy;
  const x2 = x1 + crop.width * sx;
  const y2 = y1 + crop.height * sy;
  await d.overlay("cursor", x1, y1, 700);
  await d.wait(800);
  await d.page.mouse.move(x1, y1);
  await d.page.mouse.down();
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    const x = x1 + ((x2 - x1) * i) / steps;
    const y = y1 + ((y2 - y1) * i) / steps;
    await d.overlay("cursor", x, y, 40);
    await d.page.mouse.move(x, y);
    await d.wait(45);
  }
  await d.page.mouse.up();
  await d.wait(700);
  await d.click(d.page.locator(".media-crop-buttons button").first());
  await d.wait(800);
}

async function closeViewer(d: Director): Promise<void> {
  await d.click(d.page.locator(".person-media-close").first());
  await d.page.locator(".person-media-overlay").waitFor({ state: "detached" });
  await d.wait(500);
}

/** Find a person with the header search: type, then pick the row that shows `year`. */
async function find(d: Director, query: string, year: string): Promise<void> {
  await d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await d.page.keyboard.press("/");
  await d.wait(500);
  await d.page.keyboard.type(query, { delay: 120 });
  await d.wait(900);
  await d.click(d.page.locator(".global-search-row").filter({ hasText: year }).first().locator(".global-search-open"));
  await d.page.locator(".global-search-modal").waitFor({ state: "detached" });
  await d.wait(900);
}

/** Move the mouse onto the photo, below the faces, so the viewer reveals the marks. */
async function hoverPhoto(d: Director): Promise<void> {
  const box = (await viewerImage(d).boundingBox())!;
  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.85;
  await d.overlay("cursor", x, y, 800);
  await d.wait(900);
  await d.page.mouse.move(x, y, { steps: 5 });
  await d.wait(600);
}

/** The found face whose centre lies in `crop` (the region the author's file gives that person). */
async function faceIn(d: Director, crop: Crop) {
  const img = viewerImage(d);
  const box = (await img.boundingBox())!;
  const nat = await img.evaluate((e: HTMLImageElement) => ({ w: e.naturalWidth, h: e.naturalHeight }));
  const area = {
    x1: box.x + (crop.left / nat.w) * box.width,
    y1: box.y + (crop.top / nat.h) * box.height,
    x2: box.x + ((crop.left + crop.width) / nat.w) * box.width,
    y2: box.y + ((crop.top + crop.height) / nat.h) * box.height,
  };
  const faces = d.page.locator(".photo-face-box");
  await faces.first().waitFor({ timeout: 30_000 });
  const rects = await faces.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })));
  const i = rects.findIndex((c) => c.x > area.x1 && c.x < area.x2 && c.y > area.y1 && c.y < area.y2);
  if (i < 0) throw new Error(`No face found in ${JSON.stringify(crop)}`);
  return faces.nth(i);
}

/** Click the face in `crop` and pick `who` in the name panel, typing `query` first if given. */
async function nameFace(d: Director, crop: Crop, who: string, query?: string): Promise<void> {
  await hoverPhoto(d);
  await d.click(await faceIn(d, crop));
  const namer = d.page.locator(".photo-face-namer");
  await namer.waitFor();
  await d.wait(900);
  if (query) {
    await d.page.keyboard.type(query, { delay: 140 });
    await d.wait(900);
  }
  await d.click(namer.locator(".photo-face-list button").filter({ hasText: who }).first());
  await namer.waitFor({ state: "detached" });
  await d.wait(700);
}

const scenario: Scenario = {
  id: "photos",
  episode: 12,
  settings: seriesSettingsWithMaps,
  title: {
    sl: "GED Merge: fotografije — portreti, skupinske fotografije in označevanje oseb",
    en: "GED Merge: photos — portraits, group photos and marking who is who",
  },
  description: {
    sl: "Kako v GED Merge osebam dodate fotografije: mapa z mediji in podpora brskalnikov, podmape za portrete in družinske fotografije, pregledovalnik z opisom fotografije, označevanje oseb na skupinski fotografiji in fotografije na diagramih. Podatki: izsek iz avtorjevega rodovnika in njegove družinske fotografije.",
    en: "How to add photos to people in GED Merge: the media folder and browser support, subfolders for portraits and family photos, the viewer with the photo's details, marking people on a group photo, and photos on the charts. Data: an excerpt of the author's family tree and his family photos.",
  },
  thumbnail: {
    tag: { sl: "Fotografije", en: "Photos" },
    title: { sl: "Kdo je *kdo* na fotografiji", en: "Who is *who* in the photo" },
  },
  steps: [
    {
      say: {
        sl: "Fotografije prednikov oživijo drevo. Pokažimo, kako jih v GED Merge dodate osebam: portret in skupinsko fotografijo, na kateri označite, kdo je kdo.",
        en: "Photos bring your ancestors to life. Let's see how GED Merge adds them to people: a portrait, and a group photo on which you mark who is who.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Fotografije", en: "Photos" },
          { sl: "Portreti in skupinske fotografije", en: "Portraits and group photos" },
        );
      },
    },
    {
      callout: { sl: "Podpora brskalnikov", en: "Browser support" },
      say: {
        sl: "Datoteka GEDCOM fotografij ne vsebuje, ampak se nanje le sklicuje. Zato GED Merge potrebuje dostop do mape, v kateri so fotografije shranjene. Koliko pri tem zmore, je odvisno od brskalnika. Najboljšo podporo imata Chrome in Edge: mapo si zapomnita, nove fotografije pa program vanjo tudi kopira. Podrobnosti so v navodilih, v poglavju o fotografijah in medijih.",
        en: "A GEDCOM file does not contain photos; it only refers to them. So GED Merge needs access to the folder where the photos are kept. How much it can do there depends on the browser. Chrome and Edge have the best support: they remember the folder, and the program can copy new photos into it. The details are in the User's Guide, in the chapter on photos and media.",
      },
      run: async (d) => {
        await d.card(null, null);
        const home = d.page.url();
        await d.page.goto(new URL(d.lang === "sl" ? "navodila/#photos" : "guide/#photos", home).href);
        await d.page.evaluate(() => document.fonts.ready);
        await d.wait(1500);
        const table = d.page.locator("#photos table.gm-table").first();
        await d.scrollTo(table);
        await d.wait(600);
        await d.highlight(table, 8);
        await d.wait(2500);
        await d.point(table.locator("tbody tr").nth(2));
        await d.wait(2000);
        await d.point(table.locator("tbody tr").nth(4));
        await d.untilSaid();
        await d.highlight(null);
        await d.page.goto(home);
        await d.page.locator("input.file-input").first().waitFor({ state: "attached" });
        await d.page.evaluate(() => document.fonts.ready);
      },
    },
    {
      callout: { sl: "Mapa z mediji", en: "The media folder" },
      say: {
        sl: "Odprimo izsek iz avtorjevega rodovnika in pojdimo k avtorjevemu dedu, Francu Renku.",
        en: "Let's open the excerpt of the author's tree and go to his grandfather, Franc Renko.",
      },
      run: async (d) => {
        await prepareFolder(d);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(1200);
        await d.click(card(d, "Edvard"));
        await d.wait(1000);
        await d.click(card(d, "Franc"));
        await d.wait(800);
      },
    },
    {
      say: {
        sl: "Pri osebi kliknite »Dodaj medij«. Ob prvem dodajanju program vpraša za mapo z mediji. Izberete jo samo enkrat, Chrome pa si jo zapomni za naslednjič. Mapa se bere samo na vašem računalniku.",
        en: "On the person, click Add media. The first time, the program asks for your media folder. You choose it only once, and Chrome remembers it for next time. The folder is read only on your computer.",
      },
      run: async (d) => {
        await d.click(addMediaChip(d));
        const dialog = d.page.locator(".confirm-dialog");
        await dialog.waitFor();
        await d.highlight(dialog, 6);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(dialog.locator(".confirm-dialog-confirm"));
        await dialog.waitFor({ state: "detached" });
        await d.wait(1200);
      },
    },
    {
      callout: { sl: "Podmape", en: "Subfolders" },
      say: {
        sl: "Izbirnik pokaže vse fotografije v mapi. Razvrstite jih lahko v podmape, na primer portrete v »portraits«, družinske fotografije v »family« in poročne v »weddings«. Vsaka podmapa ima v izbirniku svoj razdelek.",
        en: "The picker shows every photo in the folder. You can sort them into subfolders, for example portraits in »portraits«, family photos in »family« and weddings in »weddings«. Each subfolder gets its own section in the picker.",
      },
      run: async (d) => {
        await openPicker(d);
        const heads = picker(d).locator(".add-media-subfolder");
        for (let i = 0; i < 3; i++) {
          await d.scrollTo(heads.nth(i));
          await d.highlight(heads.nth(i), 6);
          await d.wait(1600);
        }
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Iskalno polje poišče fotografijo po imenu datoteke. Izberimo Frančev portret in kliknimo gumb »Dodaj«.",
        en: "The search box finds a photo by its file name. Let's choose Franc's portrait and click Add.",
      },
      run: async (d) => {
        await d.click(picker(d).locator(".add-media-search input").first());
        await d.page.keyboard.type("franc", { delay: 150 });
        await d.wait(1200);
        await pick(d, PORTRAIT);
      },
    },
    {
      callout: { sl: "Pregledovalnik", en: "The viewer" },
      say: {
        sl: "Dodana fotografija se odpre v pregledovalniku, kjer ji takoj dodate naslov, datum, kraj in opis. Ko pregledovalnik zaprete, je fotografija ob osebi. S klikom nanjo jo znova povečate.",
        en: "The new photo opens in the viewer, where you give it a title, date, place and description right away. Close the viewer and the photo sits by the person; click it to enlarge it again.",
      },
      run: async (d) => {
        // Adding has already opened the photo in the viewer: describe it there.
        await openLast(d);
        await setTitle(d, d.t({ sl: "Franc Renko, r. 1901", en: "Franc Renko, b. 1901" }));
        await d.highlight(d.page.locator(".media-lightbox-edit").first(), 6);
        await d.wait(2000);
        await d.highlight(null);
        await closeViewer(d);
        await d.highlight(thumb(d).first(), 6);
        await d.wait(2000);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Skupinska fotografija", en: "A group photo" },
      say: {
        sl: "Zdaj pa skupinska fotografija: poroka Frančevega sina Edvarda s Cvetko, skupaj s pričama. Dodamo jo Edvardu.",
        en: "Now a group photo: the wedding of Franc's son Edvard and Cvetka, with their two witnesses. We add it to Edvard.",
      },
      run: async (d) => {
        await d.click(card(d, "Edvard"));
        await d.wait(900);
        await openPicker(d);
        await pick(d, WEDDING);
        await openLast(d);
        await setTitle(d, d.t({ sl: "Poroka Edvarda in Cvetke", en: "Wedding of Edvard and Cvetka" }));
      },
    },
    {
      callout: { sl: "Obrazi na fotografiji", en: "Faces in the photo" },
      say: {
        sl: "Na skupinski fotografiji GED Merge sam najde obraze, kar na vašem računalniku. Ko z miško zapeljete nad fotografijo, je vsak obraz, ki še ni označen, prikazan z vprašajem.",
        en: "On a group photo, GED Merge finds the faces itself, right on your computer. Move the mouse over the photo, and every face nobody is marked on yet shows a question mark.",
      },
      run: async (d) => {
        await hoverPhoto(d);
        await d.page.locator(".photo-face-box").first().waitFor({ timeout: 30_000 });
        await d.wait(2500);
      },
    },
    {
      callout: { sl: "Poimenujte obraz", en: "Name a face" },
      say: {
        sl: "Kliknite obraz in izberite, kdo je to. Najprej so ponujeni oseba, katere fotografija je, in njeni bližnji sorodniki. Ta obraz je Edvard.",
        en: "Click a face and choose who it is. The person whose photo it is and their close family are offered first. This face is Edvard.",
      },
      run: async (d) => {
        await nameFace(d, CROP.edvard, "Edvard Renko");
      },
    },
    {
      say: {
        sl: "Zraven njega sedi Cvetka.",
        en: "Next to him sits Cvetka.",
      },
      run: async (d) => {
        await nameFace(d, CROP.cvetka, "Cvetka");
      },
    },
    {
      say: {
        sl: "Priča na levi je Edvardov brat Jože Renko. Osebo, ki je ni med predlogi, poiščete z vpisom imena.",
        en: "The witness on the left is Edvard's brother, Jože Renko. Anyone not among the suggestions is found by typing their name.",
      },
      run: async (d) => {
        await nameFace(d, CROP.joze, "Jože Renko", "joze");
      },
    },
    {
      say: {
        sl: "Zadaj stoji Cvetkin brat Peter Jekovec.",
        en: "Standing at the back is Cvetka's brother, Peter Jekovec.",
      },
      run: async (d) => {
        await nameFace(d, CROP.peter, "1935", "peter");
      },
    },
    {
      callout: { sl: "Kdo je kdo", en: "Who is who" },
      say: {
        sl: "Poimenovani so vsi štirje. Vsak od njih je dobil to fotografijo in vsak, ki bo drevo gledal za vami, bo vedel, kdo je kdo.",
        en: "All four are named. Each of them now has this photo, and anyone who looks at the tree after you will know who is who.",
      },
      run: async (d) => {
        await hoverPhoto(d);
        await d.wait(800);
        await d.snapshot();
        await d.wait(2500);
      },
    },
    {
      callout: { sl: "Prilagodite območje", en: "Adjust a region" },
      say: {
        sl: "Najdeno območje lahko tudi prilagodite. Kliknite »Spremeni območje osebe«, povlecite nov pravokotnik in kliknite »Shrani območje«. Obraz, ki ga program ne najde, označite enako.",
        en: "You can adjust a region that was found. Click Change person's region, drag a new rectangle and click Save region. A face the program misses is marked the same way.",
      },
      run: async (d) => {
        await markRegion(d, CROP.edvard);
        await closeViewer(d);
      },
    },
    {
      say: {
        sl: "Sličica osebe zdaj pokaže samo njen obraz. Enako velja za Cvetko in obe priči.",
        en: "The person's thumbnail now shows just their face. The same goes for Cvetka and both witnesses.",
      },
      run: async (d) => {
        await d.highlight(thumb(d).last(), 8);
        await d.wait(2200);
        await d.highlight(null);
        await d.click(card(d, "Cvetka"));
        await d.wait(900);
        await d.highlight(thumb(d).last(), 8);
        await d.wait(2200);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Fotografije na diagramih", en: "Photos on the charts" },
      say: {
        sl: "Fotografije se pokažejo tudi na diagramih. Pri vsaki osebi je njen portret ali obraz, označen na skupinski fotografiji.",
        en: "Photos show on the charts too. Each person carries their portrait, or the face marked on a group photo.",
      },
      run: async (d) => {
        await find(d, "luka renko", "1971");
        await d.click(d.page.locator(".charts-open-btn"));
        await d.page.locator(".charts-kind").waitFor();
        await d.click(d.page.locator(".charts-kind button").nth(0));
        await d.click(d.page.locator("button").filter({ hasText: /^(Predniki|Ancestors)\d/ }).filter({ visible: true }).first());
        // Three generations: the author, his parents and grandparents — large enough to see the faces.
        await d.page.locator(".chart-settings-btn").filter({ visible: true }).first().click();
        const rows = d.page
          .locator(".chart-settings-group")
          .filter({ has: d.page.locator(".chart-settings-heading", { hasText: d.t({ sl: "Rodovi", en: "Generations" }) }) })
          .first();
        for (let i = 0; i < 15 && !/^3\D/.test(await rows.locator(".chart-settings-value").innerText()); i++) {
          await rows.locator("button").first().click();
          await d.wait(150);
        }
        await d.page.keyboard.press("Escape");
        await d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await d.page.keyboard.press("f");
        await d.wait(1500);
      },
    },
    {
      say: {
        sl: "Prikaz fotografij vklopite ali izklopite z gumbom »Diagram«, pri izbiri »Fotografija«.",
        en: "Switch the photos on or off with the Chart button, under Photo.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".chart-settings-btn").filter({ visible: true }).first());
        await d.wait(700);
        const photo = d.page
          .locator(".chart-settings-popover button")
          .filter({ hasText: new RegExp(`^${d.t({ sl: "Fotografija", en: "Photo" })}$`) })
          .first();
        await d.highlight(photo, 4);
        await d.click(photo);
        await d.wait(1800);
        await d.click(photo);
        await d.wait(1200);
        await d.highlight(null);
        await d.page.keyboard.press("Escape");
        await d.wait(800);
      },
    },
    {
      callout: null,
      say: {
        sl: "GED Merge je vaš rodoslovni program v brskalniku. V njem urejate drevo, ga dopolnjujete iz drugih datotek ter rišete diagrame in zemljevide. Je brezplačen, ne potrebuje računa, najdete pa ga na naslovu gedmerge.com.",
        en: "GED Merge is your genealogy program in the browser. You edit your tree, complete it from other files, and draw charts and maps. It is free, needs no account, and you will find it at gedmerge.com.",
      },
      run: async (d) => {
        await d.highlight(null);
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
