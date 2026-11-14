/**
 * Video 15 (SCENARIJI.md, "Paketno urejanje"): pick people from the whole file
 * with stacked filters, review the matches and apply one action to all of
 * them — married names, a died-young image, estimated marriage dates — and
 * save the filters, some with no action at all, as searches to run again.
 *
 * Data: `rodbina-renko.ged` (the anonymised excerpt of the author's tree, as in
 * episodes 9, 11 and 12), the author as the start person. Counts checked on
 * 14 Nov 2026: 497 married women without a married name (57 left unchecked,
 * no marriage recorded), 185 people who died before 20, 147 partners in a
 * union with an undated marriage (77 families), 399 ancestors of whom 198
 * cite no source.
 *
 * The died-young image is `icons/died-young.jpg` from the author's media
 * folder (`~/Work/rod/renko-ged/media`, or `VIDEO_MEDIA_DIR`), which is not in
 * this repository. Episode 12 connects a media folder on camera; here it is
 * connected before the video starts, behind the title card: the file is copied
 * into the browser's private file system and that folder is stored as the
 * app's media folder, then the page reloads.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator } from "@playwright/test";
import { en } from "../../src/locales/en.ts";
import { sl } from "../../src/locales/sl.ts";
import type { Director } from "../lib/director.ts";
import { seriesSettingsWithMaps } from "../lib/series.ts";
import type { Scenario } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "rodbina-renko.ged");
const MEDIA_DIR = process.env.VIDEO_MEDIA_DIR ?? path.join(os.homedir(), "Work", "rod", "renko-ged", "media");
const DIED_YOUNG = "icons/died-young.jpg";

/** Tools in the tab row: 0 stats, 1 places, 2 sources, 3 validate, 4 duplicates, 5 normalize & batch, 6 privacy. */
const BATCH_TAB = 5;

type Key = keyof typeof en & keyof typeof sl;
/** A UI label exactly as the app shows it in the video's language. */
const L = (d: Director, key: Key): string => (d.lang === "sl" ? sl : en)[key];

const view = (d: Director) => d.page.locator(".batch-section").first();
const crit = (d: Director, i: number) => view(d).locator(".batch-crit").nth(i);
/** A menu option by its whole label (»Ime« must not pick »Ime vsebuje«), or by part of it. */
const option = (d: Director, text: string, exact = true) =>
  d.page
    .locator(".dd-menu [role=option], .picker-menu-popover [role=menuitemradio]")
    .filter({ visible: true })
    .filter({ hasText: exact ? new RegExp(`^\\W*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\W*$`) : text })
    .first();
const count = (d: Director) => view(d).locator(".batch-results-count").first();
const rows = (d: Director) => view(d).locator(".batch-row");
const actionSelect = (d: Director) => view(d).locator(".batch-action .batch-select").first();

/** Open a menu and pick the option that reads `text`. */
async function choose(d: Director, trigger: Locator, text: string, exact = true): Promise<void> {
  await d.click(trigger);
  await option(d, text, exact).waitFor();
  await d.wait(350);
  await d.click(option(d, text, exact));
  await d.wait(500);
}

/** Add a filter row of the given kind (by its label key) and return it. */
async function addFilter(d: Director, label: Key): Promise<Locator> {
  const n = await view(d).locator(".batch-crit").count();
  await choose(d, view(d).locator(".batch-add-filter .picker-menu-btn"), L(d, label));
  return crit(d, n);
}

/** Remove every filter row and the previous action — the clean slate between
 *  examples, or the old action's previews (»bo preskočeno«) fill the new list. */
async function clearFilters(d: Director): Promise<void> {
  const none = L(d, "tools.batch.action.none");
  if ((await actionSelect(d).innerText()).trim().replace(/\s*▾$/, "") !== none) {
    await d.scrollTo(actionSelect(d));
    await choose(d, actionSelect(d), none);
    await d.scrollTo(view(d).locator(".batch-builder"));
  }
  while (await view(d).locator(".batch-crit").count()) {
    await d.click(crit(d, 0).locator(".batch-remove"));
    await d.wait(250);
  }
}

/** Type into an input as a person would. */
async function type(d: Director, input: Locator, text: string): Promise<void> {
  await d.click(input);
  // Select what is there and type over it: emptying a number field first
  // leaves the app's 0 behind (»018«).
  await input.press("ControlOrMeta+a");
  await d.page.keyboard.type(text, { delay: 60 });
}

