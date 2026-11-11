/**
 * Video 4 (SCENARIJI.md, "Viri"): sources from a pasted link — Matricula pages
 * on a birth and a death, a Geneanet grave on a burial, and a person-level
 * source from the Slovenska biografija; then opening a source and the GEDCOM
 * lines in the save preview.
 *
 * Every link is real: France Prešeren's baptism (Breznica 00164, p. 86) and
 * death (Kranj 00932, p. 40) and Ana Jelovšek's baptism (Ljubljana – Sv. Jakob
 * 01156, p. 177) are the pages contributor Odar cites in the Slovenian
 * genealogical index; Ernestina Jelovšek's grave in Prešernov gaj, Kranj, is on
 * Geneanet; France's biography is in the Slovenska biografija.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Director } from "../lib/director.ts";
import { seriesSettings } from "../lib/series.ts";
import type { Scenario, Text } from "../lib/types.ts";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "demo", "preseren-hawlina.ged");

const LINKS = {
  franceBirth: "https://data.matricula-online.eu/sl/slovenia/ljubljana/breznica/00164/?pg=86",
  franceDeath: "https://data.matricula-online.eu/sl/slovenia/ljubljana/kranj/00932/?pg=40",
  anaBirth: "https://data.matricula-online.eu/sl/slovenia/ljubljana/ljubljana-sv-jakob/01156/?pg=177",
  ernestinaGrave: "https://en.geneanet.org/cemetery/view/13262440",
  franceBiography: "https://www.slovenska-biografija.si/oseba/sbi463215/",
};

const dialog = (d: Director) => d.page.locator(".add-source-dialog");
const field = (d: Director, label: Text) => dialog(d).locator("label.add-source-field", { hasText: d.t(label) }).first();
const blur = (d: Director) => d.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** The per-event »+ Dodaj« of the i-th event row; it only widens under the mouse. */
async function openEventSource(d: Director, i: number | "last"): Promise<void> {
  const all = d.page.locator(".edit-person .edit-event-addfield");
  const add = i === "last" ? all.last() : all.nth(i);
  await add.hover({ force: true });
  await d.click(add);
  await d.click(d.page.locator(".dd-item", { hasText: d.t({ sl: "Vir", en: "Source" }) }).first());
  await dialog(d).waitFor();
}

/**
 * Paste a link, and wait until the online lookup has answered: the box reads
 * »Pridobivanje podatkov …« while it runs and »Prepoznana povezava« after, when
 * the fetched title has replaced the one read from the link alone.
 */
async function paste(d: Director, url: string): Promise<void> {
  await d.page.keyboard.insertText(url);
  await d.wait(900);
  const fetching = dialog(d).getByText(d.t({ sl: "Pridobivanje podatkov", en: "Fetching details" }));
  await d.skippable(() => fetching.first().waitFor({ state: "detached", timeout: 60_000 }));
  await d.wait(500);
}

async function submit(d: Director): Promise<void> {
  await d.highlight(null);
  await d.click(dialog(d).locator(".add-source-submit"));
  await dialog(d).waitFor({ state: "detached" });
}

