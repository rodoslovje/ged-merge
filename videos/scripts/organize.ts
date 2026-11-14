/**
 * Video 14 (SCENARIJI.md, "Uredi vire"): tidying the sources a file already
 * has — which collections GED Merge recognises and fills in, and what each tab
 * of Organize sources does (Sources, Duplicates, Pages; Repositories in words).
 *
 * Data: demo/preseren-hawlina-viri.ged, the Prešeren pedigree with real links
 * written on purpose in the untidy shapes other programs leave behind (a note,
 * a link field, a web tag, a media link, an inline citation, a page field, a
 * source title). The links:
 *   - Matricula: France Prešeren's baptism (Breznica 00164, p. 86) and death
 *     (Kranj 00932, p. 40), Ana Jelovšek's baptism (Ljubljana – Sv. Jakob
 *     01156, p. 177) — the pages contributor Odar cites in the Slovenian
 *     genealogical index (as in episode 4);
 *   - Geneanet: Ernestina Jelovšek's grave in Prešernov gaj, Kranj (13262440);
 *   - Find a Grave: France Prešeren, Prešernov gaj (memorial 7609860);
 *   - Slovenska biografija sbi463215; Obrazi slovenskih pokrajin
 *     /oseba/preseren-france/; Slovenian Wikipedia "France Prešeren";
 *   - dLib.si: Poezije Dóktorja Francéta Prešérna, 1847
 *     (URN:NBN:SI:DOC-OVOKMGOI) and Ernestina's Spomini na Prešerna, 1903
 *     (URN:NBN:SI:DOC-EQUZU3H7);
 *   - Google Books: Poezije, Mladinska knjiga 1958 (id 0F9EAAAAIAAJ, the
 *     /books/about/ form);
 *   - YouTube: "Dr. France Prešeren - življenje in delo" (0e4cZNi9nTs);
 *   - the dead link: an old SIstory war-victims address
 *     (sistory.si/zrtve/zrtev/?id=7757, 404 since SIstory changed its URLs).
 * The file also holds the Archdiocesan Archive of Ljubljana twice (one with its
 * address) for the Duplicates tab, and a Kranj death-register page image filed
 * under its source but missing from the death citation for the Pages tab.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import { seriesSettings } from "../lib/series.ts";
import type { Scenario, Text } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "preseren-hawlina-viri.ged");

const tab = (d: Director, sl: string, en: string) =>
  d.page.locator(".tools-geo-tabs button").filter({ hasText: d.t({ sl, en }) }).first();
const group = (d: Director, text: string | RegExp) =>
  d.page.locator(".tools-tree > .tools-tree-node").filter({ hasText: text }).first();
const chip = (d: Director, sl: string, en: string) =>
  d.page.locator(".tools-chips .tools-chip").filter({ hasText: d.t({ sl, en }) }).first();
const applyButton = (d: Director) => d.page.locator(".tools-geo-tabs-row .tools-dup-bulk .tools-run");
const selectAll = (d: Director) => d.page.locator(".tools-geo-tabs-row .tools-dup-bulk .tools-issue-link").first();
const fetchButton = (d: Director) => d.page.locator(".tools-reshape-options .tools-run").first();

/** Scroll the page so the tabs row sits at the top: the Tools tiles above it go
 *  off screen and the long list below gets the room. */
async function listToTop(d: Director): Promise<void> {
  await d.page
    .locator(".tools-geo-tabs-row")
    .first()
    .evaluate((el) => {
      // The Tools page scrolls in its own container, not the window.
      const view = el.closest(".tools-view");
      if (!view) return;
      view.scrollBy({ top: el.getBoundingClientRect().top - view.getBoundingClientRect().top - 8, behavior: "instant" });
    });
  await d.wait(300);
}

/** »Razširi vse« on the open list, so every row shows what it holds. */
async function expandAll(d: Director): Promise<void> {
  const btn = d.page.locator("button.tools-issue-link").filter({ hasText: d.t({ sl: "Razširi vse", en: "Expand all" }) }).first();
  if ((await btn.count()) === 0) return;
  await d.click(btn);
  await d.wait(700);
}

/** Pick the citation quality every written citation gets. */
async function setQuay(d: Director, value: Text): Promise<void> {
  const quay = d.page.locator(".tools-reshape-options .tools-reshape-site").nth(2);
  await d.highlight(quay, 4);
  await d.click(quay.locator(".select-menu").first());
  await d.wait(900);
  await d.click(d.page.locator(".dd-item", { hasText: d.t(value) }).first());
  await d.wait(600);
}

