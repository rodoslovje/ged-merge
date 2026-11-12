# Video navodila GED Merge — scenariji

Scenariji vseh epizod. Govor je tu v slovenščini; dokončni govor v obeh jezikih je v
`videos/scripts/<id>.ts`, ki je recept za gradnjo (glej `videos/README.md`).

## Stanje epizod

| # | Epizoda | Recept | Stanje |
|---|---------|--------|--------|
| 1 | GED Merge — prvi koraki | `scripts/overview.ts` | SL z glasom ✓ |
| 2 | Osnovno urejanje | `scripts/editing.ts` | SL z glasom ✓ |
| 3 | Nastavitve prikaza | `scripts/settings.ts` | SL z glasom ✓ |
| 4 | Viri | `scripts/sources.ts` | SL z glasom ✓ |
| 5 | Diagrami | `scripts/charts.ts` | SL z glasom ✓ |
| 6 | Kraji in geokodiranje | `scripts/geocoding.ts` | SL z glasom ✓ |
| 7 | Zemljevidi | — | scenarij |
| 8 | Združevanje | `scripts/merge.ts` | SL in EN z glasom (pred epizodami 3–5; znova zgraditi) |
| 9 | Statistika | — | scenarij |
| 10 | Pregled | — | scenarij |
| 11 | Dvojniki | — | scenarij |
| 12 | Možnosti diagramov, izvoz, zasebnost | — | scenarij |

Angleške različice epizod 1–5 še niso zgrajene (recepti imajo angleški govor).

## Napotki za agente (vzporedno delo)

- **Ena epizoda = en recept** v `videos/scripts/<id>.ts` z `episode: N`; izhod gre v
  `videos/out/NN-<id>/` (ni v gitu). Vsak agent dela v svojem worktreeju in odda PR.
- **Nastavitve serije:** epizode od 4 naprej imajo `settings: seriesSettings` (France
  izhodiščna oseba, sorodstvo, starosti, slovenski zapis datumov) — kot v epizodi 3.
- **Podatki:** `demo/preseren-hawlina.ged` (glavna), `demo/preseren-odar.ged` (vhodna),
  `demo/preseren-hawlina-porocni.ged` (s poročnimi priimki). Samo resnični, preverljivi
  podatki in nikoli žive osebe; nov podatek preverite v Slovenskem rodoslovnem indeksu
  ali Slovenski biografiji in vir zapišite v glavo recepta.
- **Postopek:** najprej `--silent` (brez stroškov govora) in pregled kadrov, nato gradnja
  z glasom. Spremenjeni stavki se sintetizirajo znova, ostali pridejo iz predpomnilnika.
- **Čakanje** na spletna iskanja ali dolge preglede ovijte v `d.skippable(...)` — v
  videu se skrajša.
- **Selektorji** naj bodo razredi CSS ali `data-*`, ne besedila; kjer je besedilo nujno,
  uporabite `d.t({ sl, en })`. Gumbi, ki se pokažejo šele pod miško, zahtevajo `hover`.
- **Izgovorjava** (glas Soniox »Nina«): »GED Merge« → »Džed Merdž«, »GEDCOM« → »gedkom«,
  »gedmerge.com« po delih (`lib/tts.ts`, `PRONOUNCE`). Ime »Franceta« beri kot
  »pesnika Franceta Prešerna«; izogibaj se besedam, ki jih glas naglasi narobe
  (»materi«, »Šumniki«, »Drevo« na začetku stavka).
- **Slovenščina** v govoru sledi `docs/agents/slovenian-copy.md`; oznake gumbov
  dobesedno iz `src/locales/sl.ts`, v »…«.
- **Naslovna slika:** vse besedilo vodoravno; `d.snapshot()` v koraku, ki najbolje
  pokaže funkcijo.
