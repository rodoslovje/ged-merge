/**
 * Video 11 (SCENARIJI.md, "Dvojniki"): find the people a file holds twice and
 * merge them — with the duplicated parent merged first — and turn down a pair
 * that only looks alike. Follows episode 10: the same comparison, now inside
 * one file.
 *
 * Data: `rodbina-renko.ged`, the anonymised excerpt of the author's tree (see
 * videos/README.md), which holds real duplicates — nothing is planted:
 *  - Janez Starašinič, b. 1752 in Krasinec (@77637144@ and @I412665969695@,
 *    score ~100): the same man entered twice under one father, each record
 *    with its own copy of his mother Lucija Klepec (@I412665969547@ and
 *    @I412665967098@, ~96). The compare offers to merge the mother first, so
 *    the two parent families fold into one;
 *  - Pezdirc, Krasinec 2, 1892 (@I412647388790@, @I412647389026@,
 *    @I412647389104@): a group of three that are three brothers — NN, born and
 *    died 10 Jan 1892, and the twins Jožef and Peter, born 8 Dec 1892 (died
 *    1893 and 1896). Below the default threshold of 85; shown by lowering it,
 *    then rejected as a group.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import { seriesSettingsWithMaps } from "../lib/series.ts";
import type { Scenario } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "rodbina-renko.ged");

/** Tools in the tab row: 0 stats, 1 places, 2 sources, 3 validate, 4 duplicates, … */
const DUPLICATES_TAB = 4;
/** A pair row of the list, by a record id it shows. */
const pair = (d: Director, id: string) => d.page.locator(".tools-pair", { hasText: id }).first();
/** A group head (three or more records), by its representative's surname. */
const cluster = (d: Director, text: string) => d.page.locator(".tools-dup-cluster-head", { hasText: text }).first();
const compare = (d: Director) => d.page.locator(".tools-pair-compare").first();
const scoreSelect = (d: Director) => d.page.locator(".tools-filter-row .score-select").first();
const menuItem = (d: Director, text: string) =>
  d.page.locator("[role=menuitem], [role=option], .dd-item").filter({ visible: true }).filter({ hasText: text }).first();

/** Merging, and a fresh scan, open the next pair's comparison; close it to show the list. */
const closeOpenPair = async (d: Director) => {
  const open = d.page.locator(".tools-pair-toggle.open").first();
  // It opens a beat after the list settles, and a chained merge may open it again.
  if (!(await open.waitFor({ timeout: 3000 }).then(() => true, () => false))) return;
  for (let i = 0; i < 4 && (await open.count()); i++) {
    await d.click(open);
    await d.wait(1000);
  }
};

const JANEZ = "I412665969695";
const MUBI = "89900395";
const SIMONIC = "93285824";
const PEZDIRC = "Pezdirc";

