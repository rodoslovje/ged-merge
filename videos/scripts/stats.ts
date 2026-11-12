/**
 * Video 9 (SCENARIJI.md, "Statistika"): the Statistics tool, the first tool
 * that works on the whole file — what a family tree tells in numbers, and how
 * every number leads to its people.
 *
 * Data: `rodbina-renko.ged`, an anonymised excerpt of the author's tree (588
 * people, births 1605–2012): the author and his parents under their real
 * names, every other living relative under a made-up name, sex and birth date
 * (see videos/README.md). The excerpt carries no sources and no occupations,
 * so the Occupation and Research pages are left out.
 *
 * The story the numbers tell, all read off the app on this file:
 *  - marriages peak in February (the carnival before Lent) and November (after
 *    the harvest); hardly any in March (Lent) or December (Advent);
 *  - no child under five died in the 17th–19th centuries — there the tree holds
 *    almost only ancestors, and every ancestor grew up; in the 20th century,
 *    with brothers and sisters in the tree, it is 15 %;
 *  - the one first-cousin marriage, Jožef Simonič ⚭ Marija Simonič, both
 *    grandchildren of Matija Simonič and Marija Plut, is why that couple (and
 *    Matija's parents) stand twice in the author's pedigree: the repeated
 *    ancestors on the Generations page.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator } from "@playwright/test";
import type { Director } from "../lib/director.ts";
import { seriesSettingsWithMaps } from "../lib/series.ts";
import type { Lang, Scenario } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "rodbina-renko.ged");
/** The author's own record, the start person whose line the Generations page follows. */
const AUTHOR = "@I1@";

/** The series display, with the author as this file's start person. */
function settings(lang: Lang): Record<string, unknown> {
  const s = seriesSettingsWithMaps(lang);
  return { ...s, startPersons: { ...(s.startPersons as Record<string, string>), "rodbina-renko": AUTHOR } };
}

/** Statistics pages: 0 Povzetek, 1 Imena, 2 Življenjska doba, 3 Družine, 4 Rojstvo, 5 Smrt, 6 Poklic, 7 Selitve, 8 Rodovi, 9 Raziskava. */
const statsPage = (d: Director, i: number) => d.page.locator(".stats-head > .tree-mode button").nth(i);
/** Whose numbers: 0 Vsi, 1 Krvni sorodniki, 2 Predniki, 3 Potomci. */
const who = (d: Director, i: number) => d.page.locator(".stats-line .tree-mode button").nth(i);
const card = (d: Director, id: string) => d.page.locator(`[data-stats-card="${id}"]`);
/** A bar of a card's list by its label (start of the text). */
const bar = (d: Director, id: string, label: RegExp) => card(d, id).locator(".stats-bar").filter({ hasText: label }).first();
/** A tile of the page's row of figures by its label. */
const tile = (d: Director, label: RegExp) => d.page.locator(".stats-tile").filter({ has: d.page.locator(".stats-tile-label", { hasText: label }) }).first();
const pickList = (d: Director) => d.page.locator(".stats-pick").first();

/** Open a statistics page and bring its top into view. */
const openPage = async (d: Director, i: number) => {
  await d.click(statsPage(d, i));
  await d.wait(900);
  await d.scrollTo(d.page.locator(".stats-head"));
};
/**
 * Scroll something into the middle of the screen and ring it once the smooth
 * scroll has come to rest — a ring drawn mid-scroll lands beside its target.
 */
const ring = async (d: Director, target: Locator, pad = 4) => {
  await target.evaluate((e) => e.scrollIntoView({ behavior: "smooth", block: "center" }));
  // At rest: the same box three readings running (a smooth scroll may start
  // a beat after it is asked for, so one repeat is not enough).
  let last = "";
  let same = 0;
  for (let i = 0; i < 40 && same < 3; i++) {
    await d.wait(150);
    const box = JSON.stringify(await target.boundingBox());
    same = box === last ? same + 1 : 0;
    last = box;
  }
  await d.highlight(target, pad);
};
/** Ring a card, then hold it for a moment. */
const showCard = async (d: Director, id: string, hold = 0) => {
  await ring(d, card(d, id));
  if (hold) await d.wait(hold);
};

