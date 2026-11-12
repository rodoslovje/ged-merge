/**
 * Video 9 (SCENARIJI.md, "Statistika"): the Statistics tool, the first tool
 * that works on the whole file — what a family tree tells in numbers, and how
 * every number leads to its people.
 *
 * Data: `rodbina-renko.ged`, an anonymised excerpt of the author's tree (1726
 * people: ancestors with their brothers and sisters, births 1605–2010): the author and his parents under their real
 * names, every other living relative under a made-up name, sex and birth date
 * (see videos/README.md). The deceased keep their sources, scans and occupations.
 *
 * The story the numbers tell, all read off the app on this file:
 *  - marriages peak in February (the carnival before Lent) and November (after
 *    the harvest); hardly any in March (Lent) or December (Advent);
 *  - more than one child in three died before the age of five in the 18th
 *    century, one in seven in the 20th — visible because the ancestors'
 *    brothers and sisters are in the tree (every ancestor grew up);
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

/**
 * Scroll the statistics so their page row sits right under the app's header:
 * the tool buttons above it scroll away and leave the room to the charts.
 */
const toStatsTop = async (d: Director, smooth = true) => {
  await d.page.evaluate((behavior) => {
    const head = document.querySelector<HTMLElement>(".stats-head");
    if (!head) return;
    // The nearest ancestor that scrolls, else the page.
    let box: HTMLElement | null = head.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    const top = document.querySelector(".app-head")?.getBoundingClientRect().bottom ?? 0;
    const by = head.getBoundingClientRect().top - top - 12;
    (box ?? window).scrollBy({ top: by, behavior });
  }, (smooth ? "smooth" : "instant") as ScrollBehavior);
  await d.wait(smooth ? 800 : 100);
};
/** Open a statistics page, its top right under the header. */
const openPage = async (d: Director, i: number) => {
  await toStatsTop(d, false);
  await d.click(statsPage(d, i));
  await d.wait(700);
  await toStatsTop(d, false);
};
/**
 * Scroll something into the middle of the screen and ring it once the smooth
 * scroll has come to rest — a ring drawn mid-scroll lands beside its target.
 */
