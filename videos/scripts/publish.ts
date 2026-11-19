/**
 * Video 17 (SCENARIJI.md, "Spletna stran"): the tree as a website for
 * relatives — Tools → Family website: title and words for relatives, the
 * site's own start person, whom to publish, living and recently deceased
 * people, sources and notes, photos by folder with a cover, then the download
 * and the site itself as relatives see it.
 *
 * Data: `rodbina-renko-foto.ged` — `rodbina-renko.ged` (the anonymised excerpt
 * of the author's tree, episodes 9, 11, 12 and 16) with the photos episode 12
 * adds on camera already linked, each to the people the author's own file
 * links it to, with the same face regions. The photos come from the author's
 * media folder, which is not in this repository (`~/Work/rod/renko-ged/media`,
 * or `VIDEO_MEDIA_DIR`), copied into the browser's private file system as in
 * episode 12, and only the episode-12 files: deceased people and the author's
 * parents, who allowed it. Living people are left out of the site, so the
 * wedding photo of the author's parents and every other photo with a living
 * or recently deceased person on it is withheld — the step that says so.
 *
 * The downloaded ZIP is unpacked into videos/.cache/site and served on a
 * local port, and the recording goes on in the same tab, on the site.
 */
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import { seriesSettingsWithMaps } from "../lib/series.ts";
import type { Scenario, Text } from "../lib/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, "..", "demo", "rodbina-renko-foto.ged");
const MEDIA_DIR = process.env.VIDEO_MEDIA_DIR ?? path.join(os.homedir(), "Work", "rod", "renko-ged", "media");
const SITE_DIR = path.join(HERE, "..", ".cache", "site");
const SITE_PORT = 5299;

const COVER = "portraits/Renko-Franc-1901.jpg";
/** The episode-12 folder: deceased people only, plus the author's parents (with permission). */
const MEDIA_FILES = [
  COVER,
  "portraits/Renko-Franc-1901-2.jpg",
  "portraits/Starasinic-Neza-1906.jpg",
  "portraits/Rakar-Alojzija-1903.jpg",
  "portraits/Rakar-Antonija-1908.jpg",
  "portraits/Jekovec-Peter-1935.jpg",
  "family/Rakar-Tonka-Palcic-Toni.jpg",
  "family/Jekovec-Pavle+Cvetka+Peter.jpg",
  "weddings/Renko-Edvard+Jekovec-Cvetka-1962.jpg",
];
/** The Tools tab of Family website (ToolsView's TOOLS order). */
const PUBLISH_TAB = 7;

/** Copy the media files into the page's private file system and stub the folder picker (as episode 12). */
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

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

let server: Server | undefined;