const scenario: Scenario = {
  id: "sources",
  episode: 4,
  settings: seriesSettings,
  title: {
    sl: "GED Merge: viri — Matricula, Geneanet in Slovenska biografija",
    en: "GED Merge: sources — Matricula, Geneanet and the Slovenska biografija",
  },
  description: {
    sl: "Kako v GED Merge dogodku ali osebi dodate vir s prilepljeno povezavo: stran matične knjige na Matriculi, grob na Geneanetu ali geslo v Slovenski biografiji. Program povezavo prepozna in sam izpolni naslov, arhiv in stran. Primer: rodovnik pesnika Franceta Prešerna.",
    en: "How to add a source to an event or a person in GED Merge by pasting a link: a parish-register page on Matricula, a grave on Geneanet, or an entry in the Slovenska biografija. The program recognises the link and fills in the title, archive and page. Example: the pedigree of the poet France Prešeren.",
  },
  thumbnail: {
    tag: { sl: "Viri", en: "Sources" },
    title: { sl: "Matricula v *eni* potezi", en: "Matricula in *one* move" },
  },
  steps: [
    {
      say: {
        sl: "Podatek brez vira je samo trditev. Pokažimo, kako v GED Merge dodate vir kar s povezavo: na matično knjigo, na grob ali na življenjepis.",
        en: "A fact without a source is only a claim. Let's see how GED Merge adds a source straight from a link: to a parish register, a grave or a biography.",
      },
      run: async (d) => {
        await d.card(
          { sl: "GED Merge · video navodila", en: "GED Merge · video tutorial" },
          { sl: "Viri", en: "Sources" },
          { sl: "Matricula, Geneanet in Slovenska biografija", en: "Matricula, Geneanet and the Slovenska biografija" },
        );
      },
    },
    {
      say: {
        sl: "Odprimo rodovnik pesnika Franceta Prešerna.",
        en: "Let's open the pedigree of the poet France Prešeren.",
      },
      run: async (d) => {
        await d.card(null, null);
        await d.wait(700);
        await d.upload(d.page.locator(".lb-drop"), MAIN);
        await d.page.locator(".edit-person").first().waitFor();
        await d.overlay("hideCursor");
      },
    },
    {
      callout: { sl: "Spletna iskanja", en: "Online lookups" },
      say: {
        sl: "Da program sam prebere podatke o knjigi, v Nastavitvah na zavihku »Napredno« vklopite »Poišči podatke na spletu«. Poslana je le povezava, nikoli vaše drevo.",
        en: "For the program to read the book's details itself, switch on Look up details online in Settings, on the Advanced tab. Only the link is sent, never your tree.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".nav-btn.icon-only:not(.undo-btn):not(.charts-open-btn):not(.shortcuts-btn)").nth(2));
        const modal = d.page.locator(".settings-modal");
        await d.click(modal.locator("button", { hasText: d.t({ sl: "Napredno", en: "Advanced" }) }).first());
        const row = modal.locator("label", { hasText: d.t({ sl: "Poišči podatke na spletu", en: "Look up details online" }) }).first();
        await d.highlight(row, 4);
        await d.wait(1200);
        await d.click(row.locator("input"));
        await d.wait(1500);
      },
    },
    {
      say: {
        sl: "Na zavihku »GEDCOM« pri »Zapisi« izberite »vir, povezave strani«. Tako bo vsak dogodek dobil neposredno povezavo na svojo stran v knjigi.",
        en: "On the GEDCOM tab, under Records, choose source, page links. That way every event gets a direct link to its own page of the book.",
      },
      run: async (d) => {
        const modal = d.page.locator(".settings-modal");
        await d.click(modal.locator("button", { hasText: "GEDCOM" }).first());
        const row = modal.locator(".settings-format-row").filter({ hasText: new RegExp(`^${d.t({ sl: "Zapisi", en: "Records" })}`) }).first();
        await row.scrollIntoViewIfNeeded();
        await d.highlight(row, 4);
        await d.click(row.locator(".select-menu"));
        await d.wait(1000);
        await d.click(d.page.locator(".dd-item", { hasText: d.t({ sl: "vir, povezave strani", en: "source, page links" }) }).first());
        await d.wait(1500);
        await d.highlight(null);
        await d.page.keyboard.press("Escape");
      },
    },
    {
      callout: { sl: "Vir dogodku", en: "A source on an event" },
      say: {
        sl: "Vir dodate dogodku: pri rojstvu kliknite »Dodaj« in izberite »Vir«. Nato prilepite povezavo na stran matične knjige.",
        en: "You add a source to an event: at the birth, click Add and choose Source. Then paste the link to the parish-register page.",
      },
      run: async (d) => {
        await openEventSource(d, 0);
        await d.wait(800);
        await paste(d, LINKS.franceBirth);
      },
    },
    {
      say: {
        sl: "Program povezavo prepozna in sam izpolni naslov knjige, arhiv in stran. Skenu iz matične knjige da oceno primarnega vira.",
        en: "The program recognises the link and fills in the book's title, the archive and the page. A scan from a parish register is rated as primary evidence.",
      },
      run: async (d) => {
        await d.highlight(dialog(d).locator(".add-source-chip").first().locator(".."), 4);
        await d.wait(2500);
        await d.highlight(field(d, { sl: "Naslov", en: "Title" }), 4);
        await d.wait(2200);
        await d.highlight(field(d, { sl: "Stran", en: "Page" }), 4);
        await d.wait(1800);
        await d.highlight(field(d, { sl: "Kakovost citata", en: "Citation quality" }), 4);
        await d.snapshot();
      },
    },
    {
      say: {
        sl: "Pri »Hramba« izberite še arhiv, ki knjigo hrani: Nadškofijski arhiv Ljubljana. Naslednje knjige iz istega arhiva ga dobijo same.",
        en: "Under Repository, also choose the archive that holds the book: the Archdiocesan Archive of Ljubljana. Later books from the same archive get it on their own.",
      },
      run: async (d) => {
        const repo = field(d, { sl: "Hramba", en: "Repository" });
        await repo.scrollIntoViewIfNeeded();
        await d.highlight(repo, 4);
        await d.click(repo.locator(".select-menu"));
        await d.wait(1200);
        // The proposed new repository, named after the archive the lookup read.
        await d.click(d.page.locator('.dd-item[data-value="@create@"]').first());
        await d.wait(1800);
      },
    },
    {
      say: {
        sl: "Potrdite z gumbom »Dodaj vir«. Enako dodamo vir smrti, iz mrliške knjige župnije Kranj.",
        en: "Confirm with Add Source. In the same way we add a source to the death, from the Kranj death register.",
      },
      run: async (d) => {
        await submit(d);
        await openEventSource(d, 1);
        await paste(d, LINKS.franceDeath);
        await d.wait(800);
        await submit(d);
      },
    },
    {
      say: {
        sl: "Pri Ani Jelovšek dodamo vir rojstvu: krstno knjigo župnije svetega Jakoba v Ljubljani.",
        en: "For Ana Jelovšek we add a source to her birth: the baptism register of St James's parish in Ljubljana.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".person-card").filter({ hasText: "Ana" }).filter({ visible: true }).first());
        await d.wait(800);
        await openEventSource(d, 0);
        await paste(d, LINKS.anaBirth);
        await d.wait(800);
        await submit(d);
      },
    },
    {
      callout: { sl: "Grob na Geneanetu", en: "A grave on Geneanet" },
      say: {
        sl: "Program prepozna tudi druge zbirke: grobove na Geneanetu in povezave na žrtve obeh svetovnih vojn v zbirki SIstory. Prešernova hči Ernestina je pokopana v Prešernovem gaju v Kranju. Dodajmo pokop in povezavo na njen grob.",
        en: "The program recognises other collections too: graves on Geneanet, and links to victims of both world wars in the SIstory collection. Prešeren's daughter Ernestina is buried in Prešernov gaj in Kranj. Let's add her burial and a link to her grave.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".person-card").filter({ hasText: "Ernestina" }).filter({ visible: true }).first());
        await d.wait(800);
        await d.click(d.page.locator(".edit-person .edit-event-add-row .edit-name-chip-add").nth(5));
        await d.page.keyboard.press("Enter");
        await d.page.keyboard.type("Kranj", { delay: 120 });
        await d.wait(900);
        await d.click(d.page.locator(".suggest-item").filter({ hasText: /^Kranj$/ }).first());
        await blur(d);
        await openEventSource(d, "last");
        await d.page.keyboard.insertText(LINKS.ernestinaGrave);
      },
    },
    {
      say: {
        sl: "Najprej program iz same povezave razbere le številko groba. Ko prebere še spletno stran, se dopolnita ime pokopališča in kraj. Podatki se dopolnijo tudi, če vir dodate, preden iskanje konča.",
        en: "At first the program reads only the grave's number from the link itself. Once it has read the web page, the cemetery's name and the place are filled in too. They are filled in even if you add the source before the lookup has finished.",
      },
      run: async (d) => {
        await d.wait(600);
        await d.highlight(field(d, { sl: "Naslov", en: "Title" }), 4);
        const fetching = dialog(d).getByText(d.t({ sl: "Pridobivanje podatkov", en: "Fetching details" }));
        await d.skippable(() => fetching.first().waitFor({ state: "detached", timeout: 60_000 }));
        await d.wait(1200);
        await d.highlight(field(d, { sl: "Kraj", en: "Place" }), 4);
        await d.wait(2500);
        await d.highlight(field(d, { sl: "Naslov", en: "Title" }), 4);
      },
    },
    {
      say: {
        sl: "Hrambo lahko vpišete tudi sami. Z izbiro »Nova hramba« jo poimenujmo »Pokopališča Geneanet«.",
        en: "You can also name a repository yourself. Choose New repository and call it Geneanet Cemeteries.",
      },
      run: async (d) => {
        const repo = field(d, { sl: "Hramba", en: "Repository" });
        await repo.scrollIntoViewIfNeeded();
        await d.highlight(repo, 4);
        await d.click(repo.locator(".select-menu"));
        await d.wait(1000);
        await d.click(d.page.locator('.dd-item[data-value="@new@"]').first());
        await d.wait(500);
        await d.page.keyboard.type(d.t({ sl: "Pokopališča Geneanet", en: "Geneanet Cemeteries" }), { delay: 110 });
        await d.wait(1200);
        await submit(d);
      },
    },
    {
      callout: { sl: "Vir osebi", en: "A source on a person" },
      say: {
        sl: "Vir lahko dodate tudi osebi kot celoti, kadar govori o več dogodkih hkrati. Za Prešerna je to njegovo geslo v Slovenski biografiji.",
        en: "You can also add a source to the person as a whole, when it speaks to many events at once. For Prešeren, that is his entry in the Slovenska biografija.",
      },
      run: async (d) => {
        await blur(d);
        await d.page.keyboard.press("h");
        await d.wait(900);
        await d.click(d.page.locator(".edit-person .edit-name-chip-add", { hasText: d.t({ sl: "Dodaj vir", en: "Add Source" }) }).first());
        await dialog(d).waitFor();
        await paste(d, LINKS.franceBiography);
        await d.highlight(field(d, { sl: "Naslov", en: "Title" }), 4);
        await d.wait(1800);
        await submit(d);
      },
    },
    {
      say: {
        sl: "Vir osebe se pokaže kot ikona pod imenom, viri dogodkov pa ob posameznem dogodku.",
        en: "A person's source shows as an icon below the name; an event's sources show next to that event.",
      },
      run: async (d) => {
        // The person-level citation is the first source icon on the page, in the row below the name.
        const personRef = d.page.locator(".edit-person .source-ref").first();
        await personRef.waitFor();
        await d.highlight(personRef, 8);
        await d.point(personRef);
        await d.wait(2500);
        await d.highlight(d.page.locator(".edit-person .source-ref").nth(1), 8);
      },
    },
    {
      callout: { sl: "Urejanje vira", en: "Editing a source" },
      say: {
        sl: "Vir kadar koli odprete in uredite s klikom na njegovo ikono. Puščica ob povezavi odpre stran v izvirni zbirki.",
        en: "Open and edit a source at any time by clicking its icon. The arrow by the link opens the page in the original collection.",
      },
      run: async (d) => {
        const ref = d.page.locator(".edit-person .source-ref").first();
        await d.highlight(ref, 6);
        await d.wait(1200);
        await d.click(ref);
        await dialog(d).waitFor();
        await d.wait(1200);
        const url = dialog(d).locator(".add-source-url-row").first();
        await url.scrollIntoViewIfNeeded();
        await d.wait(700);
        await d.highlight(url, 4);
        await d.wait(2500);
        await d.highlight(null);
        await d.page.keyboard.press("Escape");
      },
    },
    {
      callout: { sl: "Shranjevanje", en: "Saving" },
      say: {
        sl: "V predogledu shranjevanja vidite, kako se viri zapišejo v datoteko GEDCOM: knjiga kot vir, stran kot navedba.",
        en: "The save preview shows how the sources are written into the GEDCOM file: the book as a source, the page as a citation.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".app-head-actions .export-btn"));
        await d.wait(1500);
        await d.click(d.page.getByText(d.t({ sl: "Vrstice GEDCOM", en: "GEDCOM lines" }), { exact: true }).first());
        await d.wait(6000);
        await d.page.keyboard.press("Escape");
      },
    },
    {
      callout: { sl: "Orodja → Viri", en: "Tools → Sources" },
      say: {
        sl: "V Orodjih, pod »Viri«, vidite, kako so se viri uredili: hrambe, na primer Nadškofijski arhiv Ljubljana, v njih knjige, pod vsako knjigo pa povezave na posamezne strani. Biografija ostane brez hrambe.",
        en: "In Tools, under Sources, you see how the sources have been organised: repositories, such as the Archdiocesan Archive of Ljubljana, the books they hold, and under each book the links to the individual pages. The biography stays without a repository.",
      },
      run: async (d) => {
        await d.click(d.page.locator(".seg-btn").nth(2));
        await d.wait(800);
        await d.click(d.page.locator(".tools-tab").nth(2));
        await d.page.locator(".tools-tree").first().waitFor();
        await d.overlay("hideCursor");
        // Open every level: repository → book → its pages.
        for (let i = 0; i < 12; i++) {
          const closed = d.page.locator(".tools-tree .tools-pair-toggle:not(.open)").first();
          if ((await closed.count()) === 0) break;
          await closed.click();
          await d.wait(450);
        }
        await d.highlight(d.page.locator(".tools-tree").first(), 6);
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