const scenario: Scenario = {
  id: "duplicates",
  episode: 11,
  settings: seriesSettingsWithMaps,
  title: {
    sl: "GED Merge: najdite in združite dvojnike v svojem drevesu",
    en: "GED Merge: find and merge duplicate people in your family tree",
  },
  description: {
    sl: "Kako v GED Merge najdete osebe, ki so v drevesu vnesene dvakrat: orodje Dvojniki primerja vsako osebo z vsako drugo, pare primerjate drug ob drugem, jih združite skupaj s podvojenimi starši ali pa zavrnete, če gre za različne osebe. Podatki: anonimiziran izsek iz avtorjevega rodovnika.",
    en: "How to find the people your family tree holds twice in GED Merge: the Duplicates tool compares every person with every other, you compare each pair side by side and merge it, duplicated parents included, or reject it when they are different people. Data: an anonymised excerpt of the author's family tree.",
  },
  thumbnail: {
    tag: { sl: "Dvojniki", en: "Duplicates" },
    title: { sl: "Ena *oseba*, en zapis", en: "One *person*, one record" },
  },
  steps: [
    {
      say: {
        sl: "Ko drevo raste, se ista oseba hitro znajde v njem dvakrat: enkrat kot prednik, drugič kot brat ali sestra iz druge matične knjige. Pokažimo, kako dvojnike najdete in združite.",
        en: "As a tree grows, the same person easily ends up in it twice: once as an ancestor, and again as a brother or sister found in another register. Let's see how to find duplicates and merge them.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Dvojniki", en: "Duplicates" },
          { sl: "Ena oseba, en zapis", en: "One person, one record" },
        );
      },
    },
    {
      callout: { sl: "Orodje Dvojniki", en: "The Duplicates tool" },
      say: {
        sl: "Odprimo spet izsek iz avtorjevega rodovnika z več kot tisoč sedemsto osebami. V Orodjih izberite »Dvojniki«. Orodje primerja vsako osebo z vsako drugo, z istim algoritmom kot Združevanje v prejšnjem videu.",
        en: "Let's open the excerpt of the author's tree again, more than seventeen hundred people. In Tools, choose Duplicates. The tool compares every person with every other, using the same algorithm as merging in the previous video.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(700);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(1200);
        await d.click(d.page.locator(".seg-btn").nth(2));
        await d.wait(600);
        await d.click(d.page.locator(".tools-tab").nth(DUPLICATES_TAB));
        await d.skippable(() => d.page.locator(".tools-pairs").first().waitFor({ timeout: 60_000 }));
      },
    },
    {
      callout: { sl: "Seznam parov", en: "The list of pairs" },
      say: {
        sl: "Možni dvojniki so razvrščeni po stopnji ujemanja, najzanesljivejši so na vrhu. Ker imata oba zapisa navadno isto ime, je ob vsakem izpisana še njegova oznaka.",
        en: "Possible duplicates are sorted by match score, the surest at the top. Since both records usually carry the same name, each shows its record ID as well.",
      },
      run: async (d) => {
        await d.highlight(d.page.locator(".tools-pairs").first(), 4);
        await d.wait(3500);
        await d.highlight(pair(d, JANEZ).locator(".tools-cat").first(), 4);
        await d.wait(2000);
        await d.highlight(pair(d, JANEZ).locator(".person-xref").filter({ hasText: JANEZ }).first(), 4);
      },
    },
    {
      callout: { sl: "Primerjava drug ob drugem", en: "Side by side" },
      say: {
        sl: "Janez Starašinič, rojen leta 1752 v Krasincu, je v drevesu dvakrat. Puščica odpre primerjavo drug ob drugem, enako kot pri združevanju datotek. Levi zapis se ohrani, desni se mu pripoji.",
        en: "Janez Starašinič, born in 1752 in Krasinec, is in the tree twice. The arrow opens the two side by side, just as when merging files. The left record is kept, and the right one is merged into it.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(pair(d, JANEZ).locator(".tools-pair-toggle"));
        await compare(d).waitFor();
        await d.wait(800);
        await d.highlight(compare(d).locator(".compare-head").first(), 4);
        await d.wait(2500);
        await d.highlight(null);
        await d.wait(3000);
        await d.highlight(compare(d).locator(".compare-col-main").first(), 4);
      },
    },
    {
      callout: { sl: "Podvojeni starši", en: "Duplicated parents" },
      say: {
        sl: "Zapisa imata istega očeta, mater Lucijo Klepec pa vsak svojo: tudi ona je v drevesu dvakrat. Program jo ponudi za združitev pred tem parom. Označite jo in obe družini staršev se zlijeta v eno.",
        en: "Both records have the same father, but each has its own copy of the mother, Lucija Klepec: she too is in the tree twice. The program offers to merge her before this pair. Tick her, and the two parent families fold into one.",
      },
      run: async (d) => {
        await d.highlight(null);
        const mother = compare(d).locator("tr", { hasText: "Klepec" }).first();
        await d.scrollTo(mother);
        await d.highlight(mother, 4);
        await d.wait(900);
        await d.snapshot();
        await d.wait(3100);
        const hint = d.page.locator(".tools-related-hint").first();
        await d.scrollTo(hint);
        await d.highlight(hint, 4);
        await d.wait(2500);
        await d.click(hint.locator(".tools-related-pick input[type=checkbox]").first());
      },
    },
    {
      callout: { sl: "Združite", en: "Merge" },
      say: {
        sl: "Kliknite »Združi«. Pred združitvijo program pokaže oba zapisa z njunima oznakama in mater, ki se združi najprej.",
        en: "Click Merge. Before merging, the program names both records with their IDs, and the mother who is merged first.",
      },
      run: async (d) => {
        await d.highlight(null);
        const merge = d.page.locator(".tools-merge-bar .nav-btn.primary").first();
        await d.scrollTo(merge);
        await d.click(merge);
        await d.page.locator(".confirm-dialog").waitFor();
        await d.highlight(d.page.locator(".confirm-dialog-body").first(), 6);
        await d.wait(4000);
        await d.highlight(null);
        await d.click(d.page.locator(".confirm-dialog-confirm"));
      },
    },
    {
      say: {
        sl: "Iz seznama sta izginila oba para, Janez in njegova mati. V drevesu je zdaj en Janez z obema staršema in vsemi brati in sestrami. Ker so se osebe združile, lahko znova zaženemo izračun dvojnikov.",
        en: "Both pairs are gone from the list, Janez and his mother. The tree now holds one Janez, with both parents and all his brothers and sisters. Now that people have been merged, we can run the duplicate search again.",
      },
      run: async (d) => {
        // The merge is done once the list says it is stale; it then opens the next pair.
        await d.page.locator(".tools-fix-item .tools-run").first().waitFor();
        await d.wait(1500);
        await closeOpenPair(d);
        await d.page.evaluate(() => document.querySelector(".tools-view")?.scrollTo({ top: 0, behavior: "smooth" }));
        await d.wait(800);
        await d.highlight(d.page.locator(".tools-pairs").first(), 4);
        await d.wait(3500);
        await d.highlight(null);
        await d.click(d.page.locator(".tools-fix-item .tools-run").first());
        await d.skippable(() => d.page.locator(".tools-pairs").first().waitFor({ timeout: 60_000 }));
        // The fresh list opens its first pair, Luka Mubi, which the next step looks at.
        await d.page.locator(".tools-pair-toggle.open").first().waitFor({ timeout: 3000 }).catch(() => {});
      },
    },
    {
      callout: { sl: "Ko odločitev ni očitna", en: "When it isn't clear" },
      say: {
        sl: "Pri Luki Mubiju odločitev ni očitna. Levi zapis ima ocenjeno rojstvo okoli leta 1665 v Tupaličah, desni pa krst 2. oktobra 1668 v Olševku, z virom in s staršema. Kraja sta blizu, a nista enaka. Takega para ne združujte na slepo: najprej preverite vire, do takrat pa par ostane na seznamu.",
        en: "With Luka Mubi, the answer isn't obvious. The left record has an estimated birth around 1665 in Tupaliče, the right one a baptism on 2 October 1668 in Olševek, with a source and both parents. The villages are close, but not the same. Don't merge a pair like this blindly: check the sources first, and until then the pair stays on the list.",
      },
      run: async (d) => {
        await d.highlight(null);
        if (!(await pair(d, MUBI).locator(".tools-pair-toggle.open").count())) {
          await d.click(pair(d, MUBI).locator(".tools-pair-toggle"));
          await d.wait(1000);
        }
        await compare(d).waitFor();
        await d.highlight(compare(d).locator("tr.field", { hasText: "ABT 1665" }).first(), 4);
        await d.wait(4500);
        await d.highlight(compare(d).locator("tr", { hasText: "Gregor Mubi" }).first(), 4);
        await d.wait(3000);
        await d.highlight(compare(d).locator("tr.field", { hasText: "Olševek" }).first(), 4);
      },
    },
    {
      say: {
        sl: "Podobno je pri Matiji Simoniču. Levi Matija je bil krščen leta 1730, desni ima le ocenjeno rojstvo okoli leta 1735 in je poročen. Na Vinjem Vrhu pa je bil leta 1726 krščen še en Matija. Kateri od njiju se je poročil, povedo šele viri, zato tudi ta par zaenkrat pustimo.",
        en: "Matija Simonič is a similar case. The left Matija was baptised in 1730; the right one has only an estimated birth around 1735, and he married. But another Matija was baptised in Vinji Vrh in 1726. Only the sources can tell which of them married, so we leave this pair for now too.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(pair(d, MUBI).locator(".tools-pair-toggle"));
        await d.wait(600);
        await d.click(pair(d, SIMONIC).locator(".tools-pair-toggle"));
        await compare(d).waitFor();
        await d.wait(1000);
        await d.highlight(compare(d).locator("tr.field", { hasText: "6 NOV 1730" }).first(), 4);
      },
    },
    {
      callout: { sl: "Prag ujemanja", en: "Score threshold" },
      say: {
        sl: "Privzeto so prikazani samo pari s stopnjo ujemanja vsaj 85. Ko prag znižate, se pokažejo tudi šibkejši pari, med njimi skupine s tremi ali več zapisi.",
        en: "By default, only pairs scoring at least 85 are shown. Lower the threshold and weaker pairs appear too, among them groups of three or more records.",
      },
      run: async (d) => {
        // Matija Simonič stays open while he is spoken of; close him now.
        await d.highlight(null);
        await closeOpenPair(d);
        // The menu can miss a click while the list is still settling; try until the group shows.
        for (let i = 0; i < 3 && !(await cluster(d, PEZDIRC).count()); i++) {
          await d.click(scoreSelect(d));
          await menuItem(d, "≥ 75").waitFor();
          await d.wait(500);
          await d.click(menuItem(d, "≥ 75"));
          await d.wait(900);
        }
        await d.scrollTo(cluster(d, PEZDIRC));
        await d.highlight(cluster(d, PEZDIRC), 4);
      },
    },
    {
      callout: { sl: "Različni osebi", en: "Two different people" },
      say: {
        sl: "Tu so trije Pezdirci iz iste hiše v Krasincu, vsi rojeni leta 1892. Odprimo prvi par. Imeni se razlikujeta, rojena sta enajst mesecev narazen, prvi je umrl na dan rojstva, Jožef pa naslednje poletje za jetiko. To nista ena oseba, ampak brata.",
        en: "Here are three Pezdircs from the same house in Krasinec, all born in 1892. Let's open the first pair. The names differ, they were born eleven months apart, and the first died the day he was born, while Jožef died of tuberculosis the following summer. These are not one person but two brothers.",
      },
      run: async (d) => {
        const head = cluster(d, PEZDIRC);
        await d.click(head.locator(".tools-pair-toggle"));
        await d.wait(1200);
        await d.click(d.page.locator(".tools-pair-clustered").nth(0).locator(".tools-pair-toggle"));
        await compare(d).waitFor();
        await d.wait(800);
        await d.highlight(compare(d).locator("tr.field", { hasText: "Jožef" }).first(), 4);
        await d.wait(3500);
        await d.highlight(compare(d).locator("tr.field", { hasText: "8 DEC 1892" }).first(), 4);
        await d.wait(3500);
        await d.highlight(compare(d).locator("tr.field", { hasText: "10 AUG 1893" }).first(), 4);
      },
    },
    {
      callout: { sl: "Zavrnite par", en: "Reject a pair" },
      say: {
        sl: "Tretji, Peter, je rojen istega dne kot Jožef: bila sta dvojčka. Ker v skupini ni dvojnikov, kliknite »Zavrni vse«.",
        en: "The third, Peter, was born the same day as Jožef: they were twins. Since none of them is a duplicate, click Reject all.",
      },
      run: async (d) => {
        await d.highlight(null);
        const head = cluster(d, PEZDIRC);
        await d.click(d.page.locator(".tools-pair-clustered").nth(0).locator(".tools-pair-toggle"));
        await d.wait(800);
        await d.scrollTo(head);
        await d.highlight(d.page.locator(".tools-pair-clustered").nth(1), 4);
        await d.wait(3500);
        await d.highlight(null);
        await d.click(head.locator(".tools-dup-cluster-dismiss"));
      },
    },
    {
      say: {
        sl: "Zavrnjeni pari se ne vrnejo, ko iskanje zaženete znova. Najdete jih pod »Zavrnjeni«, kjer zavrnitev tudi prekličete.",
        en: "Rejected pairs don't come back when you run the search again. You'll find them under Rejected, where you can also take a rejection back.",
      },
      run: async (d) => {
        const toggle = d.page.locator(".tools-dup-toggle").first();
        await d.click(toggle);
        await d.wait(1200);
        await d.highlight(d.page.locator(".tools-pairs").first(), 4);
        await d.wait(3000);
        await d.highlight(null);
        await d.click(toggle);
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