const ring = async (d: Director, target: Locator, pad = 4) => {
  // The old ring would stay where its target was while the page scrolls away.
  await d.highlight(null);
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
    sl: "Statistika je prvo orodje v Orodjih in zajame celotno datoteko: povzetek, popolnost podatkov, imena po stoletjih, življenjska doba in umrljivost otrok, poroke po mesecih, poklici, selitve, rodovi prednikov, ponovljeni predniki, najbližje slepe ulice in dogodki z viri. Za vsakim številom so osebe — klik odpre njihov seznam. Podatki: anonimiziran izsek iz avtorjevega rodovnika.",
    en: "Statistics is the first of the Tools and covers the whole file: the summary, data completeness, names by century, lifespan and child mortality, marriages by month, occupations, migration, ancestors by generation, pedigree collapse, the nearest brick walls and sourced events. Behind every number are people — a click lists them. Data: an anonymised excerpt of the author's family tree.",
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
        sl: "Tokrat odpremo večje drevo: anonimiziran izsek iz avtorjevega rodovnika: predniki z vsemi brati in sestrami, več kot tisoč sedemsto oseb. Statistika je prvo orodje v Orodjih in vedno zajame celotno datoteko.",
        en: "This time we open a larger tree: an anonymised excerpt of the author's own family tree: the ancestors with all their brothers and sisters, more than seventeen hundred people. Statistics is the first of the Tools, and it always covers the whole file.",
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
        await d.click(bar(d, "topSurnames", /^Simonič/));
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
        sl: "Kartica »Popolnost podatkov« pove, kolikšen del oseb ima datum in kraj rojstva, starše in vire. Datum smrti je znan le pri dveh petinah umrlih. Klik na vrstico pokaže, komu podatek manjka — to je vaš seznam opravil.",
        en: "The Completeness card shows what share of people have a birth date and place, parents and sources. Only two in five of the deceased have a known date of death. A click on the row lists who is missing it — that is your to-do list.",
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
        await toStatsTop(d);
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
        sl: "Stran »Imena« pokaže najpogostejša imena po stoletjih. V osemnajstem stoletju vodi Matija, v devetnajstem Janez, v dvajsetem pa ju prehitita Anton in Franc. Pri ženskah je Marija na vrhu od osemnajstega stoletja naprej.",
        en: "The Names page shows the most common names by century. Matija leads in the eighteenth century and Janez in the nineteenth; in the twentieth, Anton and Franc overtake them both. Among women, Marija leads from the eighteenth century on.",
      },
      run: async (d) => {
        // Back to the whole file, filters folded — at once, not worth watching.
        await d.page.locator(".stats-scope .tools-chip").first().click();
        await d.page.locator(".stats-head-end .tools-chip").first().click();
        await openPage(d, 1);
        await showCard(d, "byCentury");
      },
    },
    {
      say: {
        sl: "Skoraj dvajset odstotkov deklic je dobilo ime po babici, dečki pa so ime po dedu in po očetu dobili približno enako pogosto.",
        en: "Almost one daughter in five was named after her grandmother; sons were named after their grandfather about as often as after their father.",
      },
      run: async (d) => {
        await showCard(d, "namesakes");
      },
    },
    {
      callout: { sl: "Življenjska doba", en: "Lifespan" },
      say: {
        sl: "Življenjska doba pokaže starost ob smrti. Graf ima dva vrhova: veliko otrok je umrlo pred petim letom, kdor pa je otroštvo preživel, je pogosto dočakal šestdeset ali sedemdeset let.",
        en: "Lifespan shows the age at death. The chart has two peaks: many children died before the age of five, but those who survived childhood often lived to sixty or seventy.",
      },
      run: async (d) => {
        await d.highlight(null);
        await openPage(d, 2);
        await showCard(d, "ageAtDeath", 3500);
        // The two peaks: early childhood, and sixty to seventy-four.
        const ages = card(d, "ageAtDeath").locator(".stats-col");
        await d.highlight(ages.nth(0), 4);
        await d.wait(2500);
        await d.highlight(ages.nth(14), 4);
      },
    },
    {
      say: {
        sl: "V osemnajstem stoletju je pred petim letom umrlo šestintrideset odstotkov otrok, v dvajsetem le še petnajst. To vidimo samo zato, ker so v drevesu tudi bratje in sestre prednikov. Predniki so namreč vsi dočakali odraslost.",
        en: "In the eighteenth century more than one child in three died before the age of five; in the twentieth, one in seven. We only see this because the ancestors' brothers and sisters are in the tree — every ancestor, after all, grew up.",
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
      callout: { sl: "Poklic", en: "Occupation" },
      say: {
        sl: "Stran »Poklic« pokaže, s čim so se ljudje preživljali. Do dvajsetega stoletja so bili skoraj vsi kmetje, zapisani tudi kot polovični in četrtinski zemljaki — po delu kmetije, ki so ga imeli. V dvajsetem stoletju jih zamenjajo delavci in delavke.",
        en: "The Occupation page shows how people made their living. Until the twentieth century almost all were farmers, also recorded as half or quarter landholders — by the share of the farm they held. In the twentieth century, workers take their place.",
      },
      run: async (d) => {
        await d.page.keyboard.press("Escape");
        await d.wait(600);
        if (!(await d.page.locator(".stats-head").isVisible())) await d.click(d.page.locator(".seg-btn").nth(2));
        await d.page.locator(".stats-head").waitFor();
        await openPage(d, 6);
        await showCard(d, "jobsByCentury");
      },
    },
    {
      callout: { sl: "Selitve", en: "Migration" },
      say: {
        sl: "Selitve primerjajo kraj rojstva in kraj smrti. V osemnajstem stoletju je bil kraj smrti povprečno dva kilometra od rojstnega. V devetnajstem se začne izseljevanje, največ v Združene države, in povprečje skoči na več sto kilometrov.",
        en: "Migration compares the place of birth with the place of death. In the eighteenth century, people died on average two kilometres from where they were born. In the nineteenth, emigration begins, mostly to the United States, and the average jumps to several hundred kilometres.",
      },
      run: async (d) => {
        await d.highlight(null);
        await openPage(d, 7);
        await showCard(d, "distanceByCentury", 5000);
        await showCard(d, "countryMoves");
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
        sl: "Predniki po mami segajo precej globlje kot predniki po očetu.",
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
      callout: { sl: "Raziskava", en: "Research" },
      say: {
        sl: "Stran »Raziskava« pokaže, koliko dogodkov ima navedbo vira. Krsti in poroke so dobro podprti z matičnimi knjigami, smrt pa ima vir le pri vsakem petem dogodku. Tam je še dela.",
        en: "The Research page shows how many events cite a source. Baptisms and marriages are well backed by parish registers, but only one death in five has a source. That is where work remains.",
      },
      run: async (d) => {
        await d.highlight(null);
        await openPage(d, 9);
        await d.highlight(d.page.locator(".stats-tiles").first(), 4);
        await d.wait(2500);
        await showCard(d, "sourcedByTag", 2500);
        await d.highlight(bar(d, "sourcedByTag", /^(Smrt|Death)/), 4);
      },
    },
    {
      callout: { sl: "Izvoz", en: "Export" },
      say: {
        sl: "Ikona »i« pojasni, kako je število izračunano. Vsako kartico izvozite kot tabelo CSV za lastne izračune ali kot sliko.",
        en: "The i icon explains how a number is worked out. Export any card as a CSV table for your own calculations, or as a picture.",
      },
      run: async (d) => {
        await d.highlight(null);
        const info = card(d, "sourcedByTag").locator(".stats-card-tools > button.stats-info").last();
        await d.point(info);
        await info.hover();
        await d.wait(2800);
        await d.click(card(d, "sourcedByTag").locator(".export-menu button").first());
        await d.wait(600);
        await d.highlight(card(d, "sourcedByTag").locator(".export-menu-popover"), 4);
        await d.wait(2200);
        await d.highlight(null);
        await d.page.keyboard.press("Escape");
      },
    },
    {
      say: {
        sl: "Gumb »Izvoz« zgoraj izvozi celo stran statistike kot eno sliko, z naslovom in izborom oseb. Tako jo lahko natisnete ali pokažete sorodnikom.",
        en: "The Export button at the top exports the whole statistics page as one picture, with its title and the people it covers — ready to print or to show your relatives.",
      },
      run: async (d) => {
        await toStatsTop(d);
        const btn = d.page.locator(".stats-head .export-menu button").first();
        await d.highlight(btn, 6);
        await d.wait(1200);
        await d.click(btn);
        await d.wait(600);
        await d.highlight(d.page.locator(".stats-head .export-menu-popover"), 4);
        await d.wait(3000);
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