/** The collections the program recognises, grouped by kind, for the on-screen list. */
const COLLECTIONS: { name: Text; items: [string, string | Text][] }[] = [
  { name: { sl: "Matične knjige", en: "Parish registers" }, items: [["⛪", "Matricula Online"], ["🌳", "FamilySearch"]] },
  { name: { sl: "Grobovi", en: "Graves" }, items: [["🪦", "Geneanet"], ["🪦", "Find a Grave"], ["🪦", "BillionGraves"]] },
  {
    name: { sl: "Osebe", en: "People" },
    items: [
      ["🪶", "Slovenska biografija"],
      ["👤", "Obrazi slovenskih pokrajin"],
      ["🎖️", { sl: "SIstory — žrtve vojn", en: "SIstory — war victims" }],
      ["🌲", { sl: "Geneanet — rodovniki", en: "Geneanet — trees" }],
    ],
  },
  {
    name: { sl: "Knjige in časopisi", en: "Books and newspapers" },
    items: [["📚", "dLib.si"], ["📖", { sl: "Google Knjige", en: "Google Books" }], ["🗞️", "Newspapers.com"], ["📰", "Legacy.com"]],
  },
  { name: { sl: "Splet", en: "The web" }, items: [["🌐", { sl: "Wikipedija", en: "Wikipedia" }], ["🎬", "YouTube"]] },
];

/** Fetch the ticked groups' details, if any can be fetched, and wait for the lookups. */
async function fetchDetails(d: Director): Promise<void> {
  if ((await fetchButton(d).count()) === 0) return;
  await d.click(fetchButton(d));
  await fetchDone(d);
}

/** Wait for a fetch already started to finish. */
async function fetchDone(d: Director): Promise<void> {
  // The button counts done/total while it runs, and goes once nothing is left to fetch.
  await d.skippable(() =>
    d.page
      .locator(".tools-reshape-options .tools-run")
      .filter({ hasText: /\d+\/\d+/ })
      .waitFor({ state: "detached", timeout: 120_000 }),
    // Nothing happens on screen but a counter: a tenth of it is enough.
    0.1,
  );
  await d.wait(600);
}

/** Apply the open tab's ticked rows and wait for the file to be read again. */
async function apply(d: Director): Promise<void> {
  await d.highlight(applyButton(d), 4);
  await d.wait(900);
  await d.click(applyButton(d));
  await d.page.locator(".tools-cleanup-status").first().waitFor();
  await d.skippable(() =>
    d.page.locator(".tools-cleanup-status .spinner").first().waitFor({ state: "detached", timeout: 60_000 }),
  );
}

