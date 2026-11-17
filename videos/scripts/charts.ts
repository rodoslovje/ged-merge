/**
 * Video 5 (SCENARIJI.md, "Diagrami"): the chart kinds — tree, fan, timeline,
 * contemporaries, report — and the relationship chart on a path that is not a
 * straight line: France Prešeren's parents Šimen Prešeren and Mina Svetina were
 * distant blood relatives, both great-great-grandchildren of Jakob Prešeren
 * (Šimen through Blaž, Jožef and Jernej; Mina through Marija Prešeren, married
 * Muhovec, Simon Muhovec and Jera Muhovec) — all in Peter Hawlina's pedigree.
 * The map is only mentioned: it needs geocoded places, a video of its own.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import { seriesSettings } from "../lib/series.ts";
import type { Scenario } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "preseren-hawlina.ged");

/** Chart kind tabs: 0 Drevo, 1 Pahljača, 2 Časovnica, 3 Sorodstvo, 4 Sodobniki, 5 Zemljevid, 6 Poročilo. */
const kind = (d: Director, i: number) => d.page.locator(".charts-kind button").nth(i);
/** A chart toolbar button by the start of its label (the direction buttons end in a count). */
const tool = (d: Director, re: RegExp) => d.page.locator("button").filter({ hasText: re }).filter({ visible: true }).first();
const blur = (d: Director) => d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const fit = async (d: Director) => {
  await blur(d);
  await d.page.keyboard.press("f");
  await d.wait(900);
};
/** The »Diagram« settings panel and one of its buttons (the nth with that exact label). */
const openChartSettings = async (d: Director) => {
  await d.click(d.page.locator(".chart-settings-btn").filter({ visible: true }).first());
  await d.wait(700);
};
const setting = (d: Director, label: string, nth = 0) =>
  d.page.locator("[class*=chart-settings-] button").filter({ hasText: new RegExp(`^${label}$`) }).filter({ visible: true }).nth(nth);
/** Ring a settings button and click it. */
const flip = async (d: Director, label: string, nth = 0) => {
  const b = setting(d, label, nth);
  await d.highlight(b, 4);
  await d.click(b);
  await d.wait(1100);
};
/** Open »Izvoz« and ring its menu for a moment. */
const showExport = async (d: Director, ring: string) => {
  await d.click(d.page.locator("button", { hasText: d.t({ sl: "Izvoz", en: "Export" }) }).filter({ visible: true }).first());
  await d.wait(800);
  const item = d.page.locator("[role=menuitem], .dd-item").filter({ visible: true }).filter({ hasText: ring }).first();
  await d.highlight(item.locator(".."), 4);
  await d.point(item);
  await d.wait(3000);
  await d.highlight(null);
  await d.page.keyboard.press("Escape");
};