const scenario: Scenario = {
  id: "stats",
  episode: 9,
  settings,
  title: {
    sl: "GED Merge: statistika — kaj vam drevo pove v številkah",
    en: "GED Merge: statistics — what your family tree tells in numbers",
  },
  description: {
    sl: "Statistika je prvo orodje v Orodjih in zajame celotno datoteko: povzetek, popolnost podatkov, imena po stoletjih, življenjska doba, poroke po mesecih, selitve, rodovi prednikov, ponovljeni predniki in najbližje slepe ulice. Za vsakim številom so osebe — klik odpre njihov seznam. Podatki: anonimiziran izsek iz avtorjevega rodovnika.",
    en: "Statistics is the first of the Tools and covers the whole file: the summary, data completeness, names by century, lifespan, marriages by month, migration, ancestors by generation, repeated ancestors and the nearest brick walls. Behind every number are people — a click lists them. Data: an anonymised excerpt of the author's family tree.",
  },
  thumbnail: {
    tag: { sl: "Statistika", en: "Statistics" },
    title: { sl: "Kaj vam *drevo* pove v številkah", en: "What your *tree* tells in numbers" },
  },
  steps: [
    {
      say: {
        sl: "Koliko prednikov ste že našli? Kje se vaša raziskava ustavi? In kaj številke povedo o življenju vaših prednikov? Statistika odgovori v nekaj sekundah.",
        en: "How many ancestors have you found so far? Where does your research stop? And what do the numbers say about your ancestors' lives? Statistics answers in a few seconds.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Statistika", en: "Statistics" },
          { sl: "Kaj vam drevo pove v številkah", en: "What your family tree tells in numbers" },
        );
      },
    },
    {
      say: {
        sl: "Tokrat odpremo večje drevo: anonimiziran izsek iz avtorjevega rodovnika s skoraj šeststo osebami. Statistika je prvo orodje v Orodjih in vedno zajame celotno datoteko.",
        en: "This time we open a larger tree: an anonymised excerpt of the author's own family tree, with almost six hundred people. Statistics is the first of the Tools, and it always covers the whole file.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(700);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(1500);
        await d.click(d.page.locator(".seg-btn").nth(2));
        await d.click(d.page.locator(".tools-tab").first());
        await d.page.locator(".stats-tiles").first().waitFor();
      },
    },
    {
      callout: { sl: "Povzetek", en: "Summary" },
      say: {
        sl: "Povzetek na eni strani pove, koliko je v drevesu oseb, družin in priimkov, katera leta zajema in kdo je dočakal najvišjo starost. Spodaj so najpogostejši priimki, imena in kraji rojstva.",
        en: "The summary tells on one page how many people, families and surnames the tree holds, which years it spans, and who lived the longest. Below are the most common surnames, given names and birthplaces.",
      },
      run: async (d) => {
        await d.highlight(d.page.locator(".stats-tiles").first(), 4);
        await d.wait(3000);
        await ring(d, tile(d, /^(Letnice rojstev|Birth years)/), 6);
        await d.wait(2200);
        await ring(d, tile(d, /^(Najvišja starost, ženske|Highest age, women)/), 6);
        await d.wait(2200);
        await d.highlight(null);
        await d.scrollTo(card(d, "topSurnames"));
      },
    },
    {
      say: {
        sl: "Za vsakim številom so osebe. Kliknite priimek in odpre se seznam vseh, ki ga nosijo. Klik na ime odpre osebo v Urejanju.",
        en: "Behind every number are people. Click a surname and a list of everyone who bears it opens. A click on a name opens that person in Edit.",
      },
      run: async (d) => {
        await d.click(bar(d, "topSurnames", /^Jekovec/));
        await d.wait(800);
        await ring(d, pickList(d));
        await d.wait(1800);
        const first = pickList(d).locator(".person-ref").first();
        await d.click(first);
        await d.page.locator(".edit-person").first().waitFor();
        await d.highlight(null);
        await d.wait(2200);
        await d.click(d.page.locator(".seg-btn").nth(2));
        await d.page.locator(".stats-tiles").first().waitFor();
      },
    },
    {
      callout: { sl: "Popolnost podatkov", en: "Completeness" },
      say: {
        sl: "Kartica »Popolnost podatkov« pove, kolikšen del oseb ima datum in kraj rojstva, starše in vire. Datum smrti ima le slaba polovica umrlih. Klik na vrstico pokaže, komu podatek manjka — to je vaš seznam opravil.",
        en: "The Completeness card shows what share of people have a birth date and place, parents and sources. Only a little under half of the deceased have a date of death. A click on the row lists who is missing it — that is your to-do list.",
      },
      run: async (d) => {
        await showCard(d, "complete", 3500);
        await d.highlight(bar(d, "complete", /^(Datum smrti|Death date)/), 4);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(bar(d, "complete", /^(Datum smrti|Death date)/));
        await d.wait(800);
        await ring(d, pickList(d));
        await d.wait(2000);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Izbor oseb", en: "Whose numbers" },
      say: {
        sl: "Zgoraj statistiko omejite na krvne sorodnike, prednike ali potomce izhodiščne osebe. Pod »Filtri« jo zožite še po spolu, letih rojstva, kraju ali državi. Del rodbine izvira s Hrvaške.",
        en: "At the top, narrow the statistics to the start person's blood relatives, ancestors or descendants. Under Filters, narrow them further by sex, birth years, place or country. Part of this family comes from Croatia.",
      },
      run: async (d) => {
        await d.scrollTo(d.page.locator(".stats-head"));
        await d.click(who(d, 2));
        await d.wait(600);
        await d.highlight(d.page.locator(".tools-summary").first(), 6);
        await d.wait(2200);
        await d.highlight(null);
        await d.click(who(d, 0));
        await d.click(d.page.locator(".stats-head-end .tools-chip").first());
        await d.wait(700);
        await d.highlight(d.page.locator(".stats-scope").first(), 4);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(d.page.locator(".stats-scope .tools-chip").filter({ hasText: /Hrvaška|Croatia/ }).first());
        await d.wait(1200);
        await showCard(d, "topBirthPlaces");
        await d.wait(2000);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Imena", en: "Names" },
      say: {
        sl: "Stran »Imena« pokaže najpogostejša imena po stoletjih. Janez in Marija sta na vrhu dve stoletji, v dvajsetem pa Janeza prehitita Anton in Franc.",
        en: "The Names page shows the most common names by century. Janez and Marija lead for two centuries; in the twentieth, Anton and Franc overtake Janez.",
      },
      run: async (d) => {
        // Back to the whole file, filters folded.
        await d.scrollTo(d.page.locator(".stats-head"));
        await d.click(d.page.locator(".stats-scope .tools-chip").first());
        await d.click(d.page.locator(".stats-head-end .tools-chip").first());
        await d.wait(400);
        await openPage(d, 1);
        await showCard(d, "byCentury");
      },
    },
    {
      say: {
        sl: "Skoraj petina hčera je dobila ime po babici, sinovi pa največkrat po očetu.",
        en: "Almost one daughter in five was named after her grandmother; sons were most often named after their father.",
      },
      run: async (d) => {
        await showCard(d, "namesakes");
      },
    },
    {
      callout: { sl: "Življenjska doba", en: "Lifespan" },
      say: {
        sl: "Življenjska doba pokaže starost ob smrti. Povprečje se je od sedemnajstega stoletja dvignilo s sedemintrideset na več kot šestdeset let.",
        en: "Lifespan shows the age at death. Since the seventeenth century, the average has risen from thirty-seven to over sixty years.",
      },
      run: async (d) => {
        await d.highlight(null);
        await openPage(d, 2);
        await showCard(d, "ageAtDeath", 2500);
        await showCard(d, "lifeByCentury");
      },
    },
    {
      say: {
        sl: "Statistika pove tudi, kako je drevo nastalo. Pred dvajsetim stoletjem v njem ni niti enega otroka, ki bi umrl pred petim letom. Tam so namreč skoraj sami predniki — in vsi so dočakali odraslost.",
        en: "Statistics also tells how the tree was built. Before the twentieth century, not a single child in it died before the age of five. That is because those centuries hold almost only ancestors — and every one of them grew up.",
      },
      run: async (d) => {
        await showCard(d, "childDeaths");
      },
    },
    {
      callout: { sl: "Družine", en: "Families" },
      say: {
        sl: "Pri družinah povejo največ poroke po mesecih. Največ porok je bilo februarja, v predpustu, in novembra, ko je bilo delo na polju končano. Marca in decembra, v postu in adventu, se skoraj nihče ni poročil.",
        en: "On the Families page, marriages by month tell the most. Most weddings took place in February, the carnival season before Lent, and in November, once the work in the fields was done. In March and December, during Lent and Advent, hardly anyone married.",
      },
      run: async (d) => {
        await d.highlight(null);
        await openPage(d, 3);
        await showCard(d, "marriageMonth", 3500);
        const months = card(d, "marriageMonth").locator(".stats-col");
        await d.highlight(months.nth(1), 4);
        await d.wait(2500);
        await d.highlight(months.nth(10), 4);
        await d.wait(2500);
        await d.highlight(months.nth(2), 4);
        await d.wait(1500);
        await d.highlight(months.nth(11), 4);
      },
    },
    {
      callout: { sl: "Poroke med sorodniki", en: "Related couples" },
      say: {
        sl: "Program poišče tudi poroke med sorodniki. Jožef in Marija Simonič sta bila bratranec in sestrična. Gumb ob paru odpre diagram sorodstva.",
        en: "The program also finds marriages between relatives. Jožef and Marija Simonič were first cousins. The button beside the couple opens the relationship chart.",
      },
      run: async (d) => {
        await d.highlight(null);
        await showCard(d, "relatedCouples", 1500);
        await d.highlight(null);
        await d.click(bar(d, "relatedCouples", /^(Bratranec|1st cousins)/));
        await d.wait(800);
        await ring(d, pickList(d));
        await d.wait(1500);
        const relate = pickList(d).locator(".stats-relate").first();
        await d.highlight(relate, 8);
        await d.wait(1200);
        await d.highlight(null);
        await d.click(relate);
        await d.page.locator(".charts-kind").waitFor();
      },
    },
    {
      say: {
        sl: "Njun skupni prednik je par Matija Simonič in Marija Plut — dedek in babica obeh.",
        en: "Their common ancestors are the couple Matija Simonič and Marija Plut — grandfather and grandmother to both.",
      },
      run: async (d) => {
        await d.wait(800);
        const matija = d.page.getByText("Matija Simonič", { exact: true }).filter({ visible: true }).last();
        const marija = d.page.getByText("Marija Plut", { exact: true }).filter({ visible: true }).last();
        await d.highlight(matija.locator(".."), 10);
        await d.wait(2200);
        await d.highlight(marija.locator(".."), 10);
        await d.wait(2200);
        await d.highlight(null);
      },
    },
    {
      callout: { sl: "Selitve", en: "Migration" },
      say: {
        sl: "Selitve primerjajo kraj rojstva in kraj smrti. V osemnajstem stoletju je bil kraj smrti povprečno pet kilometrov od rojstnega, v dvajsetem pa skoraj dvesto.",
        en: "Migration compares the place of birth with the place of death. In the eighteenth century, people died on average five kilometres from where they were born; in the twentieth, almost two hundred.",
      },
      run: async (d) => {
        await d.page.keyboard.press("Escape");
        await d.wait(600);
        if (!(await d.page.locator(".stats-head").isVisible())) await d.click(d.page.locator(".seg-btn").nth(2));
        await d.page.locator(".stats-head").waitFor();
        await openPage(d, 7);
        await showCard(d, "distanceByCentury");
      },
    },
    {
      callout: { sl: "Rodovi", en: "Generations" },
      say: {
        sl: "Stran »Rodovi« šteje prednike izhodiščne osebe. V drevesu je tristo devetindevetdeset prednikov v dvanajstih rodovih. Do šestega rodu so znani vsi, nato se vrzeli večajo.",
        en: "The Generations page counts the start person's ancestors. The tree holds three hundred and ninety-nine ancestors in twelve generations. Up to the sixth generation all of them are known; after that, the gaps grow.",
      },
      run: async (d) => {
        await d.highlight(null);
        await openPage(d, 8);
        await d.highlight(d.page.locator(".stats-tiles").first(), 4);
        await d.wait(2500);
        await showCard(d, "ancestorsGen");
        await d.wait(1500);
        await d.snapshot();
      },
    },
    {
      say: {
        sl: "Na materini strani seže drevo precej globlje kot na očetovi.",
        en: "On the mother's side, the tree reaches much further back than on the father's.",
      },
      run: async (d) => {
        await showCard(d, "ancestorsSide");
      },
    },
    {
      callout: { sl: "Ponovljeni predniki", en: "Pedigree collapse" },
      say: {
        sl: "Ker sta se bratranec in sestrična poročila, sta Matija Simonič in Marija Plut v rodovniku dvakrat, prav tako Matijeva starša. Takim prednikom pravimo ponovljeni predniki.",
        en: "Because the cousins married each other, Matija Simonič and Marija Plut stand twice in the pedigree, and so do Matija's parents. Genealogists call this pedigree collapse.",
      },
      run: async (d) => {
        await ring(d, tile(d, /^(Ponovljeni predniki|Pedigree collapse)/), 6);
        await d.wait(2500);
        await showCard(d, "repeatedAncestors");
      },
    },
    {
      callout: { sl: "Slepe ulice", en: "Brick walls" },
      say: {
        sl: "Najbližje slepe ulice so predniki, ki jim staršev še ne poznamo, razvrščeni od najbližjega rodu naprej. Tam je naslednji korak vaše raziskave.",
        en: "The nearest brick walls are the ancestors whose parents are still unknown, ordered from the closest generation outwards. That is where your research goes next.",
      },
      run: async (d) => {
        await showCard(d, "walls");
      },
    },
    {
      callout: { sl: "Izvoz", en: "Export" },
      say: {
        sl: "Ikona »i« pojasni, kako je število izračunano. Vsako stran izvozite kot sliko, vsako kartico pa tudi kot tabelo CSV za lastne izračune.",
        en: "The i icon explains how a number is worked out. Export any page as a picture, and any card also as a CSV table for your own calculations.",
      },
      run: async (d) => {
        await d.highlight(null);
        const info = card(d, "walls").locator(".stats-card-tools > button.stats-info").last();
        await d.point(info);
        await info.hover();
        await d.wait(2800);
        await d.click(card(d, "walls").locator(".export-menu button").first());
        await d.wait(600);
        await d.highlight(card(d, "walls").locator(".export-menu-popover"), 4);
        await d.wait(2200);
        await d.highlight(null);
        await d.page.keyboard.press("Escape");
        await d.scrollTo(d.page.locator(".stats-head"));
        await d.click(d.page.locator(".stats-head .export-menu button").first());
        await d.wait(600);
        await d.highlight(d.page.locator(".stats-head .export-menu-popover"), 4);
        await d.wait(1800);
        await d.highlight(null);
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