- **Napake v aplikaciji**, ki jih najdete med snemanjem, popravite v ločenem PR-ju (kot
  #124 za ime hrambe pri Matriculi).

## Skupno vsem videom

- **Dolžina:** 3–6 minut, en video = ena tema.
- **Začetek:** naslovna kartica (»GED Merge · video navodila«, naslov videa, en stavek o
  tem, kaj se boste naučili).
- **Konec:** kartica »GED Merge — vaš rodoslovni program« z naslovom gedmerge.com in
  stavkom, ki pove, kaj GED Merge je: rodoslovni program v brskalniku za urejanje,
  dopolnjevanje in pregledovanje drevesa, brezplačen in brez računa.
- **Na zaslonu:** viden kazalec miške, oranžen obroč okoli kontrole, o kateri teče
  beseda, oštevilčen korak spodaj levo (postane poglavje na YouTubu).
- **Naslovna slika:** skupna predloga (logotip, oranžna oznaka teme, velik naslov z
  eno poudarjeno besedo, značka »Video navodila · N min«, oznaka SLO/ENG) in posnetek
  funkcije, ki jo video prikazuje.
- **Podatki:** resnične zgodovinske osebe (rodbina Prešeren, `videos/demo/`) ali vaše
  anonimizirano drevo. Žive osebe nikoli.
- **Razveljavitev** se ne omenja pri vsakem dejanju; razloži jo samo video 1.

Oznaka v stolpcu »Kader« pove, kaj se dogaja na zaslonu; »Govor« je besedilo
pripovedovalca (in podnapisov).

---

## 1. GED Merge — rodoslovni program v brskalniku

**Cilj:** gledalec ve, kaj GED Merge je, kako odpre datoteko, kje so trije načini
dela, kako išče, razveljavi in kje najde navodila in bližnjice.
**Podatki:** `preseren-hawlina.ged` · **Trajanje:** ~4 min
**Naslovna slika:** oznaka »Pregled« · »Vaš *rodoslovni* program v brskalniku« ·
posnetek urejanja osebe s sorodniki.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | GED Merge je rodoslovni program, ki deluje v vašem brskalniku. V tem videu si ogledamo, kako je zgrajen in kako se v njem hitro znajdete. |
| 2 | Začetna stran, obroč okoli okvirja za datoteko in okvirja z zagotovilom o zasebnosti | Na začetni strani odprete svojo datoteko GEDCOM. Datoteka ostane na vašem računalniku in se nikamor ne pošlje. |
| 3 | Obroč na »Začni novo drevo« in na vzorčna drevesa | Če datoteke še nimate, začnete novo drevo ali si najprej ogledate eno od vzorčnih dreves. |
| 4 | Spust datoteke, odpre se France Prešeren v Urejanju | Odprimo rodovnik Franceta Prešerna. Program pokaže osebo z vsemi sorodniki: starše zgoraj, partnerje in otroke spodaj. |
| 5 | Obroč na zavihke »Urejanje / Združevanje / Orodja« | GED Merge ima tri načine dela. V Urejanju urejate svoje drevo, v Združevanju ga dopolnjujete iz druge datoteke, v Orodjih pa skrbite za datoteko kot celoto. |
| 6 | Klik na starša, nato »Nazaj« | Po drevesu se premikate s klikom na sorodnika, z gumbom »Nazaj« pa se vrnete. |
| 7 | Tipka `/`, vpis »šimen«, Enter | Osebo najhitreje najdete z iskanjem. Pritisnite poševnico in vpišite začetek imena — črk s strešico ni treba vpisovati. |
| 8 | Sprememba polja, nato gumb ↩ in ↪ | Vsako spremembo lahko razveljavite in ponovite, z gumboma zgoraj ali s Ctrl+Z in Ctrl+Shift+Z. |
| 9 | Gumb »Shrani GEDCOM«, predogled, »Prekliči« | Ko shranite, GED Merge pokaže predogled sprememb in prenese novo datoteko. Izvirnika nikoli ne prepiše. |
| 10 | Tipka `?` — seznam bližnjic | Tipka vprašaj odpre seznam bližnjic na tipkovnici. Večino dela lahko opravite brez miške. |
| 11 | Alt+puščica gor/dol v Urejanju | Z Alt in puščicami se premikate k očetu, otrokom in sorojencem. |
| 12 | Gumb ⚙ → Nastavitve (Splošno: vrstni red imena, tema) | V Nastavitvah izberete jezik, temo in način prikaza imen in datumov. |
| 13 | Povezava »Navodila za uporabo« v nogi | Podrobna navodila v slovenščini in angleščini najdete v nogi vsake strani. |
| 14 | Zaključna kartica | |

---

## 2. Osnovno urejanje: osebe, sorodniki in dogodki

**Cilj:** dodati dogodek z datumom in krajem, dodati starša, partnerja, družinski
dogodek in otroka; pokazati razliko med odklopom in brisanjem.
**Podatki:** `preseren-hawlina.ged` — dodamo Šimnov poklic (kmet), Prešernovi sestri
Jero (3. 11. 1798, Vrba) in Mino (22. 1. 1808, Vrba 1) ter Minina moža Jožefa Vovka
(4. 1. 1806) in poroko 28. 5. 1827 — iz Hawlinovega drevesa v Slovenskem rodoslovnem
indeksu in Slovenske biografije (rodbina Prešeren). Izvedba: `scripts/editing.ts`.
**Trajanje:** ~5 min
**Naslovna slika:** oznaka »Urejanje« · »Dopolnite *drevo* korak za korakom« ·
posnetek osebe z dodanim dogodkom.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | V tem videu dopolnimo drevo Franceta Prešerna: dodamo dogodek, sorojence in družino. |
| 2 | Šimen Prešeren, hitri gumb »Poklic« | Pod dogodki so gumbi za najpogostejše dogodke. Črtkan gumb doda nov dogodek, poln skoči na obstoječega. |
| 3 | Vpis »kmet«, nato »Dodaj dogodek« → meni | Vse druge dogodke najdete pod »Dodaj dogodek«, urejene po življenjskih obdobjih. |
| 4 | Vpis datuma »okoli 1800«, predogled pod poljem | Datum vpišete po svoje, na primer »okoli 1800« ali »5. 3. 1850«. Pod poljem vidite, kako ga je program razumel. |
| 5 | Polje kraja: predlog obstoječega kraja | Kraj izberete med kraji, ki so že v datoteki, zato se isti kraj vedno zapiše enako. |
| 6 | Šimen → »+ Dodaj otroka« → Jera Prešeren, 1798 | Otroka dodate kar pri starših. Novi osebi vpišete ime in rojstvo, povezava na družino se naredi sama. |
| 7 | Ponovi za Jurija; Alt+Shift+X za spol | Spol nastavite z menijem ali z bližnjico Alt+Shift+X. |
| 8 | Mina Prešeren (1808) → »+ Dodaj partnerja« → Jožef Vovk | Partnerja dodate pri osebi. Nastane nova družina, v katero vpišete poroko. |
| 9 | »Dodaj družinski dogodek« → Poroka 28. 5. 1827 | Poroko vpišete z gumbom »Dodaj družinski dogodek«. |
| 10 | Obroč na − pri kartici sorodnika | Znak minus osebo samo odklopi iz družine — oseba ostane v datoteki. |
| 11 | Obroč na 🗑 | Koš osebo izbriše, a šele po potrditvi. |
| 12 | Desni pas »Sorodniki« | Na desni vidite širše sorodstvo: strice, tete, bratrance in sestrične. |
| 13 | Shrani GEDCOM, predogled sprememb | Predogled pred shranjevanjem pokaže vse, kar ste dodali. |
| 14 | Zaključna kartica | |

---

## 3. Nastavitve prikaza

**Cilj:** prilagoditi prikaz, da je še bolj uporaben: izhodiščna oseba (France),
sorodstvo in poudarjeni predniki in potomci, starosti, datumi z besedami in nato
slovenski zapis, poročni priimek (prikaz in samodejni zapis ob partnerju), avtor
datoteke, jezik in temna tema. Izvedba in govor: `scripts/settings.ts`.
**Podatki:** `preseren-hawlina-porocni.ged`; druga žena Janeza Prešerna, Marija Triplat,
iz drevesa Odar.

---

## 4. Viri: Matricula, Geneanet in Slovenska biografija

**Cilj:** dodati vir k dogodku s prilepljeno povezavo (Matricula krst, smrt, poroka),
grob z Geneaneta, in vir na osebi (geslo v Slovenski biografiji).
**Podatki:** `preseren-hawlina.ged` · povezave iz drevesa Odar (Slovenski rodoslovni
indeks): krst Franceta Prešerna (Breznica 00164, str. 86), smrt (Kranj 00932, str. 40),
krst Ane Jelovšek (Ljubljana – Sv. Jakob 01156, str. 177); grob Ernestine Jelovšek v
Prešernovem gaju v Kranju (Geneanet, https://en.geneanet.org/cemetery/view/13262440). Vir na osebi: geslo
Franceta Prešerna v Slovenski biografiji (https://www.slovenska-biografija.si/oseba/sbi463215/).
**Trajanje:** ~5 min
**Naslovna slika:** oznaka »Viri« · »Matricula v *eni* potezi« · posnetek obrazca
»Dodaj vir« z zelenim okvirjem »Prepoznana povezava«.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Podatek brez vira je samo trditev. Pokažimo, kako v GED Merge dogodku dodate vir — kar s povezavo na matično knjigo. |
| 2 | ⚙ → Napredno → »Poišči podatke na spletu« vklopljeno | Da program sam prebere podatke o knjigi, v Nastavitvah vklopite spletna iskanja. Poslana je le povezava, nikoli vaše drevo. |
| 3 | France Prešeren, dogodek Rojstvo → »Dodaj« → vir | Vir dodate dogodku: pri rojstvu kliknite »Dodaj« in izberite vir. |
| 4 | Prilepi URL Matricule; okvir »Prepoznana povezava« porumeni, nato pozeleni | Prilepite povezavo na stran matične knjige. Program jo prepozna in sam izpolni naslov knjige, župnijo, arhiv in stran. |
| 5 | Obroč na »Stran« in »Kakovost citata« (3 — primarni vir) | Stran se zapiše v navedbo, sken iz matične knjige pa dobi oceno primarnega vira. |
| 6 | Ctrl+Enter | Potrdite s Ctrl+Enter. |
| 7 | Smrt → isto s povezavo kranjske mrliške knjige | Enako dodate vir smrti. |
| 8 | Ana Jelovšek, krst → povezava Sv. Jakob | Enako deluje za vsako župnijo na Matriculi, tu za krst Ane Jelovšek pri Sv. Jakobu v Ljubljani. |
| 8a | Ernestina Jelovšek → hitri gumb »Pokop« → kraj Kranj → »Dodaj« → vir → prilepi povezavo Geneanet | Program prepozna tudi druge zbirke, na primer grobove na Geneanetu. Prešernova hči Ernestina je pokopana v Prešernovem gaju v Kranju. Pokopu dodamo povezavo na njen grob. |
| 9 | Klik na ikono vira → »Uredi vir«; ↗ odpre Matriculo | Vir kadar koli odprete in uredite, puščica pa odpre stran v matični knjigi. |
| 10 | France Prešeren → »Dodaj vir« pod osebo (ne pri dogodku) → prilepi povezavo Slovenske biografije | Vir lahko dodate tudi osebi kot celoti, kadar govori o več dogodkih hkrati. Za Prešerna je to njegovo geslo v Slovenski biografiji. |
| 11 | Shrani GEDCOM → »Vrstice GEDCOM« | V predogledu shranjevanja vidite, kako se vir zapiše v datoteko GEDCOM. |
| 12 | Zaključna kartica | |

---

## 5. Diagrami

**Cilj:** pokazati vseh sedem vrst diagramov in kdaj kateri pride prav.
**Podatki:** `preseren-hawlina.ged` za drevo in pahljačo; za sodobnike in časovnico
večje drevo (vzorec »Tudorska kraljeva družina« ali vaše anonimizirano drevo).
**Trajanje:** ~5 min
**Naslovna slika:** oznaka »Diagrami« · »Sedem *pogledov* na vaše drevo« · posnetek
pahljače z barvami po kraju rojstva.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Diagram pove več kot seznam. Oglejmo si, katere diagrame nariše GED Merge. |
| 2 | Tipka V → Drevo, predniki | Diagrame odprete s tipko V ali z gumbom zgoraj. Drevo pokaže prednike ali potomce izbrane osebe. |
| 3 | Preklop Drevo / Mreža, Predniki / Potomci / Oboje | Drevo je lahko razvejano ali v mreži, prikaže pa prednike, potomce ali oboje. |
| 4 | Pahljača → Krog | Pahljača na enem zaslonu pokaže osem rodov prednikov. |
| 5 | Časovnica | Časovnica postavi življenja na skupno os let. Takoj vidite, kdo je živel hkrati. |
| 6 | Sorodstvo (S) med Francetom in Jožefom Prešernom | Diagram sorodstva pokaže pot med dvema osebama in ime sorodstva. |
| 7 | Sodobniki: Kolo, Priimki, Trakovi, drsnik »Živi v letu« | Sodobniki pokažejo, kdo od sorodnikov je bil živ v izbranem letu. |
| 8 | Zemljevid (kratko — podrobno v videu 6) | Zemljevid postavi dogodke na kraje. |
| 9 | Poročilo → Seznam prednikov, slog »Pripoved« | Poročilo zapiše prednike ali potomce kot besedilo, s številčenimi viri. |
| 10 | Klik na osebo v diagramu → E odpre Urejanje | S klikom na osebo jo izberete, tipka E pa jo odpre v Urejanju. |
| 11 | Zaključna kartica | |

---

## 6. Kraji in geokodiranje

**Cilj:** prenesti imenik krajev (GURS za Slovenijo, OpenStreetMap za preostali svet),
poiskati kraj pri urejanju in ga zapisati v obliki naselje, občina, država, hišno
številko prestaviti iz kraja v naslov, stare zapise pretvoriti v Orodjih in krajem z
geokodiranjem dodati koordinate. Naslovi (prenos GURS naslovov, geokodiranje hišnih
številk) dobijo svoj video, ko bo storitev INSPIRE pri GURS spet delovala.
**Podatki:** `preseren-hawlina-kraji.ged` — večina krajev v polni obliki, golih ostane
nekaj: Kranj, Radovljica, Žirovnica, Osoje na Koroškem ter hišne številke v kraju
(Žirovnica 7, Vrba 1, Vrba 7). Izvedba in govor: `scripts/geocoding.ts`.
**Trajanje:** ~4 min
**Naslovna slika:** oznaka »Kraji« · »Vsak kraj na *pravem* mestu« · posnetek
predlogov iz imenika GURS ob kraju »Kranj«.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Kraji brez koordinat ne pridejo na zemljevid. Pokažimo, kako v GED Merge kraje poiščete v imenikih, jih zapišete enotno in postavite na zemljevid. |
| 2 | Odpre se France; obroč na kraj rojstva (polna oblika) in smrti (»Kranj«) | Večina krajev je zapisana kot naselje, občina in država, nekaj pa jih je še v stari obliki: samo ime naselja, včasih skupaj s hišno številko. |
| 3 | ⚙ → Napredno → »Poišči podatke na spletu« | Podatki o krajih pridejo s spleta: prenos imenika GURS in iskanje na OpenStreetMap. Poslano je le ime kraja. |
| 4 | ⚙ → Zemljevid → imeniki krajev → GURS »Kraji«, prenos | Za Slovenijo GURS, uradni register vseh naselij z občinami; imenik ostane v brskalniku. |
| 5 | Obroč na »Naslovi«, nato na OpenStreetMap (napis se pokaže šele tu) | Naslovi v posebnem videu; OpenStreetMap za kraje zunaj Slovenije, poišče ga program sam iz polja kraja. |
| 6 | »Nalagaj ploščice zemljevida« | Brez ploščic le obris sveta, z njimi ceste, reke in imena krajev. |
| 7 | Smrt »Kranj« → »Poišči ta kraj v imenikih« | Predlogi v obliki datoteke, z oznako imenika; izberemo »Kranj, Kranj, Slovenija«. |
| 8 | Zelen in siv žebljiček, zemljevid pod dogodki | Zelen žebljiček: kraj ima koordinato; siv: je še nima. |
| 9 | Mina Svetina, rojstvo »Žirovnica 7« → GURS, predlogi s »· Žirovnica 7«; Žirovnica v občini Žirovnica | Program hišno številko prepozna; več Žirovnic — odloči občina. |
| 10 | Obroč na kraj in na polje Naslov (»Žirovnica 7«) | Hišna številka se sama prestavi v Naslov — standardni zapis v GEDCOM: kraj pove naselje, občino in državo, naslov ulico in hišno številko. |
| 11 | Smrt → »Osoje, Avstrija« → OpenStreetMap »Osoje, Koroška, Avstrija« | GURS kraja ne pozna; OpenStreetMap pozna slovenska imena, »na Koroškem« ni del imena, državo lahko napišete po slovensko ali angleško. |
| 12 | Orodja → Kraji → »Neznana država«; ✎ Radovljica → imenik → »Preimenuj« | Sprememba velja za vse zapise kraja naenkrat. |
| 13 | ✎ Žirovnica → »Združi« | Kraj že obstaja, zapisa se združita. |
| 14 | »Geokodiranje« → »Izberi zanesljive« → »Zapiši koordinate« | Zanesljive izberete z enim klikom, koordinate se zapišejo šele ob potrditvi. |
| 15 | Urejanje: France, oba žebljička zelena, zemljevid Vrba → Kranj | |
| 16 | Zaključna kartica | |

---

## 7. Zemljevidi: nastavitve, zgodovinski sloji in izvoz

**Cilj:** zemljevid dogodkov, poti, meje v izbranem letu, zgodovinske karte (franciscejski
kataster, Spezialkarte), vzporedni pogled in izvoz.
**Podatki:** drevo z geokodiranimi kraji (po videu 5) · **Trajanje:** ~4 min
**Naslovna slika:** oznaka »Zemljevid« · »Prednik na *zgodovinski* karti« · posnetek
vzporednega pogleda (franciscejski kataster | današnji zemljevid).

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Kje so živeli vaši predniki? Postavimo jih na zemljevid — tudi na zgodovinskega. |
| 2 | Diagrami → Zemljevid → privolitev v ploščice | Zemljevid prenese ploščice podlage šele, ko to dovolite. Strežnik izve le, kateri del zemljevida gledate. |
| 3 | Filtri: vrste dogodkov, drsnik let | Zgoraj izberete vrste dogodkov in obdobje. |
| 4 | »Poti« | Poti povežejo kraje v življenju osebe. |
| 5 | »Meje« in premik drsnika | Meje pokažejo države in dežele v letu, ki ga izberete na drsniku. |
| 6 | »Sloji« → »Dodaj brezplačen sloj…« → Spezialkarte | Dodate lahko zgodovinske karte, na primer avstrijsko specialko ali franciscejski kataster. |
| 7 | Prosojnost sloja | Vsakemu sloju nastavite prosojnost. |
| 8 | »Vzporedni pogled« | Vzporedni pogled pokaže dva zemljevida drug ob drugem, ki se premikata skupaj. |
| 9 | ⚙ → Zemljevid → »Osnovni zemljevid« | Osnovni zemljevid izberete v Nastavitvah: preprost, topografski ali satelitski. |
| 10 | »Izvoz« → Slika PNG | Pogled izvozite kot sliko. |
| 11 | Zaključna kartica | |

---

## 8. Združevanje: dopolnite drevo iz druge datoteke

**Cilj:** združiti iste osebe iz dveh dreves in prevzeti manjkajoče podatke.
**Podatki:** glavna `preseren-hawlina.ged` (rodovnik Petra Hawline), vhodna
`preseren-odar.ged` (drevo Odar iz Slovenskega rodoslovnega indeksa).
**Trajanje:** ~5 min
**Naslovna slika:** oznaka »Združevanje oseb« · »Dopolnite *drevo* iz druge datoteke« ·
posnetek primerjave z izbiro G/V/O.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Dva raziskovalca sta raziskovala isto rodbino. Pokažimo, kako njune podatke združite v eno drevo. |
| 2 | Glavna datoteka | Najprej odprite svojo datoteko. To je glavna datoteka; vanjo se zapišejo prevzeti podatki. |
| 3 | Združevanje → vhodna datoteka | Na zavihku »Združevanje« odprite drugo drevo. Tej pravimo vhodna datoteka in ostane nespremenjena. |
| 4 | Seznam ujemanj, obroč na stopnjo; lebdenje nad njo | GED Merge poišče osebe, ki so v obeh drevesih, in vsakemu paru določi stopnjo ujemanja. Ko se ustavite nad njo, vidite, iz česa je sestavljena. |
| 5 | France: obroč na krst in pokop (zeleno) | Drugo drevo pozna Prešernov krst v Breznici in pokop v Kranju. Novi podatki so obarvani zeleno. |
| 6 | Obroč na »Vrba« ↔ »Vrba 2, (stara hš 1)« | Kraj rojstva je v drugem drevesu natančnejši — s hišno številko. |
| 7 | Gumbi G/V zatemnjeni → »Potrdi« | Podatke izbirate šele pri potrjenem paru; dokler ga ne potrdite, so gumbi zaklenjeni. Kliknite »Potrdi«. |
| 8 | Klik V pri kraju rojstva | Pri kraju rojstva izberite vhodni, natančnejši zapis. |
| 9 | Šimen ↔ Simon: obroč, klik O | Pri očetu se drevesi razlikujeta v imenu: Šimen in Simon. Z gumbom O obdržite obe obliki. |
| 10 | Ana Jelovšek: starša »✓ dodano« po potrditvi | Ana ima v drugem drevesu starša, ki ju pri vas ni. Ko par potrdite, se dodata v vaše drevo. |
| 11 | Janez Prešeren: nova partnerka Marija Triplat | Drugo drevo pozna tudi drugo ženo Janeza Prešerna. Ob potrditvi se doda kot nova družina. |
| 12 | »Primerjalno drevo« (V) — barve vozlišč | Primerjalno drevo pokaže obe drevesi skupaj; barva pove, kje se ujemata in kje razlikujeta. |
| 13 | Shrani GEDCOM → predogled → Prenesi | Predogled pokaže vse spremembe. Dopolnjeno drevo se shrani kot nova datoteka. |
| 14 | Zaključna kartica | |

---

## 9. Statistika: vaše drevo v številkah

**Cilj:** strani statistike, razširitev števila v seznam oseb, popolnost podatkov in
virov, rodovi, ponovljeni predniki (implex), najbližje slepe ulice.
**Podatki:** vaše anonimizirano drevo (večje in bolj zanimivo kot Prešernovo).
**Trajanje:** ~5 min
**Naslovna slika:** oznaka »Statistika« · »Kaj vam *drevo* pove v številkah« ·
posnetek strani »Rodovi« z grafom prednikov po rodovih.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Koliko prednikov ste že našli? Kje so vrzeli? Statistika odgovori v nekaj sekundah. |
| 2 | Orodja → Statistika → Povzetek | Statistika je prvo orodje v Orodjih. Povzetek pokaže osebe, družine, letnice in najpogostejše priimke. |
| 3 | Klik na stolpec ali število → seznam oseb | Za vsakim številom so osebe. Kliknite število in odpre se seznam; ime vas pripelje v Urejanje. |
| 4 | Kartica »Popolnost podatkov« → vrstica »Navedbe virov« | Popolnost podatkov pove, koliko oseb ima datum rojstva, kraj, starše in vire. Klik na vrstico pokaže, komu kaj manjka — to je vaš seznam opravil. |
| 5 | »Izbor oseb« → Predniki | Statistiko omejite na prednike, potomce ali krvne sorodnike izhodiščne osebe. |
| 6 | Stran »Imena« — imena po stoletjih | Imena pokažejo, kako so se priljubljena imena spreminjala skozi stoletja. |
| 7 | Stran »Družine« — starost ob poroki, poroke po mesecih | Pri družinah vidite starost ob poroki in kdaj so se ljudje najraje poročali. |
| 8 | Stran »Rodovi« — predniki po rodovih | Rodovi pokažejo, koliko prednikov ste našli v vsakem rodu. |
| 9 | Ploščica »Ponovljeni predniki« + kartica »Predniki na več mestih« | Če se isti prednik v rodovniku pojavi večkrat — na primer pri poroki med sorodniki —, to pokaže odstotek ponovljenih prednikov. |
| 10 | »Najbližje slepe ulice« | Najbližje slepe ulice so predniki, pri katerih se vaše raziskovanje ustavi. Tam je naslednji korak. |
| 11 | Stran »Raziskava« — dogodki z navedbo vira | Stran Raziskava pokaže, koliko dogodkov ima vir, po vrstah dogodkov. |
| 12 | »Izvoz« → Slika PNG | Vsako kartico izvozite kot sliko ali tabelo CSV. |
| 13 | Zaključna kartica | |

---

## 10. Pregled: čiščenje podatkov

**Cilj:** poiskati in popraviti napake v podatkih in skladnost z GEDCOM; skupinsko
popravilo.
**Podatki:** vaše anonimizirano drevo (resnične napake) ali kopija Prešernovega drevesa
z namerno vnesenimi napakami (smrt pred rojstvom, pokvarjena povezava, nestandarden
datum) — glej odprta vprašanja. · **Trajanje:** ~4 min
**Naslovna slika:** oznaka »Pregled« · »Počistite *napake* v drevesu« · posnetek
seznama težav s številkami.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Tudi v skrbno vodenem drevesu se naberejo napake. Pregled jih najde v nekaj sekundah. |
| 2 | Orodja → Pregled → »Težave v podatkih« | Pregled preveri vsebino: manjkajoče podatke, nemogoče datume in nenavadne starosti. |
| 3 | Klik na »Smrt pred rojstvom« → oseba v Urejanju | Klik na težavo odpre osebo v Urejanju, kjer jo popravite. |
| 4 | »Pokvarjene povezave« → »Odstrani povezavo« | Nekaterih napak v Urejanju ne vidite, na primer pokvarjenih povezav. Te popravite kar tukaj. |
| 5 | Zavihek »Skladnost z GEDCOM« | Drugi zavihek preveri, ali je datoteka zapisana po standardu GEDCOM. |
| 6 | Nestandarden datum → »Popravi« | Nestandarden datum program prepiše v standardno obliko. |
| 7 | »Popravljivo« → »Izberi vse popravljive« → »Popravi izbrane« | Vse popravljive težave popravite naenkrat. Pred tem vidite seznam popravkov s številom. |
| 8 | »Zaženi znova« | Ko datoteko spremenite, pregled zaženete znova. |
| 9 | Zaključna kartica | |

---

## 11. Dvojniki: združevanje podvojenih oseb

**Cilj:** najti osebe, ki so v datoteki dvakrat, in jih združiti, vključno s
podvojenimi starši; zavrniti napačen par.
**Podatki:** vaše anonimizirano drevo ali kopija Prešernovega drevesa z vnesenim dvojnikom
(npr. France Prešeren drugič, z drugačnim zapisom kraja in s krstom) — glej odprta
vprašanja. · **Trajanje:** ~4 min
**Naslovna slika:** oznaka »Dvojniki« · »Ena *oseba*, en zapis« · posnetek primerjave
dvojnikov drug ob drugem.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Ko drevo raste, se ista oseba hitro znajde v njem dvakrat. Pokažimo, kako dvojnike najdete in združite. |
| 2 | Orodja → Dvojniki | Orodje primerja vsako osebo z vsako in uporabi isti algoritem kot Združevanje. |
| 3 | Skupine, razvrščene po stopnji ujemanja | Možni dvojniki so združeni v skupine, najzanesljivejši so na vrhu. |
| 4 | »Pokaži primerjavo drug ob drugem« | Par primerjate drug ob drugem, enako kot pri združevanju datotek. |
| 5 | Izbira polj G/V/O | Pri vsakem podatku izberete, katerega obdržite. Ohrani se levi zapis. |
| 6 | Namig o podvojenih starših → obkljukaj | Če sta podvojena tudi starša, ju program ponudi za združitev pred tem parom. |
| 7 | »Združi« → potrditev z obema ID | Združitev pred izvedbo pokaže oba zapisa z njunima oznakama. |
| 8 | Drug par → »Zavrni« | Če par ni ista oseba, ga zavrnite. Zavrnjeni pari so v posebnem pogledu. |
| 9 | Zaključna kartica | |

---

## 12. Možnosti diagramov, izvoz in zasebnost

**Cilj:** prilagoditi diagram (rodovi, podatki na osebi, barve), ga izvoziti (SVG, PDF
na več listov, GEDCOM samo z narisanimi osebami) in pripraviti datoteko za deljenje brez
živih oseb.
**Podatki:** večje drevo (vaše anonimizirano ali vzorec) · **Trajanje:** ~5 min
**Naslovna slika:** oznaka »Izvoz« · »Natisnite *drevo* do A0« · posnetek pahljače z
barvami in menija Izvoz.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Diagram prilagodite, natisnete ali delite. Pokažimo, kako — in kako pri tem zaščitite žive osebe. |
| 2 | Diagram → gumb ⚙ »Diagram« → Rodovi | V nastavitvah diagrama izberete število rodov. |
| 3 | »Oseba«: Življenjska doba, Kraj, Fotografija | Izberete, kaj se izpiše pri osebi: letnice, kraj, fotografija, sorodstvo. |
| 4 | »Barva«: Rod → Kraj rojstva → Viri | Barva lahko pove rod, kraj rojstva ali kako dobro so osebe podprte z viri. |
| 5 | »Izvoz« → Slika SVG | Diagram izvozite kot sliko SVG, ki ostane ostra pri vsaki velikosti. |
| 6 | »Izvoz« → PDF → A3 → »Velikost tiska« → število listov | Za tisk izberete velikost papirja. Širok diagram se razdeli na več listov, z oznakami, kje se veja nadaljuje. |
| 7 | »Izvoz« → GEDCOM (N oseb) | Iz diagrama izvozite tudi datoteko GEDCOM samo z narisanimi osebami — na primer za sorodnika, ki ga zanima ena veja. |
| 8 | »Zasebnost« → »Skrij žive osebe« | Preden diagram delite, skrijte žive osebe. |
| 9 | Orodja → Zasebnost: način imen »Začetnice«, predogled | Za celo datoteko uporabite orodje Zasebnost. Žive osebe prikrijete ali odstranite, njihova imena pa zamenjate z začetnicami. |
| 10 | »Prenesi prikrito datoteko GEDCOM« | Prikrita datoteka se prenese posebej. Vaša glavna datoteka ostane nespremenjena. |
| 11 | Zaključna kartica | |

---

## Odprta vprašanja

1. **Epizode 9, 10, 11 (in 7, 12):** anonimizirano drevo avtorja bi bilo boljše od 25 oseb
   rodbine Prešeren, zlasti za statistiko, pregled in dvojnike.
2. **Brez takega drevesa za epizodi 10 in 11:** v kopijo Prešernovega drevesa smemo
   namerno vnesti napake in dvojnika le z dovoljenjem, in v videu to povemo.