/** Serve the unpacked site, as a web server would after an upload. */
function serveSite(): Promise<string> {
  server?.close();
  server = createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.join(SITE_DIR, rel);
    if (!file.startsWith(SITE_DIR) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  // Not kept alive past the recording: make.ts exits once the video is assembled.
  server.unref();
  return new Promise((resolve) => server!.listen(SITE_PORT, "127.0.0.1", () => resolve(`http://127.0.0.1:${SITE_PORT}/`)));
}

const panel = (d: Director) => d.page.locator(".tools-publish");
/** A group of the panel by its legend. */
const group = (d: Director, legend: Text) =>
  panel(d).locator(".tools-privacy-group").filter({ has: d.page.locator(".tools-privacy-legend", { hasText: d.t(legend) }) }).first();
/** A radio or checkbox of the panel by its label. */
const choice = (d: Director, label: Text) =>
  panel(d).locator(".tools-norm-check").filter({ hasText: new RegExp(`^${d.t(label)}$`) }).first();
const summary = (d: Director) => panel(d).locator(".tools-privacy-group").filter({ has: d.page.locator(".tools-summary") }).last();

const LIVING: Text = { sl: "Žive osebe", en: "Living people" };
const INCLUDE: Text = { sl: "Objavi tudi", en: "Also publish" };

async function type(d: Director, field: ReturnType<Director["page"]["locator"]>, text: string, delay = 45): Promise<void> {
  await d.click(field);
  await field.fill("");
  await d.page.keyboard.type(text, { delay });
  await d.wait(400);
}

const scenario: Scenario = {
  id: "publish",
  episode: 17,
  settings: seriesSettingsWithMaps,
  title: {
    sl: "GED Merge: spletna stran — drevo za vse sorodnike",
    en: "GED Merge: family website — your tree for every relative",
  },
  description: {
    sl: "Kako v GED Merge iz drevesa pripravite spletno stran za sorodnike: naslov in nekaj besed zanje, izhodiščna oseba, koga objavite, žive in nedavno umrle osebe, viri in opombe, fotografije po mapah z naslovno fotografijo, prenos ZIP in stran, kot jo vidijo sorodniki. Podatki: izsek iz avtorjevega rodovnika in njegove družinske fotografije.",
    en: "How GED Merge turns your tree into a website for relatives: a title and a few words for them, the start person, whom to publish, living and recently deceased people, sources and notes, photos by folder with a cover photo, the ZIP download, and the site as relatives see it. Data: an excerpt of the author's family tree and his family photos.",
  },
  thumbnail: {
    tag: { sl: "Spletna stran", en: "Family website" },
    title: { sl: "Drevo za *vse* sorodnike", en: "Your tree for *every* relative" },
  },
  steps: [
    {
      say: {
        sl: "Drevo lahko pokažete tudi sorodnikom, ki programa nimajo: kot spletno stran, ki jo odprejo v brskalniku. Pokažimo, kako jo pripravite.",
        en: "You can show your tree to relatives who don't have the program, too: as a website they open in their browser. Let's see how to make one.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Spletna stran", en: "Family website" },
          { sl: "Drevo za vse sorodnike", en: "Your tree for every relative" },
        );
      },
    },
    {
      callout: { sl: "Orodje Spletna stran", en: "The Family website tool" },
      say: {
        sl: "Odprimo izsek iz avtorjevega rodovnika. Datoteka se sklicuje na fotografije, zato program vpraša za mapo z mediji, in izberemo jo. Nato v Orodjih izberemo »Spletna stran«.",
        en: "Let's open the excerpt of the author's tree. The file refers to photos, so the program asks for the media folder, and we choose it. Then, in Tools, we choose Family website.",
      },
      run: async (d) => {
        await prepareFolder(d);
        await d.card(null, null);
        await d.wait(700);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(800);
        // The strip that offers the media folder, as soon as a file with photos opens.
        const notice = d.page.locator(".media-notice");
        await notice.waitFor();
        await d.highlight(notice, 4);
        await d.wait(1800);
        await d.highlight(null);
        await d.click(notice.locator("button").first());
        await notice.waitFor({ state: "detached" });
        await d.wait(600);
        await d.click(d.page.locator(".seg-btn").nth(2));
        await d.wait(600);
        await d.click(d.page.locator(".tools-tab").nth(PUBLISH_TAB));
        await panel(d).waitFor();
        await d.wait(600);
      },
    },
    {
      say: {
        sl: "Orodje pripravi stran z diagrami, zemljevidom, statistiko in stranjo vsake osebe. Datoteke GEDCOM s strani ni mogoče prenesti, zato si sorodniki drevo lahko ogledajo, ne morejo pa ga odnesti. Vaša delovna datoteka ostane nedotaknjena.",
        en: "The tool makes a site with charts, a map, statistics and a page for every person. The GEDCOM file cannot be downloaded from it, so relatives can browse the tree but not take it away. Your working file stays untouched.",
      },
      run: async (d) => {
        const toggle = panel(d).locator(".tools-intro-toggle").first();
        await d.click(toggle);
        await d.highlight(panel(d).locator(".tools-intro").first(), 6);
        await d.untilSaid(0.8);
        await d.highlight(null);
        await d.click(toggle);
      },
    },
    {
      callout: { sl: "Naslov in besede za sorodnike", en: "Title and a few words" },
      say: {
        sl: "Najprej vpišemo naslov strani in nekaj besed, ki jih sorodniki preberejo na začetni strani. Besedilo lahko napišete v vsakem jeziku posebej.",
        en: "First the site's title, and a few words relatives read on the front page. You can write them in each language separately.",
      },
      run: async (d) => {
        await type(d, panel(d).locator(".tools-publish-field input.tools-publish-input").first(), d.t({ sl: "Rodbina Renko", en: "The Renko family" }), 70);
        const intro = panel(d).locator(`.tools-publish-intro textarea[lang="${d.lang}"]`).first();
        await type(
          d,
          intro,
          d.t({
            sl: "Rodovnik naših družin Renko, Rakar in Jekovec. Popravki in dopolnitve so dobrodošli.",
            en: "The family tree of the Renko, Rakar and Jekovec families. Corrections and additions are welcome.",
          }),
          30,
        );
      },
    },
    {
      say: {
        sl: "V polje »Naslov te strani« vpišete, kam boste stran naložili. Iskalnike stran prosi, naj je ne vključijo, razen če jim indeksiranje dovolite.",
        en: "In the field This site's address, you enter where you will upload the site. The site asks search engines to leave it out, unless you allow them to index it.",
      },
      run: async (d) => {
        await d.highlight(panel(d).locator(".tools-publish-field").filter({ has: d.page.locator('input[type="url"]') }).first(), 6);
        await d.wait(3500);
        await d.highlight(panel(d).locator(".tools-publish-check-row").first(), 6);
        await d.untilSaid(0.3);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Izhodiščna oseba", en: "The start person" },
      say: {
        sl: "Izhodiščna oseba strani je lahko druga kot v programu. Avtor je živ in ga na strani ne bo, zato izberemo njegovega deda, Franca Renka. Pri njem se odprejo diagrami, od njega pa se računajo oznake sorodstva.",
        en: "The site's start person can differ from the program's. The author is living and will not be on the site, so we choose his grandfather, Franc Renko. The charts open on him, and kinship labels are counted from him.",
      },
      run: async (d) => {
        const input = group(d, { sl: "Izhodiščna oseba", en: "Start person" }).locator(".start-control input");
        await d.scrollTo(input);
        await d.click(input);
        await d.page.keyboard.type("franc renko", { delay: 110 });
        await d.wait(900);
        await d.click(d.page.locator(".start-options .start-option").filter({ hasText: "1901" }).first());
        await d.wait(900);
      },
    },
    {
      callout: { sl: "Koga objavim", en: "Whom to publish" },
      say: {
        sl: "Nato izberete, koga objavite: vse osebe v datoteki, samo krvne sorodnike ali le prednike in potomce. Izberimo krvne sorodnike, skupaj z zakonci in partnerji. Povzetek na dnu sproti pove, koliko oseb in družin bo na strani.",
        en: "Next you choose whom to publish: everyone in the file, blood relatives only, or just ancestors and descendants. Let's take blood relatives, with their spouses and partners. The summary at the bottom tells you, as you go, how many people and families the site will show.",
      },
      run: async (d) => {
        const scope = group(d, { sl: "Koga objavim", en: "Who to publish" });
        await d.scrollTo(scope);
        await d.highlight(scope, 6);
        await d.wait(2500);
        await d.click(choice(d, { sl: "Krvne sorodnike", en: "Blood relatives" }));
        await d.wait(800);
        const partners = choice(d, { sl: "Skupaj z zakonci in partnerji", en: "With their spouses and partners" });
        if (!(await partners.locator("input").isChecked())) await d.click(partners);
        await d.highlight(null);
        await d.wait(600);
        await d.highlight(summary(d), 6);
        await d.untilSaid(0.3);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Žive osebe", en: "Living people" },
      say: {
        sl: "Najpomembnejša izbira so žive osebe. Pokažete jih lahko z vsemi podatki, z imenom in priimkom, samo z imenom ali samo z začetnicami. Za stran, ki jo lahko vidi vsak, je najvarnejše, da jih izpustite.",
        en: "The most important choice is living people. You can show them with all their details, with their full name, given name only or initials only. For a site anyone can see, the safest is to leave them out.",
      },
      run: async (d) => {
        const living = group(d, LIVING);
        await d.scrollTo(living);
        await d.highlight(living.locator(".tools-privacy-radios"), 6);
        for (const m of [
          { sl: "Vsi podatki", en: "All their details" },
          { sl: "Ime in priimek", en: "Given name and surname" },
          { sl: "Samo ime", en: "Given name only" },
          { sl: "Samo začetnice", en: "Initials only" },
        ]) {
          await d.point(choice(d, m), 600);
          await d.wait(700);
        }
        await d.untilSaid(1.5);
        await d.click(choice(d, { sl: "Izpusti", en: "Leave out" }));
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Osebe, ki so umrle v zadnjih 20 letih, štejejo enako kot žive. Toliko let zahteva slovenski zakon o varstvu osebnih podatkov, število pa lahko spremenite. Osebe, označene kot zasebne, se ne objavijo nikoli.",
        en: "People who died in the last 20 years count as living. That is what Slovenia's data protection act requires, and you can change the number. People marked private are never published.",
      },
      run: async (d) => {
        await d.highlight(group(d, LIVING).locator(".tools-publish-recent"), 6);
        await d.untilSaid(0.3);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Viri, opombe, naslovi", en: "Sources, notes, addresses" },
      say: {
        sl: "Vire, opombe in naslove objavite le, če jih obkljukate. Brez naslovov se dogodek na hišnem naslovu prikaže pri naselju, tudi na zemljevidu.",
        en: "Sources, notes and addresses are published only if you tick them. Without addresses, an event at a house is shown at its village, on the map too.",
      },
      run: async (d) => {
        const inc = group(d, INCLUDE);
        await d.scrollTo(inc);
        await d.highlight(inc, 6);
        await d.click(choice(d, { sl: "Vire", en: "Sources" }));
        await d.wait(500);
        await d.click(choice(d, { sl: "Opombe", en: "Notes" }));
        await d.wait(900);
        await d.point(choice(d, { sl: "Naslove", en: "Addresses" }));
        await d.untilSaid(0.3);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Fotografije", en: "Photos" },
      say: {
        sl: "Fotografije se preberejo iz mape z mediji. Za vsako njeno podmapo določite, kam gredo fotografije iz nje: samo na strani oseb ali tudi v trak na začetni strani. Družinske fotografije naj bodo samo na straneh oseb.",
        en: "Photos are read from the media folder. For each of its subfolders you decide where its photos go: on the people's pages only, or in the strip on the front page as well. Let the family photos stay on the people's pages.",
      },
      run: async (d) => {
        await d.click(choice(d, { sl: "Fotografije", en: "Photos" }));
        await d.wait(700);
        const folders = panel(d).locator(".tools-publish-folders");
        await folders.waitFor();
        await d.wait(600);
        await d.scrollTo(folders);
        await d.highlight(folders, 6);
        await d.wait(1800);
        const family = folders.locator(".tools-publish-folder").filter({ has: d.page.locator(".tools-publish-folder-name", { hasText: /^family$/ }) }).first();
        await d.click(family.locator(".tools-publish-folder-use").first());
        await d.wait(600);
        await d.click(d.page.locator('.dd-menu [role="option"]').filter({ hasText: new RegExp(`^${d.t({ sl: "Strani oseb", en: "Person pages" })}$`) }).first());
        await d.wait(900);
        await d.highlight(null);
      },
    },
    {
      say: {
        sl: "Fotografija, na kateri je skrita oseba, se ne objavi, tudi če je skupinska. Zato poročne fotografije avtorjevih staršev na strani ne bo.",
        en: "A photo showing someone who is hidden is not published, even a group photo. So the wedding photo of the author's parents will not be on the site.",
      },
      run: async (d) => {
        const line = summary(d).locator(".tools-fix-hint").last();
        await d.scrollTo(line);
        await d.highlight(line, 6);
        await d.untilSaid(0.3);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Naslovna fotografija", en: "The cover photo" },
      say: {
        sl: "Naslovno fotografijo izberete sami. Stoji ob naslovu na začetni strani in se pokaže tudi ob deljeni povezavi. Izberimo Frančev portret.",
        en: "You choose the cover photo yourself. It stands beside the title on the front page, and shows with a shared link too. Let's choose Franc's portrait.",
      },
      run: async (d) => {
        const cover = panel(d).locator(".tools-publish-cover");
        await d.scrollTo(cover);
        await d.click(cover.locator(".tools-issue-link").first());
        const picker = d.page.locator(".add-media-dialog");
        await picker.locator(".add-media-cell").first().waitFor();
        await d.wait(700);
        const cell = picker.locator(`.add-media-cell[title^="${COVER}"]`).first();
        await d.scrollTo(cell);
        await d.click(cell);
        await d.wait(500);
        await d.click(picker.locator(".add-media-footer button").last());
        await picker.waitFor({ state: "detached" });
        await d.wait(600);
        await d.highlight(cover, 6);
        await d.wait(1500);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Zemljevid in prikaz oseb", en: "Map and display" },
      say: {
        sl: "Izberete še osnovni zemljevid in sloje, ki jih smejo vklopiti obiskovalci, ter kako so prikazane osebe. Izhodišče so vaše nastavitve v programu.",
        en: "You also choose the base map and the layers visitors may switch on, and how people are shown. Your own settings in the program are the starting point.",
      },
      run: async (d) => {
        const map = group(d, { sl: "Zemljevid", en: "Map" });
        await d.scrollTo(map);
        await d.highlight(map, 6);
        await d.wait(2600);
        const display = group(d, { sl: "Prikaz oseb", en: "How people are shown" });
        await d.scrollTo(display);
        await d.highlight(display, 6);
        await d.untilSaid(0.3);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Prenos", en: "Download" },
      say: {
        sl: "Ker so na strani fotografije, se stran prenese kot ZIP. Razpakirano mapo naložite na svoj spletni strežnik ali pa jo pošljete sorodnikom.",
        en: "Since the site has photos, it downloads as a ZIP. Upload the unpacked folder to your web server, or send it to your relatives.",
      },
      run: async (d) => {
        const button = panel(d).locator(".tools-publish-run .tools-run");
        await d.scrollTo(button);
        // The ZIP is taken from the blob the page downloads, not from the
        // browser's download, which headless Chromium cancels here once a
        // media folder is connected.
        await d.page.evaluate(() => {
          const w = window as unknown as { __gmvZip?: Blob };
          const create = URL.createObjectURL.bind(URL);
          URL.createObjectURL = (o: Blob | MediaSource) => {
            if (o instanceof Blob && o.type === "application/zip") w.__gmvZip = o;
            return create(o);
          };
        });
        await d.click(button);
        await d.page.waitForFunction(() => !!(window as unknown as { __gmvZip?: Blob }).__gmvZip, null, { timeout: 120_000 });
        const b64 = await d.page.evaluate(async () => {
          const bytes = new Uint8Array(await (window as unknown as { __gmvZip: Blob }).__gmvZip.arrayBuffer());
          let s = "";
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(s);
        });
        rmSync(SITE_DIR, { recursive: true, force: true });
        mkdirSync(SITE_DIR, { recursive: true });
        const zip = path.join(SITE_DIR, "..", "site.zip");
        writeFileSync(zip, Buffer.from(b64, "base64"));
        execFileSync("unzip", ["-q", "-o", zip, "-d", SITE_DIR]);
        await d.wait(800);
      },
    },
    {
      callout: { sl: "Stran, kot jo vidijo sorodniki", en: "The site as relatives see it" },
      say: {
        sl: "Tako stran vidijo sorodniki: naslov z naslovno fotografijo, besede za sorodnike in iskanje. Nad njimi je trak obrazov iz družinskih fotografij.",
        en: "This is the site as relatives see it: the title with the cover photo, your words for them, and the search. Above them is a strip of faces from the family photos.",
      },
      run: async (d) => {
        const url = await serveSite();
        await d.frozen(async () => {
          await d.page.goto(url);
          await d.page.locator(".site-home").waitFor();
          await d.page.evaluate(() => document.fonts.ready);
          await d.wait(600);
        });
        await d.overlay("callout", "11", d.t({ sl: "Stran, kot jo vidijo sorodniki", en: "The site as relatives see it" }));
        await d.wait(600);
        await d.highlight(d.page.locator(".site-hero").first(), 6);
        await d.wait(3000);
        const tray = d.page.locator(".site-tray-wrap").first();
        if (await tray.count()) {
          await d.highlight(tray, 6);
          await d.wait(1500);
        }
        await d.highlight(null);
        await d.snapshot();
      },
    },
    {
      say: {
        sl: "Niže so zanimivosti iz drevesa: številke, najpogostejši priimki in obletnice tega tedna.",
        en: "Further down are highlights from the tree: numbers, the most common surnames and this week's anniversaries.",
      },
      run: async (d) => {
        const hl = d.page.locator(".site-highlights").first();
        await d.scrollTo(hl);
        await d.highlight(hl, 6);
        await d.untilSaid(0.3);
        await d.highlight(null);
        await d.page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
        await d.wait(700);
      },
    },
    {
      callout: { sl: "Stran osebe", en: "A person's page" },
      say: {
        sl: "Vsaka oseba ima svojo stran z dogodki, viri, fotografijami in sorodniki. Žive osebe so izpuščene, kot smo izbrali.",
        en: "Every person has a page of their own, with events, sources, photos and relatives. Living people are left out, as we chose.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".site-start a, .site-start button").first());
        await d.page.locator(".site-person").first().waitFor();
        await d.wait(1500);
        const events = d.page.locator(".site-events").first();
        await d.scrollTo(events);
        await d.highlight(events, 6);
        await d.wait(2500);
        const family = d.page.locator(".site-section-family").first();
        if (await family.count()) {
          await d.scrollTo(family);
          await d.highlight(family, 6);
        }
        await d.untilSaid(0.3);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Diagrami in statistika", en: "Charts and statistics" },
      say: {
        sl: "Na strani so tudi diagrami in zemljevid, enaki kot v programu, ter statistika. Sorodniki potrebujejo samo brskalnik.",
        en: "The site has the charts and the map, the same as in the program, and the statistics. All your relatives need is a browser.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".site-nav a").nth(1));
        await d.page.locator(".charts-kind").first().waitFor();
        await d.wait(3500);
        await d.click(d.page.locator(".site-nav a").nth(2));
        await d.wait(3000);
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
