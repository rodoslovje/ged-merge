/**
 * Video 13 (SCENARIJI.md, "Uredi vire"): tidying the sources a file already
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
import type { Scenario } from "../lib/types.ts";

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

/** Fetch the ticked groups' details, if any can be fetched, and wait for the lookups. */
async function fetchDetails(d: Director): Promise<void> {
  if ((await fetchButton(d).count()) === 0) return;
  await d.click(fetchButton(d));
  // The button counts done/total while it runs, and goes once nothing is left to fetch.
  await d.skippable(() =>
    d.page
      .locator(".tools-reshape-options .tools-run")
      .filter({ hasText: /\d+\/\d+/ })
      .waitFor({ state: "detached", timeout: 120_000 }),
  );
  await d.wait(600);
}

/**
 * One collection, start to finish: its filter chip (by name, or the first one
 * left), select all, fetch the details, a look at the result, convert.
 */
async function convertSite(d: Director, name: string | null, look: number): Promise<void> {
  const target = name
    ? d.page.locator(".tools-chips .tools-chip").filter({ hasText: name }).first()
    : d.page
        .locator(".tools-chips .tools-chip")
        .filter({ hasNotText: d.t({ sl: "Vsi", en: "All" }) })
        .filter({ hasNotText: d.t({ sl: "Druge povezave", en: "Other links" }) })
        .first();
  await d.click(target);
  await d.wait(700);
  await d.click(selectAll(d));
  await d.wait(500);
  await fetchDetails(d);
  await d.highlight(d.page.locator(".tools-tree").first(), 6);
  await d.wait(look);
  await d.highlight(null);
  await apply(d);
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
  episode: 13,
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
        sl: "Odprimo rodovnik pesnika Franceta Prešerna. Povezave na vire so v njem raztresene po opombah in poljih povezav. Taka povezava ni vir: nima naslova knjige, arhiva ne strani.",
        en: "Let's open the pedigree of the poet France Prešeren. Its source links are scattered over notes and link fields. A link like that is not a source: it has no book title, no archive and no page.",
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
        sl: "V Orodjih, pod »Viri«, vidite hrambe, vire in medije v datoteki. Povezave, ki niso pripete nobenemu viru, so zbrane posebej.",
        en: "In Tools, under Sources, you see the repositories, sources and media in the file. Links not attached to any source are gathered separately.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(d.page.locator(".seg-btn").nth(2));
        await d.wait(800);
        await d.click(d.page.locator(".tools-tab").nth(2));
        await d.page.locator(".tools-tree").first().waitFor();
        await d.wait(800);
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
        sl: "Program prepozna matične knjige na Matriculi in FamilySearchu, grobove na Geneanetu, Find a Grave in BillionGraves, Slovensko biografijo, Obraze slovenskih pokrajin, žrtve vojn na SIstory, dLib, Google Knjige, Wikipedijo in YouTube. Vsaka zbirka ima svoj filter. Obdelujte jih eno za drugo, tako ostane seznam pregleden, tudi ko je povezav na stotine.",
        en: "The program recognises parish registers on Matricula and FamilySearch, graves on Geneanet, Find a Grave and BillionGraves, the Slovenska biografija, Obrazi slovenskih pokrajin, war victims on SIstory, dLib, Google Books, Wikipedia and YouTube. Each collection has its own filter. Work through them one at a time, so the list stays clear even with hundreds of links.",
      },
      run: async (d) => {
        await d.highlight(d.page.locator(".tools-chips").first(), 6);
        await d.wait(4000);
        await d.highlight(d.page.locator(".tools-chips .tools-chip.active").first(), 4);
        await d.snapshot();
      },
    },
    {
      say: {
        sl: "Začnimo z Matriculo. Povezave so razvrščene po knjigi. Vrstica pove, kje v datoteki je povezava zdaj, na primer v opombi pri rojstvu.",
        en: "Let's start with Matricula. The links are grouped by book. Each row tells where the link sits in the file now, for example in a note on the birth.",
      },
      run: async (d) => {
        const breznica = group(d, "00164");
        await d.click(breznica.locator(".tools-pair-toggle"));
        await d.wait(900);
        await d.highlight(breznica, 6);
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
        sl: "Navedba iz krstne knjige pristane pri rojstvu, iz mrliške pri smrti, grob pa pri pokopu. Če dogodka še ni, ga program ustvari. Vsem navedbam lahko nastavite tudi kakovost citata.",
        en: "A citation from a baptism register lands on the birth, one from a death register on the death, and a grave on the burial. If the event is missing, the program creates it. You can also set the citation quality for all of them.",
      },
      run: async (d) => {
        await d.click(group(d, "00164").locator(".tools-pair-toggle"));
        const options = d.page.locator(".tools-reshape-options").first();
        await d.highlight(options.locator(".tools-reshape-site").first(), 4);
        await d.wait(3500);
        const quay = options.locator(".tools-reshape-site").nth(2);
        await d.highlight(quay, 4);
        await d.click(quay.locator(".select-menu"));
        await d.wait(900);
        await d.click(d.page.locator(".dd-item", { hasText: d.t({ sl: "primarni vir", en: "primary evidence" }) }).first());
        await d.wait(800);
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
        sl: "Nato naslednja zbirka, grobovi. Grob na Geneanetu pristane pri pokopu. Ernestina pokopa še nima, zato ga program ustvari. Enako obdelate Find a Grave.",
        en: "Then the next collection, graves. A grave on Geneanet lands on the burial. Ernestina has no burial yet, so the program creates it. Find a Grave is done the same way.",
      },
      run: async (d) => {
        await d.highlight(null);
        await convertSite(d, "Geneanet", 2500);
        await convertSite(d, "Find a Grave", 1500);
      },
    },
    {
      callout: { sl: "Druge zbirke", en: "Other collections" },
      say: {
        sl: "Enako, zbirko za zbirko, obdelate še ostale. Pri Google Knjigah in dLib program prebere naslov dela, pri dLib tudi leto izida.",
        en: "In the same way, collection by collection, you work through the rest. On Google Books and dLib the program reads the work's title, and on dLib the year of publication too.",
      },
      run: async (d) => {
        // Google Books first: converting dLib's "Poezije" (1847) first moves the
        // Google Books "Poezije" (1958) link into Other links.
        await convertSite(d, "Google", 1200);
        await convertSite(d, "dLib", 1500);
      },
    },
    {
      say: {
        sl: "Pri Slovenski biografiji in Obrazih slovenskih pokrajin prebere ime osebe, pri Wikipediji naslov članka.",
        en: "In the Slovenska biografija and Obrazi slovenskih pokrajin it reads the person's name, on Wikipedia the article's title.",
      },
      run: async (d) => {
        await convertSite(d, "biografija", 1000);
        await convertSite(d, "Obrazi", 1000);
        await convertSite(d, "Wiki", 1000);
      },
    },
    {
      say: {
        sl: "Pri YouTubu pa naslov videa in avtorja. Tako je za vsak vir zapisano, kaj točno je in kdo ga je objavil.",
        en: "And on YouTube, the video's title and its author. So every source says exactly what it is and who published it.",
      },
      run: async (d) => {
        await convertSite(d, "YouTube", 1500);
      },
    },
    {
      callout: { sl: "Mrtve povezave", en: "Dead links" },
      say: {
        sl: "Povezave, ki jih program ne pozna, so med »Drugimi povezavami«. Ta vodi na staro stran žrtev vojn na SIstory, ki je ni več. Označite jo za odstranitev: izgine z vseh mest v datoteki, besedilo opombe ostane, vir pa ne nastane.",
        en: "Links the program does not know are under Other links. This one leads to an old page of war victims on SIstory that no longer exists. Mark it for removal: it disappears from every place in the file, the note's text stays, and no source is created.",
      },
      run: async (d) => {
        await d.click(chip(d, "Druge povezave", "Other links"));
        await d.wait(900);
        const dead = group(d, "SIstory");
        await d.highlight(dead, 4);
        await d.wait(2500);
        await d.click(dead.locator("button.tools-issue-link", { hasText: "🗑" }));
        await d.wait(600);
        await d.highlight(dead.locator(".tools-reshape-badge.remove"), 6);
        await d.wait(1500);
        await d.click(selectAll(d));
        await d.wait(600);
        await apply(d);
      },
    },
    {
      callout: { sl: "Dvojniki", en: "Duplicates" },
      say: {
        sl: "Na zavihku »Dvojniki« so zapisi, ki opisujejo isto stvar pod različnima oznakama. Tu je Nadškofijski arhiv Ljubljana zapisan večkrat, enkrat celo brez poštnega naslova. Zapisi, ki povedo manj, se pridružijo popolnejšemu.",
        en: "The Duplicates tab lists records that describe the same thing under different ids. Here the Archdiocesan Archive of Ljubljana is written several times, once even without its address. The records that say less join the fuller one.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(tab(d, "Dvojniki", "Duplicates"));
        await d.wait(900);
        const nal = group(d, "Nadškofijski arhiv");
        await d.click(nal.locator(".tools-pair-toggle"));
        await d.wait(900);
        await d.highlight(nal, 6);
      },
    },
    {
      say: {
        sl: "Program obdrži zapis z več sklici, prenese vanj, kar povedo samo drugi, in vse navedbe preusmeri nanj.",
        en: "The program keeps the record with more references, copies into it what only the others say, and points every citation at it.",
      },
      run: async (d) => {
        const nal = group(d, "Nadškofijski arhiv");
        await d.highlight(nal.locator(".tools-dup-member.survivor").first(), 4);
        await d.wait(2000);
        await d.click(nal.locator(".tools-dup-check").first());
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
        const kranj = d.page.locator(".tools-tree > .tools-tree-node").first();
        await d.click(kranj.locator(".tools-pair-toggle"));
        await d.wait(900);
        await d.highlight(kranj, 6);
        await d.wait(1500);
        await d.highlight(null);
        await d.click(selectAll(d));
        await d.wait(600);
        await apply(d);
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