const scenario: Scenario = {
  id: "organize",
  episode: 14,
  settings: (lang) => ({
    ...seriesSettings(lang),
    // Online lookups were switched on in episode 4; page images beside every
    // citation ("source, page links") too.
    allowLinkFetch: true,
    formatOverrides: { pageMedia: "event" },
  }),
  title: {
    sl: "GED Merge: uredi vire — od raztresenih povezav do pravih virov",
    en: "GED Merge: organize sources — from scattered links to proper sources",
  },
  description: {
    sl: "Kako GED Merge povezave, raztresene po opombah in poljih povezav, spremeni v prave vire: katere zbirke prepozna (Matricula, FamilySearch, Geneanet, Find a Grave, BillionGraves, Slovenska biografija, Obrazi slovenskih pokrajin, SIstory, dLib, Google Knjige, Wikipedija, YouTube) in kaj naredijo zavihki orodja »Uredi vire«: Viri, Dvojniki, Hrambe in Strani. Primer: rodovnik pesnika Franceta Prešerna.",
    en: "How GED Merge turns links scattered over notes and link fields into proper sources: which collections it recognises (Matricula, FamilySearch, Geneanet, Find a Grave, BillionGraves, Slovenska biografija, Obrazi slovenskih pokrajin, SIstory, dLib, Google Books, Wikipedia, YouTube) and what the tabs of Organize sources do: Sources, Duplicates, Repositories and Pages. Example: the pedigree of the poet France Prešeren.",
  },
  thumbnail: {
    tag: { sl: "Viri", en: "Sources" },
    title: { sl: "Iz povezav *pravi* viri", en: "From links to *real* sources" },
  },
  steps: [
    {
      say: {
        sl: "Mnogi programi povezavo na matično knjigo shranijo kar v opombo. Pokažimo, kako take povezave GED Merge spremeni v prave vire.",
        en: "Many programs store a link to a parish register simply in a note. Let's see how GED Merge turns such links into proper sources.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Uredi vire", en: "Organize sources" },
          { sl: "Od raztresenih povezav do pravih virov", en: "From scattered links to proper sources" },
        );
      },
    },
    {
      say: {
        sl: "Odprimo rodovnik pesnika Franceta Prešerna. Povezave na vire so v njem raztresene po opombah in poljih povezav. Taka povezava ni vir: nima naslova knjige, arhiva ne strani. Če stran nekoč izgine s spleta, ne veste več niti, za kateri vir je šlo.",
        en: "Let's open the pedigree of the poet France Prešeren. Its source links are scattered over notes and link fields. A link like that is not a source: it has no book title, no archive and no page. If the page ever disappears from the web, you no longer even know which source it was.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(700);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.overlay("hideCursor");
        await d.wait(1200);
        await d.highlight(d.page.locator(".edit-person").first(), 6);
      },
    },
    {
      callout: { sl: "Orodja → Viri", en: "Tools → Sources" },
      say: {
        sl: "V Orodjih, pod »Viri«, vidite hrambe, vire in medije v datoteki. Nadškofijski arhiv Ljubljana zaenkrat hrani eno samo knjigo. Povezave, ki niso pripete nobenemu viru, so zbrane posebej.",
        en: "In Tools, under Sources, you see the repositories, sources and media in the file. For now the Archdiocesan Archive of Ljubljana holds a single book. Links not attached to any source are gathered separately.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(d.page.locator(".seg-btn").nth(2));
        await d.wait(800);
        await d.click(d.page.locator(".tools-tab").nth(2));
        await d.page.locator(".tools-tree").first().waitFor();
        await d.wait(800);
        // Open the archive to show what it holds: its book, and that book's page.
        const archive = d.page.locator(".tools-tree > .tools-tree-node").filter({ hasText: "Nadškofijski arhiv" }).first();
        await d.click(archive.locator(".tools-pair-toggle").first());
        await d.wait(700);
        const book = archive.locator(".tools-tree-children .tools-pair-toggle:not(.open)").first();
        if ((await book.count()) > 0) await d.click(book);
        await d.wait(500);
        await d.highlight(archive, 6);
        await d.wait(2500);
        await d.highlight(d.page.locator(".tools-tree").first(), 6);
      },
    },
    {
      callout: { sl: "Uredi vire", en: "Organize sources" },
      say: {
        sl: "Gumb »Uredi vire« pregleda datoteko in pripravi popravke na zavihkih. Zavihek se pokaže le, kadar ima kaj za urediti.",
        en: "The Organize sources button reads the file and prepares fixes on tabs. A tab shows only when it has something to tidy.",
      },
      run: async (d) => {
        await d.highlight(null);
        const toggle = d.page.locator(".tools-chip.tools-dup-toggle").filter({ hasText: d.t({ sl: "Uredi vire", en: "Organize sources" }) }).first();
        await d.skippable(() => toggle.locator(".tools-chip-count").waitFor({ timeout: 60_000 }));
        await d.click(toggle);
        await d.page.locator(".tools-geo-tabs").first().waitFor();
        await d.wait(800);
        await d.highlight(d.page.locator(".tools-geo-tabs").first(), 6);
        await d.wait(1500);
        await d.highlight(null);
        await d.click(tab(d, "Viri", "Sources"));
        await d.page.locator(".tools-chips").first().waitFor();
      },
    },
    {
      callout: { sl: "Prepoznane zbirke", en: "Recognised collections" },
      say: {
        sl: "Program prepozna povezave na matične knjige, grobove, življenjepise, knjige in časopise ter nekatere spletne strani. Vsaka zbirka ima svoj filter. Obdelujte jih eno za drugo, tako ostane seznam pregleden, tudi ko je povezav na stotine.",
        en: "The program recognises links to parish registers, graves, biographies, books and newspapers, and some websites. Each collection has its own filter. Work through them one at a time, so the list stays clear even with hundreds of links.",
      },
      run: async (d) => {
        await d.overlay(
          "list",
          d.t({ sl: "Prepoznane zbirke", en: "Recognised collections" }),
          COLLECTIONS.map((g) => ({
            name: d.t(g.name),
            items: g.items.map(([icon, label]) => [icon, typeof label === "string" ? label : d.t(label)] as [string, string]),
          })),
        );
        // The ring walks the file's own collections, filter by filter.
        const chips = d.page.locator(".tools-chips .tools-chip").filter({ hasNotText: d.t({ sl: "Vsi", en: "All" }) });
        const n = await chips.count();
        for (let i = 0; i < n; i++) {
          await d.highlight(chips.nth(i), 4);
          await d.wait(1100);
        }
        await d.highlight(d.page.locator(".tools-chips .tools-chip.active").first(), 4);
        await d.snapshot();
        await d.untilSaid();
        await d.overlay("list", null, []);
      },
    },
    {
      say: {
        sl: "Začnimo z Matriculo. Povezave so razvrščene po knjigi. Vrstica pove, kje v datoteki je povezava zdaj, na primer v opombi pri rojstvu.",
        en: "Let's start with Matricula. The links are grouped by book. Each row tells where the link sits in the file now, for example in a note on the birth.",
      },
      run: async (d) => {
        await d.highlight(null);
        await expandAll(d);
        await d.highlight(group(d, "00164"), 6);
      },
    },
    {
      callout: { sl: "Podatki s spleta", en: "Details from the web" },
      say: {
        sl: "Že iz same povezave program razbere župnijo, knjigo in stran. Izberite vse knjige in z gumbom »Pridobi podatke o virih« prebere še pravi naslov knjige, arhiv in leta. Za vsako knjigo pošlje le njeno povezavo, nikoli vašega drevesa.",
        en: "From the link alone the program reads the parish, the book and the page. Select all the books, and with Fetch source details it also reads each book's real title, the archive and the years. For each book it sends only that book's link, never your tree.",
      },
      run: async (d) => {
        await d.highlight(selectAll(d), 4);
        await d.wait(1500);
        await d.click(selectAll(d));
        await d.wait(900);
        await d.highlight(fetchButton(d), 4);
        await d.wait(1200);
        await fetchDetails(d);
        await d.highlight(group(d, "00164"), 6);
      },
    },
    {
      callout: { sl: "Navedbe na dogodkih", en: "Citations on events" },
      say: {
        sl: "Navedba iz krstne knjige pristane pri rojstvu, iz mrliške pri smrti, grob pa pri pokopu. Če dogodka še ni, ga program ustvari.",
        en: "A citation from a baptism register lands on the birth, one from a death register on the death, and a grave on the burial. If the event is missing, the program creates it.",
      },
      run: async (d) => {
        const options = d.page.locator(".tools-reshape-options").first();
        await d.highlight(options.locator(".tools-reshape-site").first(), 4);
      },
    },
    {
      callout: { sl: "Kakovost citata", en: "Citation quality" },
      say: {
        sl: "Kakovost citata nastavite za vse navedbe hkrati. Matične knjige so primarni vir. Izbira se pokaže v vsaki vrstici.",
        en: "You set the citation quality for all citations at once. Parish registers are primary evidence. The choice shows in every row.",
      },
      run: async (d) => {
        await setQuay(d, { sl: "primarni vir", en: "primary evidence" });
        // Every citation row below takes the value at once.
        await d.highlight(d.page.locator(".tools-tree").first(), 6);
        await d.wait(2500);
      },
    },
    {
      say: {
        sl: "Vsak predlog pred pretvorbo lahko popravite s svinčnikom: naslov, arhivsko številko ali hrambo, ki ji vir pripada.",
        en: "Before converting, you can correct any proposal with the pencil: the title, the call number or the repository the source belongs to.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(group(d, "00164").locator("button.tools-issue-link", { hasText: "✎" }));
        const dialog = d.page.locator(".add-source-dialog");
        await dialog.waitFor();
        await d.wait(800);
        await d.highlight(dialog, 4);
        await d.wait(3500);
        await d.highlight(null);
        await d.click(dialog.locator(".add-source-actions .nav-btn").first());
        await dialog.waitFor({ state: "detached" });
      },
    },
    {
      say: {
        sl: "Izbrane knjige pretvorite v vire v enem koraku. Spremembe se zapišejo, ko datoteko shranite.",
        en: "Convert the selected books into sources in one step. The changes are written when you save the file.",
      },
      run: async (d) => {
        await apply(d);
        await d.highlight(d.page.locator(".tools-cleanup-status").first(), 4);
      },
    },
    {
      callout: { sl: "Grobovi", en: "Graves" },
      say: {
        sl: "Nato grobovi na Geneanetu. Grob ni primarni vir za smrt, zato kakovost citata nastavimo na sekundarni vir. Grob pristane pri pokopu. Ernestina pokopa še nima, zato ga program ustvari.",
        en: "Then the graves on Geneanet. A grave is not primary evidence of a death, so we set the citation quality to secondary evidence. The grave lands on the burial. Ernestina has no burial yet, so the program creates it.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(chip(d, "Geneanet", "Geneanet"));
        await d.wait(500);
        await expandAll(d);
        await d.click(selectAll(d));
        // The lookup runs while the quality is set, so the step does not wait on it afterwards.
        if ((await fetchButton(d).count()) > 0) await d.click(fetchButton(d));
        await setQuay(d, { sl: "sekundarni vir", en: "secondary evidence" });
        await fetchDone(d);
        await d.highlight(d.page.locator(".tools-tree").first(), 6);
        await d.wait(800);
        await apply(d);
      },
    },
    {
      callout: { sl: "Vse ostale", en: "All the rest" },
      say: {
        sl: "Ostale zbirke lahko obdelate skupaj, pod »Vsi«. Kakovost citata ostane sekundarni vir: življenjepis ali knjiga nista primarni vir za rojstvo ali smrt.",
        en: "The remaining collections can be done together, under All. The citation quality stays secondary evidence: a biography or a book is not primary evidence of a birth or a death.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(chip(d, "Vsi", "All"));
        await d.wait(700);
        await expandAll(d);
        await listToTop(d);
        // Ring only rows already on screen: ringing the whole (tall) list
        // scrolls it back and the Tools tiles return.
        await d.highlight(d.page.locator(".tools-chips").first(), 6);
        await d.wait(1500);
        await d.highlight(d.page.locator(".tools-reshape-options .tools-reshape-site").nth(2), 4);
      },
    },
    {
      callout: { sl: "Podatki za vse", en: "Details for all" },
      say: {
        sl: "Izberite vse in pridobite podatke: pri dLib in Google Knjigah naslov dela, pri življenjepisih ime osebe, pri YouTubu naslov videa in avtorja.",
        en: "Select all and fetch the details: a work's title on dLib and Google Books, the person's name for the biographies, a video's title and author on YouTube.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(selectAll(d));
        await d.wait(600);
        await fetchDetails(d);
        await listToTop(d);
        await d.highlight(d.page.locator(".tools-tree > .tools-tree-node").nth(1), 4);
      },
    },
    {
      callout: { sl: "Mrtve povezave", en: "Dead links" },
      say: {
        sl: "Za eno povezavo program ni našel ničesar, zato je ostala brez naslova. Vodi na staro stran žrtev vojn na SIstory, ki je ni več. Označite jo za odstranitev: izgine z vseh mest v datoteki, besedilo opombe ostane, vir pa ne nastane.",
        en: "For one link the program found nothing, so it stayed without a title. It leads to an old page of war victims on SIstory that no longer exists. Mark it for removal: it disappears from every place in the file, the note's text stays, and no source is created.",
      },
      run: async (d) => {
        const dead = group(d, "SIstory");
        await dead.scrollIntoViewIfNeeded();
        await d.highlight(dead, 4);
        await d.wait(4500);
        await d.click(dead.locator("button.tools-issue-link", { hasText: "🗑" }));
        await d.wait(600);
        await d.highlight(dead.locator(".tools-reshape-badge.remove"), 6);
      },
    },
    {
      callout: { sl: "Pretvorba", en: "Converting" },
      say: {
        sl: "Nato vse pretvorite v enem koraku.",
        en: "Then convert everything in one step.",
      },
      run: async (d) => {
        await d.highlight(null);
        await apply(d);
      },
    },
    {
      callout: { sl: "Dvojniki", en: "Duplicates" },
      say: {
        sl: "Na zavihku »Dvojniki« so zapisi, ki opisujejo isto stvar pod različnima oznakama. Tu je isti vir, rodovnik Petra Hawline, zapisan dvakrat: pri Prešernu z avtorjem, pri Ani Jelovšek brez njega. Zapis, ki pove manj, se pridruži popolnejšemu.",
        en: "The Duplicates tab lists records that describe the same thing under different ids. Here one source, Peter Hawlina's pedigree, is written twice: with its author for Prešeren, without one for Ana Jelovšek. The record that says less joins the fuller one.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(tab(d, "Dvojniki", "Duplicates"));
        await d.wait(900);
        await expandAll(d);
        await d.highlight(group(d, "Hawline"), 6);
      },
    },
    {
      say: {
        sl: "Program obdrži zapis z več sklici, prenese vanj, kar povedo samo drugi, in vse navedbe preusmeri nanj.",
        en: "The program keeps the record with more references, copies into it what only the others say, and points every citation at it.",
      },
      run: async (d) => {
        const kranj = group(d, "Hawline");
        await d.highlight(kranj.locator(".tools-dup-member.survivor").first(), 4);
        await d.wait(2000);
        await d.click(kranj.locator(".tools-dup-check").first());
        await d.wait(600);
        await apply(d);
      },
    },
    {
      callout: { sl: "Strani in hrambe", en: "Pages and repositories" },
      say: {
        sl: "Zavihek »Strani« najde navedbe brez slike strani, ki jih dokazuje, in jim sliko pripne. Zavihek »Hrambe« pa vire s FamilySearcha zbere pod hrambo države, iz katere so knjige.",
        en: "The Pages tab finds citations without the page image that documents them and attaches it. The Repositories tab gathers FamilySearch sources under the repository of the country the books come from.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(tab(d, "Strani", "Pages"));
        await d.wait(900);
        await expandAll(d);
        const kranj = d.page.locator(".tools-tree > .tools-tree-node").first();
        await d.highlight(kranj, 6);
        await d.wait(1500);
        await d.highlight(null);
        await d.click(selectAll(d));
        await d.wait(600);
        await apply(d);
      },
    },
    {
      callout: { sl: "Hrambe in viri", en: "Repositories and sources" },
      say: {
        sl: "Nazaj v pregledu virov je zdaj vse urejeno: hramba Nadškofijski arhiv Ljubljana, v njej matične knjige, pod vsako knjigo navedene strani, ob vsaki strani pa osebe, ki se nanjo sklicujejo.",
        en: "Back in the sources overview, everything is in order now: the Archdiocesan Archive of Ljubljana as a repository, its parish registers, under each book the pages cited, and beside each page the people who cite it.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(d.page.getByText(d.t({ sl: "Nazaj na vire", en: "Back to Sources" }), { exact: true }).first());
        await d.page.locator(".tools-tree").first().waitFor();
        await d.wait(700);
        const repo = d.page.locator(".tools-tree > .tools-tree-node").filter({ hasText: "Nadškofijski arhiv" }).first();
        await repo.scrollIntoViewIfNeeded();
        // Open the repository, then every book, page and list of people inside it.
        for (let i = 0; i < 16; i++) {
          const closed = repo.locator(".tools-pair-toggle:not(.open)").first();
          if ((await closed.count()) === 0) break;
          await closed.click();
          await d.wait(400);
        }
        await d.highlight(repo, 6);
        await d.wait(1500);
      },
    },
    {
      callout: { sl: "Rezultat", en: "The result" },
      say: {
        sl: "V Urejanju so opombe zdaj pravi viri: s knjigo, stranjo in povezavo, ki odpre sken. Ernestina je dobila še pokop z grobom v Prešernovem gaju.",
        en: "In Edit, the notes are now proper sources: with a book, a page and a link that opens the scan. Ernestina has also gained a burial, with her grave in Prešernov gaj.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(d.page.locator(".seg-btn").nth(0));
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(900);
        await d.highlight(d.page.locator(".edit-person .edit-event").filter({ hasText: d.t({ sl: "Rojstvo", en: "Birth" }) }).first(), 6);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(d.page.locator(".person-card").filter({ hasText: "Ernestina" }).filter({ visible: true }).first());
        await d.wait(1200);
        await d.highlight(d.page.locator(".edit-person .edit-event").filter({ hasText: d.t({ sl: "Pokop", en: "Burial" }) }).first(), 6);
      },
    },
    {
      callout: { sl: "Shranjevanje", en: "Saving" },
      say: {
        sl: "V predogledu shranjevanja vidite, kako so viri zapisani v datoteki GEDCOM.",
        en: "The save preview shows how the sources are written into the GEDCOM file.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(d.page.locator(".app-head-actions .export-btn"));
        await d.wait(1500);
        await d.click(d.page.getByText(d.t({ sl: "Vrstice GEDCOM", en: "GEDCOM lines" }), { exact: true }).first());
        await d.wait(6000);
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