const scenario: Scenario = {
  id: "charts",
  episode: 5,
  settings: seriesSettings,
  title: {
    sl: "GED Merge: diagrami — drevo, pahljača, časovnica, sodobniki, sorodstvo",
    en: "GED Merge: charts — tree, fan, timeline, contemporaries, relationship",
  },
  description: {
    sl: "Katere diagrame nariše GED Merge in kdaj kateri pride prav: drevo prednikov in potomcev, pahljača, časovnica, sodobniki, poročilo in diagram sorodstva. Primer: Prešernova starša Šimen Prešeren in Mina Svetina sta bila daljna krvna sorodnika — oba izhajata iz Jakoba Prešerna. Podatki: rodovnik Petra Hawline.",
    en: "Which charts GED Merge draws and when each one helps: the ancestor and descendant tree, fan, timeline, contemporaries, report and the relationship chart. Example: Prešeren's parents Šimen Prešeren and Mina Svetina were distant blood relatives — both descend from Jakob Prešeren. Data: Peter Hawlina's pedigree.",
  },
  thumbnail: {
    tag: { sl: "Diagrami", en: "Charts" },
    title: { sl: "Kdo je bil s kom v *sorodu*?", en: "Who was *related* to whom?" },
  },
  steps: [
    {
      say: {
        sl: "Diagram pove več kot seznam. Oglejmo si, katere diagrame nariše GED Merge in kdaj kateri pride prav.",
        en: "A chart says more than a list. Let's look at the charts GED Merge draws, and when each one helps.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Diagrami", en: "Charts" },
          { sl: "Drevo, pahljača, časovnica, sodobniki, sorodstvo", en: "Tree, fan, timeline, contemporaries, relationship" },
        );
      },
    },
    {
      say: {
        sl: "Odprimo rodovnik pesnika Franceta Prešerna. Diagrame odprete z gumbom zgoraj ali s tipko V.",
        en: "Let's open the pedigree of the poet France Prešeren. You open the charts with the button at the top, or the V key.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(700);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(800);
        await d.click(d.page.locator(".charts-open-btn"));
        await d.page.locator(".charts-kind").waitFor();
      },
    },
    {
      callout: { sl: "Drevo", en: "Tree" },
      say: {
        sl: "Diagram v obliki drevesa pokaže prednike in potomce izbrane osebe. Izberete lahko samo prednike, samo potomce ali oboje. Mreža je bolj strnjen prikaz drevesa: zasede manj prostora in je primernejša za tisk velikih diagramov.",
        en: "The tree shows the chosen person's ancestors and descendants. Choose ancestors only, descendants only, or both. The grid is a more compact view of the tree: it takes less room and suits printing large charts better.",
      },
      run: async (d) => {
        await d.click(kind(d, 0));
        await d.click(tool(d, /^(Predniki|Ancestors)\d/));
        await fit(d);
        await d.wait(2200);
        await d.click(tool(d, /^(Oboje|Both)\d/));
        await fit(d);
        await d.wait(2000);
        await d.click(tool(d, /^(Mreža|Grid)$/));
        await fit(d);
        await d.wait(5500);
        // The second visible "Drevo" is the tree/grid switch (the first is the chart kind tab).
        await d.click(d.page.locator("button").filter({ hasText: /^(Drevo|Tree)$/ }).filter({ visible: true }).nth(1));
        await fit(d);
      },
    },
    {
      say: {
        sl: "Z gumbom »Diagram« izberete, kaj se izpiše ob osebi. Tu vklopite ali izklopite tudi sorodstvo do izhodiščne osebe.",
        en: "The Chart button chooses what is written by each person. This is also where you switch the kinship to the start person on or off.",
      },
      run: async (d) => {
        await openChartSettings(d);
        const kin = d.t({ sl: "Sorodstvo", en: "Kinship" });
        await flip(d, kin);
        await d.wait(800);
        await flip(d, kin);
        await d.highlight(null);
        await d.page.keyboard.press("Escape");
      },
    },
    {
      say: {
        sl: "Drevo izvozite kot sliko SVG, kot PDF za tisk ali kot datoteko GEDCOM samo z narisanimi osebami, na primer za sorodnika, ki ga zanima ena veja.",
        en: "Export the tree as an SVG image, as a PDF to print, or as a GEDCOM file with only the people drawn — say, for a relative interested in one branch.",
      },
      run: async (d) => {
        await showExport(d, "GEDCOM");
      },
    },
    {
      callout: { sl: "Pahljača", en: "Fan chart" },
      say: {
        sl: "Pahljača razvrsti prednike v krog, rod za rodom.",
        en: "The fan chart arranges the ancestors in a circle, generation by generation.",
      },
      run: async (d) => {
        await d.click(kind(d, 1));
        await d.click(tool(d, /^(Predniki|Ancestors)\d/));
        await fit(d);
        // Fitted, the fan's labels are small; one zoom step makes them readable
        // and still keeps the whole fan on screen.
        await d.page.keyboard.press("+");
        await d.wait(800);
      },
    },
    {
      say: {
        sl: "Jakob Prešeren je Prešernov prednik po očetovi in po materini strani, zato se v pahljači pojavi dvakrat. Pri drugi pojavitvi je puščica. Klik nanjo pokaže, kje je oseba že izrisana.",
        en: "Jakob Prešeren is Prešeren's ancestor on both his father's and his mother's side, so he appears twice in the fan. The second time he carries an arrow; a click on it shows where he is already drawn.",
      },
      run: async (d) => {
        // Jakob's repeated sector, marked by the → badge.
        const repeat = d.page.locator(".fan-node").filter({ has: d.page.locator(".tree-node-repeat-badge") }).filter({ hasText: "Jakob" }).first();
        await d.highlight(repeat, 6);
        await d.wait(5200);
        const badge = repeat.locator(".tree-node-repeat-badge").first();
        await d.highlight(badge, 10);
        await d.point(badge);
        await d.wait(1600);
        await d.click(badge);
        await d.wait(600);
        await d.highlight(d.page.locator(".fan-node.selected").first(), 6);
        await d.wait(2500);
        await d.highlight(null);
        // Close the person card the jump may have opened.
        const close = d.page.locator(".tree-compare-close").filter({ visible: true });
        if (await close.count()) await close.first().click();
      },
    },
    {
      say: {
        sl: "V nastavitvah diagrama vklopimo še kraje in podatke o poroki. Barva lahko pove družinsko vejo, kraj rojstva, stoletje ali celo, kako dobro so osebe podprte z viri.",
        en: "In the chart settings we also switch on places and the marriage details. Colour can show the family line, the birthplace, the century, or even how well each person is backed by sources.",
      },
      run: async (d) => {
        await openChartSettings(d);
        const place = d.t({ sl: "Kraj", en: "Place" });
        await flip(d, place, 0); // the person's places
        await flip(d, d.t({ sl: "Datum", en: "Date" })); // marriage date
        await flip(d, place, 1); // marriage place
        await flip(d, d.t({ sl: "Družinska veja", en: "Family line" }));
        await d.wait(1200);
        await flip(d, d.t({ sl: "Kraj rojstva", en: "Birth place" }));
        await d.wait(800);
        await d.highlight(null);
        await d.page.keyboard.press("Escape");
        await fit(d);
      },
    },
    {
      callout: { sl: "Časovnica", en: "Timeline" },
      say: {
        sl: "Časovnica postavi življenja na skupno os let. Takoj vidite, kdo je živel hkrati in kdo je koga preživel.",
        en: "The timeline sets lives on a shared axis of years. You see at once who lived at the same time, and who outlived whom.",
      },
      run: async (d) => {
        await d.click(kind(d, 2));
        await fit(d);
      },
    },
    {
      callout: { sl: "Sodobniki", en: "Contemporaries" },
      say: {
        sl: "Sodobniki pokažejo krvne sorodnike, razvrščene po oddaljenosti. Z drsnikom izberete leto in vidite, kdo je bil takrat živ.",
        en: "Contemporaries shows blood relatives by how closely related they are. Use the slider to pick a year and see who was alive then.",
      },
      run: async (d) => {
        await d.click(kind(d, 4));
        await fit(d);
        await d.wait(1500);
        await d.highlight(d.page.locator("input[type=range]").filter({ visible: true }).first().locator(".."), 6);
        await d.wait(2500);
        await d.highlight(null);
        await d.click(tool(d, /^(Trakovi|Bars)$/));
        await fit(d);
      },
    },
    {
      callout: { sl: "Poročilo", en: "Report" },
      say: {
        sl: "Poročilo zapiše prednike ali potomce kot besedilo: kot pregleden seznam ali kot pripoved.",
        en: "The report writes the ancestors or descendants out as text: as a tidy list, or as a narrative.",
      },
      run: async (d) => {
        await d.click(kind(d, 6));
        await d.wait(2000);
        await d.click(tool(d, /^(Pripoved|Narrative)$/));
        await d.wait(1200);
        await d.page.mouse.move(700, 500);
        await d.page.mouse.wheel(0, 400);
      },
    },
    {
      say: {
        sl: "Poročilo izvozite kot tekstovno datoteko ali kot dokument RTF. Tako ga pred tiskom uredite še v svojem urejevalniku besedil.",
        en: "Export the report as a text file or an RTF document, so you can edit it further in your own word processor before printing.",
      },
      run: async (d) => {
        await showExport(d, "RTF");
      },
    },
    {
      callout: { sl: "Sorodstvo", en: "Relationship" },
      say: {
        sl: "Diagram sorodstva pokaže pot od izhodiščne osebe do izbrane osebe. Za trenutek naredimo za izhodiščno osebo Prešernovega očeta Šimna.",
        en: "The relationship chart traces the path from the start person to the chosen person. For a moment, let's make Prešeren's father Šimen the start person.",
      },
      run: async (d) => {
        await d.page.keyboard.press("Escape");
        await d.page.locator(".edit-person").first().waitFor();
        await d.wait(600);
        await d.click(d.page.locator(".person-card").filter({ visible: true }).first());
        await d.wait(800);
        await d.click(d.page.locator(".edit-person .person-kinship").first());
        await d.wait(900);
        await d.click(d.page.getByText(d.t({ sl: "Nastavi to osebo kot izhodiščno", en: "Make this person the start person" })).first());
      },
    },
    {
      say: {
        sl: "Izberimo njegovo ženo Mino Svetina in pritisnimo S. Najkrajša pot med njima je seveda zakon. Pod »Razpoložljive poti« pa program najde še krvno sorodstvo.",
        en: "Now choose his wife Mina Svetina and press S. The shortest path between them is, of course, their marriage. But under Available paths the program also finds a blood relationship.",
      },
      run: async (d) => {
        await d.wait(600);
        await d.click(d.page.locator(".person-card").filter({ hasText: "Svetina" }).filter({ visible: true }).first());
        await d.wait(900);
        await blur(d);
        await d.page.keyboard.press("s");
        const paths = d.page.locator("button.select-menu").filter({ hasText: /korakov|steps/ }).first();
        await paths.waitFor();
        await fit(d);
        await d.wait(1500);
        await d.highlight(paths, 4);
        await d.click(paths);
        await d.wait(1200);
        await d.click(d.page.locator(".dd-item, [role=option]").filter({ visible: true }).last());
        await d.highlight(null);
        await fit(d);
      },
    },
    {
      say: {
        sl: "Šimen in Mina sta bila daljna krvna sorodnika. Njun skupni prednik je Jakob Prešeren, prapraded obeh. Pesnikova starša sta torej izhajala iz iste rodbine.",
        en: "Šimen and Mina were distant blood relatives. Their common ancestor is Jakob Prešeren, great-great-grandfather to both. So the poet's parents came from the same family.",
      },
      run: async (d) => {
        await d.overlay("hideCursor");
        await d.wait(1200);
        await d.snapshot();
        // The chart node — the path picker above also names him.
        const jakob = d.page.getByText("Jakob Prešeren", { exact: true }).filter({ visible: true }).first();
        await d.highlight(jakob.locator(".."), 10);
      },
    },
    {
      callout: { sl: "Zemljevid", en: "Map" },
      say: {
        sl: "Zadnji je zemljevid, ki postavi dogodke na kraje. Za to morajo imeti kraji koordinate. Kako jih dobijo z geokodiranjem, pokažemo v posebnem videu.",
        en: "The last one is the map, which puts events on their places. For that, places need coordinates; how they get them by geocoding is shown in a video of its own.",
      },
      run: async (d) => {
        await d.highlight(null);
        await d.click(kind(d, 5));
        await d.wait(1500);
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