/** Apply the action to the checked rows and wait for the report. */
async function apply(d: Director): Promise<void> {
  await d.click(view(d).locator(".batch-action .tools-run"));
  const confirm = view(d).locator(".batch-confirm .nav-btn.primary");
  await confirm.waitFor();
  await d.highlight(view(d).locator(".batch-confirm"), 4);
  await d.wait(1500);
  await d.highlight(null);
  await d.click(confirm);
  await view(d).locator(".batch-done").waitFor();
  await d.wait(400);
  await d.highlight(view(d).locator(".batch-done"), 4);
}

/** Save the current filter (and action) under `name`. */
async function save(d: Director, name: string): Promise<void> {
  const input = view(d).locator(".batch-save-name");
  await d.scrollTo(input);
  await type(d, input, name);
  await d.wait(300);
  await d.click(view(d).locator(".batch-save .nav-btn"));
  await d.wait(600);
}

/** Back from the Edit view to the batch tool, where the filters are kept. */
async function backToTools(d: Director): Promise<void> {
  await d.click(d.page.locator(".seg-btn").nth(2));
  await view(d).waitFor();
  await d.wait(500);
}

/** Copy the died-young image into the browser's private file system and store that folder as the media folder. */
async function connectMediaFolder(d: Director): Promise<void> {
  const b64 = readFileSync(path.join(MEDIA_DIR, DIED_YOUNG)).toString("base64");
  await d.page.evaluate(
    async ([rel, data]) => {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry("media", { recursive: true });
      } catch { /* first run */ }
      const media = await root.getDirectoryHandle("media", { create: true });
      const segs = rel.split("/");
      let dir = media;
      for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create: true });
      const w = await (await dir.getFileHandle(segs[segs.length - 1], { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      await w.close();
      // The app's own store for the folder (MediaFolderContext): restored on load.
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("gedmerge", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("mediaFolder");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction("mediaFolder", "readwrite");
          tx.objectStore("mediaFolder").put(media, "handle");
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    [DIED_YOUNG, b64] as const,
  );
}

const scenario: Scenario = {
  id: "batch",
  episode: 15,
  settings: seriesSettingsWithMaps,
  title: {
    sl: "GED Merge: paketno urejanje — en popravek za sto oseb naenkrat",
    en: "GED Merge: batch editing — one fix for a hundred people at once",
  },
  description: {
    sl: "Kako v GED Merge s filtri izberete osebe iz celotnega drevesa, preverite zadetke in nad vsemi izvedete en ukrep: poročni priimki po partnerjih, sličica za otroke, ki so umrli mladi, in ocenjeni datumi porok. Filtre shranite, nekatere tudi brez ukrepa, kot iskanja za nadaljnje raziskovanje. Podatki: anonimiziran izsek iz avtorjevega rodovnika.",
    en: "How to pick people from your whole tree with filters in GED Merge, review the matches and apply one action to all of them: married names from the partners, an image marking children who died young, and estimated marriage dates. Save the filters, some without an action, as searches for further research. Data: an anonymised excerpt of the author's family tree.",
  },
  thumbnail: {
    tag: { sl: "Paketno urejanje", en: "Batch editing" },
    title: { sl: "En popravek, *sto* oseb", en: "One fix, a *hundred* people" },
  },
  steps: [
    {
      say: {
        sl: "Nekateri popravki so enaki za sto oseb. Namesto da jih urejate eno za drugo, jih s filtri izberete in popravite naenkrat.",
        en: "Some fixes are the same for a hundred people. Instead of editing them one by one, you pick them with filters and fix them all at once.",
      },
      run: async (d) => {
        const intro = {
          kicker: { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          title: { sl: "Paketno urejanje", en: "Batch editing" },
          line: { sl: "En popravek za sto oseb naenkrat", en: "One fix for a hundred people at once" },
        };
        await d.holdCard(intro.kicker, intro.title, intro.line);
        // The media folder is connected before the video starts (episode 12 shows how).
        await d.frozen(async () => {
          await connectMediaFolder(d);
          await d.page.reload();
          await d.page.locator("input.file-input").first().waitFor({ state: "attached" });
          await d.page.evaluate(() => document.fonts.ready);
        });
        await d.holdCard(null, null);
        await d.card(intro.kicker, intro.title, intro.line);
      },
    },
    {
      callout: { sl: "Paketna opravila", en: "Batch actions" },
      say: {
        sl: "Odprimo izsek iz avtorjevega rodovnika. V Orodjih izberite »Poenoti in paketno uredi«. Filtri izberejo osebe iz celotne datoteke, seznam pokaže zadetke, izbrani ukrep pa se izvede nad vsemi označenimi.",
        en: "Let's open the excerpt of the author's tree. In Tools, choose Normalize & batch. Filters pick people from the whole file, the list shows the matches, and the action you choose is applied to every ticked one.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(700);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(1000);
        await d.click(d.page.locator(".seg-btn").nth(2));
        await d.wait(600);
        await d.click(d.page.locator(".tools-tab").nth(BATCH_TAB));
        await view(d).waitFor();
        await d.wait(800);
        await d.highlight(view(d).locator(".batch-builder"), 4);
        await d.wait(2200);
        await d.highlight(view(d).locator(".batch-results"), 4);
        await d.wait(2000);
        await d.highlight(view(d).locator(".batch-action"), 4);
      },
    },
    {
      callout: { sl: "Poročni priimki", en: "Married names" },
      say: {
        sl: "Najprej poročni priimki. Poiščimo ženske, ki imajo partnerja, poročnega priimka pa še nimajo. Dodamo tri filtre: spol, sorodnike in ime.",
        en: "First, married names. Let's find the women who have a partner but no married name yet. We add three filters: sex, relatives and name.",
      },
      run: async (d) => {
        await d.highlight(null);
        await addFilter(d, "tools.batch.crit.sex");
        await addFilter(d, "tools.batch.crit.relation");
        const name = await addFilter(d, "tools.batch.crit.nameField");
        await choose(d, name.locator(".batch-select").first(), L(d, "tools.batch.nameField.married.lacks"));
        await d.highlight(count(d), 4);
      },
    },
    {
      say: {
        sl: "Ustreza 497 žensk. Za ukrep izberemo »Dodaj poročni priimek po partnerju«. Vsaka vrstica zdaj pokaže priimek, ki se bo zapisal. Kjer poroka ni zapisana, je vrstica neoznačena: tak par morda ni bil poročen. Te osebe preverite in jih po potrebi označite sami.",
        en: "497 women match. As the action, we choose Add married name from partner. Each row now shows the surname that will be written. Where no marriage is recorded, the row is left unticked: that couple may never have married. Check those people and tick them yourself if needed.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.scrollTo(actionSelect(d));
        await choose(d, actionSelect(d), L(d, "tools.batch.action.addMarriedName"));
        await d.scrollTo(view(d).locator(".batch-results"));
        await d.highlight(rows(d).first().locator(".batch-preview"), 4);
        await d.wait(3500);
        const doubtful = rows(d).filter({ has: d.page.locator(".batch-preview-off") }).first();
        await d.highlight(doubtful, 4);
        await d.wait(2500);
        await d.highlight(view(d).locator(".batch-results-note"), 4);
      },
    },
    {
      say: {
        sl: "Kliknite gumb za izvedbo in potrdite. Poročni priimek je dobilo 435 žensk, v enem koraku.",
        en: "Click the apply button and confirm. 435 women got their married name, in one step.",
      },
      run: async (d) => {
        await d.highlight(null);
        await apply(d);
      },
    },
    {
      callout: { sl: "Shranjeni filtri", en: "Saved filters" },
      say: {
        sl: "Filter shranimo skupaj z ukrepom, pod imenom »Poročni priimki«. Seznam shranjenih filtrov vedno pokaže, koliko oseb trenutno ustreza. Ko vnesete nove poroke, filter naložite in ukrep izvedete znova.",
        en: "We save the filter together with its action, as Married names. The list of saved filters always shows how many people match right now. When you've entered new marriages, load the filter and run the action again.",
      },
      run: async (d) => {
        await d.highlight(null);
        await save(d, d.t({ sl: "Poročni priimki", en: "Married names" }));
        await d.scrollTo(view(d).locator(".batch-saved"));
        await d.highlight(view(d).locator(".batch-saved-row").first(), 4);
      },
    },
    {
      callout: { sl: "Umrli mladi", en: "Died young" },
      say: {
        sl: "Drugi primer: otroci, ki so umrli mladi. Filter »Živi« nastavimo na umrle, »Starost« pa na manj kot 20 let. Starost se pri umrlih šteje ob smrti. Najdemo 185 oseb.",
        en: "A second example: children who died young. We set Living to deceased and Age to less than 20 years. For the deceased, age counts at death. We find 185 people.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.scrollTo(view(d).locator(".batch-builder"));
        await clearFilters(d);
        const living = await addFilter(d, "tools.batch.crit.living");
        await choose(d, living.locator(".batch-select").first(), L(d, "tools.batch.living.no"));
        const age = await addFilter(d, "tools.batch.crit.age");
        // 20 years is the filter's own default: ring it rather than retype it.
        await d.highlight(age, 4);
        await d.wait(1500);
        await d.highlight(count(d), 4);
      },
    },
    {
      say: {
        sl: "Vsem pripnemo isto sličico, da jih v drevesu takoj prepoznamo. Izberite »Pripni medij« in »Nova slika«, nato vpišite pot do slike v mapi z mediji.",
        en: "We attach the same small image to all of them, so they stand out in the tree at once. Choose Attach media and New image, then type the image's path in your media folder.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.scrollTo(actionSelect(d));
        await choose(d, actionSelect(d), L(d, "tools.batch.action.addMedia"));
        await choose(d, view(d).locator(".batch-action .batch-media-select"), L(d, "tools.batch.newMedia"));
        const inputs = view(d).locator(".batch-action input.batch-input");
        await type(d, inputs.nth(0), DIED_YOUNG);
        await type(d, inputs.nth(1), "died-young");
        await d.wait(400);
        await apply(d);
      },
    },
    {
      say: {
        sl: "Klik na ime odpre osebo v Urejanju. Sličica je zdaj ob vsakem otroku, ki je umrl mlad.",
        en: "A click on a name opens the person in Edit. Every child who died young now carries the image.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.scrollTo(view(d).locator(".batch-results"));
        await d.click(rows(d).first().locator(".tools-issue-link"));
        await d.page.locator(".edit-person").filter({ visible: true }).first().waitFor();
        await d.wait(900);
        await d.highlight(d.page.locator(".edit-person .person-media-btn").filter({ visible: true }).first(), 6);
        await d.wait(3000);
        await d.highlight(null);
        await backToTools(d);
      },
    },
    {
      say: {
        sl: "Dodamo še filter »Mediji« s pogojem, da te slike nimajo. Zdaj ne ustreza nihče. Filter shranimo kot »Umrli mladi«: ko vnesete novega otroka, ki je umrl mlad, ga bo našel.",
        en: "We add one more filter, Media, for people without this image. Now nobody matches. We save the filter as Died young: when you enter another child who died young, it will find them.",
      },
      run: async (d) => {
        await d.scrollTo(view(d).locator(".batch-builder"));
        const media = await addFilter(d, "tools.batch.crit.media");
        await choose(d, media.locator(".batch-select").first(), L(d, "tools.batch.media.lacks"));
        await choose(d, media.locator(".batch-media-select"), "died-young", false);
        await d.highlight(count(d), 4);
        await d.wait(1500);
        await d.highlight(null);
        await save(d, d.t({ sl: "Umrli mladi", en: "Died young" }));
      },
    },
    {
      callout: { sl: "Poroke brez datuma", en: "Undated marriages" },
      say: {
        sl: "Tretji primer: poroke brez datuma. Filtru »Sorodniki: ima partnerja« dodamo filter »Zveza« z možnostjo »nima datuma« za poroko. Najde 147 oseb.",
        en: "A third example: marriages without a date. Next to Relatives has a partner, we add the Union filter, set to has no date for Marriage. It finds 147 people.",
      },
      run: async (d) => {
        await clearFilters(d);
        await addFilter(d, "tools.batch.crit.relation");
        const union = await addFilter(d, "tools.batch.crit.familyEvent");
        await choose(d, union.locator(".batch-select").first(), L(d, "tools.batch.event.undated"));
        await d.highlight(count(d), 4);
      },
    },
    {
      say: {
        sl: "Izberemo ukrep »Dodaj ocenjen datum poroke«. Kjer ima kateri od otrok natančen datum rojstva, se par poroči pred njim: zapiše se »BEF« in leto rojstva najstarejšega otroka. Sicer se zapiše približno leto, »ABT«, iz ocenjenega rojstva otroka ali iz let rojstva zakoncev.",
        en: "We choose the action Add estimated marriage date. Where a child has an exact birth date, the couple married before it: the action writes BEF and the oldest child's birth year. Otherwise it writes an approximate year, ABT, from a child's estimated birth or from the spouses' births.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.scrollTo(actionSelect(d));
        await choose(d, actionSelect(d), L(d, "tools.batch.action.estimateMarriage"));
        await d.scrollTo(view(d).locator(".batch-results"));
        await d.highlight(rows(d).filter({ hasText: "BEF" }).first().locator(".batch-preview"), 4);
        await d.wait(900);
        await d.snapshot();
        await d.wait(3500);
        await d.highlight(rows(d).filter({ hasText: "ABT" }).first().locator(".batch-preview"), 4);
      },
    },
    {
      say: {
        sl: "Ukrep izvedemo in filter shranimo kot »Poroke brez datuma«.",
        en: "We apply the action and save the filter as Undated marriages.",
      },
      run: async (d) => {
        await d.highlight(null);
        await apply(d);
        await d.wait(1200);
        await d.highlight(null);
        await save(d, d.t({ sl: "Poroke brez datuma", en: "Undated marriages" }));
      },
    },
    {
      callout: { sl: "Iskanje brez ukrepa", en: "A search without an action" },
      say: {
        sl: "Filter je uporaben tudi brez ukrepa, kot shranjeno iskanje. Možnost »ima ocenjen datum« najde vse ocenjene poroke. Te je dobro preveriti v matičnih knjigah. Če pozneje dodate starejšega otroka, ukrep oceno »BEF« tudi popravi. Shranimo ga kot »Ocenjene poroke«.",
        en: "A filter is useful without an action too, as a saved search. The option has an estimated date for finds every estimated marriage. Those are worth checking in the parish registers. And if you later add an older child, the action corrects a BEF estimate. We save it as Estimated marriages.",
      },
      run: async (d) => {
        await d.scrollTo(view(d).locator(".batch-builder"));
        await choose(d, crit(d, 1).locator(".batch-select").first(), L(d, "tools.batch.event.estimated"));
        await d.highlight(count(d), 4);
        await d.wait(1500);
        await d.highlight(null);
        await d.scrollTo(actionSelect(d));
        await choose(d, actionSelect(d), L(d, "tools.batch.action.none"));
        await save(d, d.t({ sl: "Ocenjene poroke", en: "Estimated marriages" }));
      },
    },
    {
      callout: { sl: "Predniki brez virov", en: "Ancestors without sources" },
      say: {
        sl: "Še en seznam nalog: filter »Sorodstvo« z neposrednimi predniki izhodiščne osebe in filter »Viri« z osebami brez virov. Od 399 avtorjevih prednikov jih 198 nima nobenega vira. Shranimo ga kot »Predniki brez virov« in se nanj vračamo med raziskovanjem.",
        en: "One more to-do list: the Kinship filter set to the start person's direct ancestors, and the Sources filter set to people without sources. Of the author's 399 ancestors, 198 cite no source at all. We save it as Ancestors without sources and come back to it while researching.",
      },
      run: async (d) => {
        await d.scrollTo(view(d).locator(".batch-builder"));
        await clearFilters(d);
        const kin = await addFilter(d, "tools.batch.crit.kinship");
        await choose(d, kin.locator(".batch-select").first(), L(d, "tools.batch.kinship.ancestor"));
        await addFilter(d, "tools.batch.crit.sources");
        await d.highlight(count(d), 4);
        await d.wait(2500);
        await d.highlight(null);
        await save(d, d.t({ sl: "Predniki brez virov", en: "Ancestors without sources" }));
      },
    },
    {
      say: {
        sl: "Vsi shranjeni filtri so zbrani na vrhu, vsak s številom oseb, ki mu trenutno ustrezajo. Klik na ime filter naloži. Shranjeni so v brskalniku, ne v datoteki GEDCOM, zato jih na drugem računalniku ni.",
        en: "All saved filters are gathered at the top, each with the number of people it matches right now. A click on a name loads the filter. They are kept in the browser, not in the GEDCOM file, so another computer won't have them.",
      },
      run: async (d) => {
        await d.scrollTo(view(d).locator(".batch-saved"));
        await d.highlight(view(d).locator(".batch-saved"), 4);
        await d.wait(3500);
        await d.highlight(null);
        await d.click(view(d).locator(".batch-saved-load").filter({ hasText: d.t({ sl: "Poročni priimki", en: "Married names" }) }));
        await d.wait(800);
        await d.highlight(view(d).locator(".batch-builder"), 4);
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
