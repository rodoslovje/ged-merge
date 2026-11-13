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
| 7 | Zemljevidi | `scripts/maps.ts` | SL z glasom ✓ |
| 8 | Možnosti diagramov, izvoz, zasebnost | `scripts/export.ts` | SL z glasom ✓ |
| 9 | Statistika | `scripts/stats.ts` | SL z glasom ✓ |
| 10 | Združevanje | `scripts/merge.ts` | SL z glasom ✓ |
| 11 | Dvojniki | `scripts/duplicates.ts` | tihi osnutek |
| 12 | Kraji in naslovi | `scripts/addresses.ts` | osnutek brez glasu |
| 13 | Pregled | — | odloženo |

Angleške različice epizod 1–5 še niso zgrajene (recepti imajo angleški govor).

## Napotki za agente (vzporedno delo)

- **Ena epizoda = en recept** v `videos/scripts/<id>.ts` z `episode: N`; izhod gre v
  `videos/out/NN-<id>/` (ni v gitu). Vsak agent dela v svojem worktreeju in odda PR.
- **Nastavitve serije:** epizode od 4 naprej imajo `settings: seriesSettings` (France
  izhodiščna oseba, sorodstvo, starosti, slovenski zapis datumov) — kot v epizodi 3.
  Od epizode 6 naprej so vklopljene tudi ploščice zemljevida: epizoda 6 jih vklopi pred
  kamero, poznejše epizode imajo `settings: seriesSettingsWithMaps`.
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
številk) dobijo svoj video, epizodo 12.
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

## 7. Zemljevidi: poti, meje in zgodovinske karte

**Cilj:** zemljevid krajev z gručami, iskanje kraja, izbira vrst dogodkov in obdobja,
poti, meje v izbranem letu, zgodovinske karte iz Nastavitev (specialka, franciscejski
kataster Bitenj 1826), prosojnost sloja, vzporedni pogled in izvoz slike PNG.
**Podatki:** `rodbina-renko.ged` — anonimiziran izsek avtorjevega drevesa, kraji
geokodirani (Gorenjska, Bela krajina, Gorski kotar). Izvedba in govor: `scripts/maps.ts`.
**Trajanje:** ~3 min
**Naslovna slika:** oznaka »Zemljevid« · »Prednik na *zgodovinski* karti« · posnetek
vzporednega pogleda (današnji zemljevid | kataster Bitenj 1826).

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Kje so živeli vaši predniki? Postavimo jih na zemljevid, tudi na zgodovinskega. |
| 2 | Odpre se rodbina Renko | Večje drevo, vsi kraji že imajo koordinate. |
| 3 | V → »Zemljevid«, gruče po Evropi | Dogodki prednikov in potomcev, kraji z več dogodki v gručah. |
| 4 | Iskanje »Zgornje Bitnje« | Iskalno polje premakne zemljevid na kraj ali osebo. |
| 5 | »Poroka« izklop/vklop, »Do leta« 1870 | Izbira vrst dogodkov in obdobja. |
| 6 | »Poti« | Življenjske poti s puščicami. |
| 7 | Oddaljitev, »Meje« (1870) | Upravne meje iz OpenHistoricalMap v letu »Do leta«. |
| 8 | ⚙ → Zemljevid → »Dodaj brezplačen sloj« → specialka, kataster Bitnje | Zgodovinske karte se dodajo v Nastavitvah. |
| 9 | »Sloji« → kataster, približanje Bitnjam | Sloji z ustreznim obdobjem so označeni. |
| 10 | Drsnik prosojnosti | Pod staro karto se vidi današnji zemljevid. |
| 11 | »Vzporedni pogled« | Levo današnji zemljevid, desno kataster 1826, premikata se skupaj. |
| 12 | »Izvoz« → »Slika PNG, vzporedni pogled« | Slika PNG z navedbo virov. |
| 13 | Zaključna kartica | |

---

## 8. Možnosti diagramov, izvoz in zasebnost

**Cilj:** prilagoditi diagram (usmeritev, rodovi, podatki ob osebi, barva), ga izvoziti
(SVG, PDF na več listov, GEDCOM samo z narisanimi osebami) in pred deljenjem prikriti žive
osebe — na diagramu in v celi datoteki.
**Podatki:** `preseren-hawlina-geo.ged` za nastavitve in izvoz; za zasebnost
`rodbina-renko.ged`, anonimiziran izsek iz avtorjevega drevesa (edina vzorčna datoteka z
živimi osebami: avtor in starša s pravimi imeni, drugi živi sorodniki z izmišljenimi imeni,
spolom in datumi). Izvedba: `scripts/export.ts`. · **Trajanje:** ~4 min
**Naslovna slika:** oznaka »Izvoz« · »Natisnite *drevo* na več listov« · posnetek štirih
listov A4.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Diagram lahko prilagodite, natisnete ali pošljete drugim. V tem videu pokažemo, kako — in kako pri tem zaščitite žive osebe. |
| 2 | Prešernovo drevo prednikov | Odprimo rodovnik pesnika Franceta Prešerna in njegovo drevo prednikov. |
| 3 | »Diagram« → Usmeritev | Vse možnosti so pod gumbom »Diagram«. Drevo lahko teče od leve proti desni ali od zgoraj navzdol. |
| 4 | Rodovi − / + | Pri velikem drevesu omejite število rodov. |
| 5 | Oseba → Kraj | Pod »Oseba« izberete, kaj se izpiše ob vsaki osebi. |
| 6 | Barva: Rod → Stoletje → Kraj rojstva, legenda | Barva lahko nekaj pove: rod, stoletje, kraj rojstva. |
| 7 | »Izvoz« → Slika SVG | Slika SVG ostane ostra pri vsaki velikosti. |
| 8 | »Izvoz« → PDF: A3, A4 ležeče, »Velika« | Če je drevo za en list preširoko, se razreže na več listov. |
| 9 | »Natisni« → štirje listi na zaslonu | Številka v krogcu pove, kje se diagram nadaljuje. |
| 10 | »Izvoz« → GEDCOM (21 oseb) | Sorodniku pošljete le vejo, ki ga zanima. |
| 11 | Zamenjava glavne datoteke z `rodbina-renko.ged` | V Prešernovi rodbini živih oseb ni, zato odpremo drugo drevo. |
| 12 | Ded → pahljača potomcev, 2 rodova, barva »Živi« | Na diagramu so zdaj tudi živi. |
| 13 | »Skrij žive osebe« | Namesto imena ostane samo sorodstvo; zaščiten je tudi izvoz. |
| 14 | Orodja → Zasebnost: meja 100 let, število živih | Orodje poišče verjetno žive osebe. |
| 15 | Prikrij / Odstrani; ime → Začetnice; kaj se odstrani | Žive osebe prikrijete ali odstranite. |
| 16 | »Prenesi prikrito datoteko GEDCOM« | Delovna datoteka ostane nespremenjena. |
| 17 | Zaključna kartica | |

---

## 9. Statistika: vaše drevo v številkah

**Cilj:** strani statistike, razširitev števila v seznam oseb, popolnost podatkov, izbor
oseb in filtri, imena po stoletjih, življenjska doba, poroke po mesecih, poroke med
sorodniki, selitve, rodovi, ponovljeni predniki, najbližje slepe ulice, izvoz.
**Podatki:** `rodbina-renko.ged` — anonimiziran izsek avtorjevega drevesa (1721 oseb:
predniki z vsemi brati in sestrami, rojstva 1605–2010; umrli z viri, skeni in poklici). Izvedba in govor: `scripts/stats.ts`. **Trajanje:** ~5 min
**Naslovna slika:** oznaka »Statistika« · »Kaj vam *drevo* pove v številkah« ·
posnetek strani »Rodovi« s kartico »Predniki po rodovih«.

Zgodba, ki jo povedo številke te datoteke: poroke februarja (predpust) in novembra, skoraj
nobene marca in decembra (post, advent); pred petim letom umre 36 % otrok v 18. stoletju in
15 % v 20. — vidno le, ker so v
drevesu tudi bratje in sestre prednikov; edina poroka med bratrancem in
sestrično (Jožef ⚭ Marija Simonič, vnuka Matije Simoniča in Marije Plut) je vzrok, da sta
ta dva in Matijeva starša v rodovniku dvakrat (ponovljeni predniki).

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Koliko prednikov ste že našli? Kje se vaša raziskava ustavi? … Statistika odgovori v nekaj sekundah. |
| 2 | Spust datoteke → Orodja → Statistika | Anonimiziran izsek: predniki z vsemi brati in sestrami; Statistika vedno zajame celotno datoteko. |
| 3 | Povzetek: ploščice, »Letnice rojstev«, »Najvišja starost« | Oseb, družin, priimkov, leta, najvišja starost; najpogostejši priimki in imena. |
| 4 | Klik na »Simonič« → seznam → ime → Urejanje → nazaj | Za vsakim številom so osebe. |
| 5 | »Popolnost podatkov« → »Datum smrti« → seznam | Datum smrti je znan le pri dveh petinah umrlih; seznam opravil. |
| 6 | »Predniki«, nato »Filtri« → Hrvaška | Izbor oseb in filtri; del rodbine izvira s Hrvaške. |
| 7 | Imena: imena po stoletjih, »Ime po sorodniku« | Matija, Janez, nato Anton in Franc; Marija; skoraj 20 % deklic po babici. |
| 8 | Življenjska doba: starost ob smrti, »Umrli pred 5. letom starosti« | Dva vrhova; pred petim letom umre 36 % otrok v 18. stoletju, 15 % v 20. |
| 9 | Družine: »Poroke po mesecih« | Februar in november; marec in december skoraj brez porok. |
| 10 | »Sorodstvo med zakoncema« → bratranec in sestrična → diagram sorodstva | Jožef in Marija Simonič; skupna prednika Matija Simonič in Marija Plut. |
| 11 | Poklic: poklici po stoletjih | Kmetje, polovični in četrtinski zemljaki; v 20. stoletju delavci. |
| 12 | Selitve: povprečna razdalja, selitve med državami | 2 km v 18. stoletju; izseljevanje v Združene države. |
| 13 | Rodovi: ploščice, predniki po rodovih, očetova in materina stran | 399 prednikov v 12 rodovih; do 6. rodu vsi znani. |
| 14 | »Ponovljeni predniki«, »Predniki na več mestih« | Zaradi poroke bratranca in sestrične dvakrat v rodovniku. |
| 15 | »Najbližje slepe ulice« | Naslednji korak raziskave. |
| 16 | Raziskava: dogodki z navedbo vira | Krsti in poroke dobro podprti, smrt le vsaka peta. |
| 17 | Ikona »i«, izvoz kartice | Tabela CSV ali slika. |
| 18 | »Izvoz« zgoraj | Cela stran statistike kot ena slika, z naslovom in izborom oseb. |
| 19 | Zaključna kartica | |

---

## 10. Združevanje: dopolnite drevo iz druge datoteke

**Cilj:** združiti iste osebe iz dveh dreves in prevzeti manjkajoče podatke; sorodstvo do
izhodiščne osebe na seznamu in v primerjalnem drevesu; kraji vhodne datoteke samodejno v
obliki glavne.
**Podatki:** glavna `preseren-hawlina-geo.ged` (rodovnik Petra Hawline, kot ga pusti
epizoda 6: naselje, občina, država s koordinatami GURS, hišne številke v naslovu), vhodna
`preseren-odar.ged` (drevo Odar iz Slovenskega rodoslovnega indeksa, hišne številke v kraju).
Izvedba in govor: `scripts/merge.ts`. **Trajanje:** ~5 min
**Naslovna slika:** oznaka »Združevanje oseb« · »Dopolnite *drevo* iz druge datoteke« ·
posnetek primerjave z izbiro G/V/O.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Dva raziskovalca sta raziskovala isto rodbino. Pokažimo, kako njune podatke združite v eno drevo. |
| 2 | Glavna datoteka, obroč na geokodiran kraj | Glavna datoteka; kraji so že urejeni in geokodirani, kot v šestem videu. |
| 3 | Združevanje → vhodna datoteka | Drugo drevo iz Slovenskega rodoslovnega indeksa je vhodna datoteka. |
| 4 | Seznam ujemanj, obroč na stopnjo | Pari oseb in stopnja ujemanja. |
| 5 | Obroč na »Dedek« (poudarjeno) in »Zakonec« | Sorodstvo s Prešernom pod imenom, neposredni predniki poudarjeni. |
| 6 | Filter »Predniki«, nazaj »Vse osebe« | Seznam zožite na prednike. |
| 7 | France: krst in pokop (zeleno) | Novi podatki so obarvani zeleno. |
| 8 | Starosti ob datumih | Starost ob smrti, starost staršev ob rojstvu. |
| 9 | »Vrba 2, (stara hš 1)« → kraj »Vrba, Žirovnica, Slovenija« + naslov; »Kranj 181« | Kraj se prepiše v obliko vaše datoteke, hišna številka gre v naslov. |
| 10 | Gumbi zaklenjeni → »Potrdi« | Podatke izbirate šele pri potrjenem paru. |
| 11 | G/V pri naslovu | G ohrani podatek iz glavne datoteke, V prevzame vhodnega; novi podatki so že izbrani. |
| 12 | Šimen ↔ Simon: »Potrdi«, O | Obe obliki imena. |
| 13 | Klik na »Marija Prešeren« v vrstici »Mati« → njen par, »Potrdi«, O | Mina je domača oblika imena Marija; s klikom na ime odprete njen par. |
| 14 | Nazaj na Šimna: vrstica »Mati« = | Vrstica »Mati« se zdaj ujema. |
| 15 | Ana Jelovšek: starša »✓ dodano« | Ob potrditvi se starša takoj dodata v drevo. |
| 16 | Janez Prešeren: Marija Triplat | Nova družina. |
| 17 | Primerjalno drevo, legenda barv, sorodstvo na vozliščih | Barva pove ujemanje; sorodstvo s Prešernom tudi tu. |
| 18 | Shrani GEDCOM → predogled → Prenesi | Predogled pokaže vse spremembe. |
| 19 | Zaključna kartica | |

---

## 11. Dvojniki: združevanje podvojenih oseb

**Cilj:** najti osebe, ki so v datoteki dvakrat, in jih združiti, skupaj s podvojenim
staršem; pokazati para, pri katerih je potrebna presoja; zavrniti skupino, ki ni dvojnik. Neposredno nadaljuje epizodo 10: ista primerjava,
tokrat znotraj ene datoteke.
**Podatki:** `rodbina-renko.ged` (anonimiziran izsek avtorjevega rodovnika, kot v epizodi 9),
v katerem so resnični dvojniki — nič ni vneseno namenoma:
- Janez Starašinič, r. 1752 v Krasincu (`@77637144@` in `@I412665969695@`, stopnja ujemanja ~100): isti
  mož dvakrat pod istim očetom, vsak zapis s svojo kopijo matere Lucije Klepec (~96);
- Luka Mubi (87) in Matija Simonič (86): para, pri katerih avtor sam ne ve, ali gre za isto
  osebo — prikazana kot primer presoje, ostaneta na seznamu;
- Pezdirci, Krasinec 2, 1892 (skupina treh zapisov, stopnji ujemanja 84 in 78): trije bratje — NN, rojen
  in umrl 10. 1. 1892, ter dvojčka Jožef in Peter, rojena 8. 12. 1892.

Izvedba in govor: `scripts/duplicates.ts`. **Trajanje:** ~3,5 min
**Naslovna slika:** oznaka »Dvojniki« · »Ena *oseba*, en zapis« · posnetek primerjave
dvojnikov drug ob drugem.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Ko drevo raste, se ista oseba hitro znajde v njem dvakrat. Pokažimo, kako dvojnike najdete in združite. |
| 2 | Odpri `rodbina-renko.ged` → Orodja → Dvojniki | Orodje primerja vsako osebo z vsako drugo, z istim algoritmom kot Združevanje. |
| 3 | Seznam parov, obroč na stopnjo in oznako zapisa | Pari so razvrščeni po stopnji ujemanja; ob imenu je oznaka zapisa. |
| 4 | Janez Starašinič: primerjava, Ohranjeni/Kandidat | Primerjava drug ob drugem; levi zapis se ohrani. |
| 5 | Vrstica »Mati« (dve Luciji) → namig, obkljukaj | Tudi mati je v drevesu dvakrat; program jo ponudi za združitev pred tem parom. |
| 6 | »Združi« → potrditev z obema oznakama | Pred združitvijo pokaže oba zapisa in mater, ki se združi najprej. |
| 7 | Seznam brez obeh parov → »Zaženi znova« | Iz seznama sta izginila oba para; ker so se osebe združile, izračun dvojnikov zaženemo znova. |
| 8 | Luka Mubi (87): obroč na datum rojstva, starša, kraj | Odločitev ni očitna: ocenjeno rojstvo okoli 1665 v Tupaličah ali krst 1668 v Olševku. Najprej preverite vire, par ostane na seznamu. |
| 9 | Matija Simonič (86): obroč na datum rojstva | Krst 1730 ali ocena okoli 1735, v isti vasi še en Matija iz leta 1726. Tudi ta par zaenkrat pustimo. |
| 10 | Prag »≥ 85« → »≥ 75«, obroč na skupino Pezdirc | Nižji prag pokaže šibkejše pare in skupine s tremi ali več zapisi. |
| 11 | Razpri skupino, odpri par NN ↔ Jožef: ime, rojstvo, smrt | Različni imeni, rojstvo 11 mesecev narazen, smrt na dan rojstva ali leto pozneje: dva brata. |
| 12 | Peter (dvojček Jožefa) → »Zavrni vse« | V skupini ni dvojnikov, zato jo zavrnete. |
| 13 | »Zavrnjeni« → nazaj na dvojnike | Zavrnjeni pari se ne vrnejo; zavrnitev lahko prekličete. |
| 14 | Zaključna kartica | |

---

## 12. Kraji in naslovi: drevo krajev, poimenovanje in hišne številke

**Cilj:** prenos registra naslovov GURS (v ozadju), drevo krajev, druga imena kraja,
primerjava naslovov z uradnim registrom, geokodiranje naslovov in zapis hiše, ki je v
zgodovini dobila več številk. Izvedba in govor: `scripts/addresses.ts`.
**Zapis naslova:** najprej današnji naslov, nato starejši, ločeni s poševnico; na koncu
je lahko pripis v oklepaju — `Hafnarjeva pot 55 / 21 / Stražišče 66`,
`Zaloška cesta 2 (klinični center)`. Program vsako številko poišče posebej
(`rnQueriesFrom`), pripis ostane.
**Podatki:** `rodbina-renko.ged` — kraji imajo koordinate naselja, 255 hiš je že
umeščenih, 227 še ne (90 z zadetkom v registru). Poimenovanje naslovov najde eno
odstopanje: rojstva v kranjski porodnišnici so v datoteki zapisana kot »Kidričeva 38a
(porodnišnica)« (trije dogodki, umrli), register piše »Kidričeva cesta 38a«; 89 starih
številk je le preštetih. »bolnišnica /
klinični center« (13 dogodkov v Ljubljani) je UKC, Zaloška cesta 2. Hafnarjeva pot 21
je danes druga hiša, Stražišče 66 registra ni. »Zapisano dvakrat«: Krasinec 26 in
Krasinec 26 (pd Jelin), oba brez lastne lege. GEDCOM 7.0, zato druga imena (TRAN).
**Trajanje:** ~5 min (prenos naslovov ~10 min, v videu skrajšan)
**Naslovna slika:** oznaka »Naslovi« · »Vsaka *hiša* na svojem mestu« · posnetek
zadetkov za Hafnarjevo pot 55 / 21 / Stražišče 66.

| # | Kader | Govor |
|---|-------|-------|
| 1 | Naslovna kartica | Kraj pove vas, naslov pove hišo. Pokažimo, kako v GED Merge uredite oboje — tudi hišne številke, ki so se skozi zgodovino spreminjale. |
| 2 | Odpre se rodbina Renko | Kraji imajo že koordinate, mnoge hiše pa še ne. |
| 3 | ⚙ → Zemljevid → GURS »Kraji«, nato »Naslovi«; Nastavitve se zaprejo | Register naslovov: 580 000 hiš s koordinatami, prenos nekaj minut, v brskalniku; Nastavitve lahko zaprete, register se nalaga v ozadju. |
| 4 | Orodja → Kraji, drevo: Slovenia → Kranj → Kranj | Država, občina, naselje in hiša; ob vsakem število zapisov in koordinata. |
| 5 | ✎ na naselju Kranj → »+ Dodaj ime« Krainburg → »Zapiši imena« → filter »Krainburg« | Stara ali tuja imena; iskanje najde kraj tudi po njih. |
| 6 | »Poimenovanje« → »Naslovi« (počaka na register) → ugotovitev »Zapis« pri Kidričevi 38a | Register ulico piše »Kidričeva cesta«. |
| 6a | »Prevzemi« → »Ni takega naslova 89« | Uradni zapis, pripis v oklepaju ostane; starih številk ne našteje, ampak jih prešteje. |
| 7 | »Geokodiranje« → »Naslovi« → država »Slovenija« | Hiše po krajih; naložen je le slovenski register; hiša brez svoje lege podeduje koordinato naselja. |
| 8 | »Prikaži že umeščene«, filter »klinični« → ✎ »Zaloška cesta 2 (klinični center)« → zadetek SI-ADR | Pravi naslov, opis v oklepaju; register hišo najde, zadetek potrdimo, da se zapiše koordinata. |
| 9 | Filter »Hafnarjeva pot 55« → ✎ dopiši » / Stražišče 66« | Tri številke: najprej današnja, nato starejše, ločene s poševnico. |
| 10 | Zadetka 1 in 2 → izbira 55 | Vsaka številka posebej; 21 je danes druga hiša, izberete 55; vaške številke register nima več. |
| 11 | »Izberi zanesljive« → »Izbrani« | Nedvoumne z enim klikom — a zanesljiv pomeni le, da se zapis ujema z današnjim registrom: stara številka je register ne pozna ali najde drugo hišo, zato izbrane preglejte. |
| 12 | »Zapisano dvakrat«, filter »Krasinec 26« → »Združi« | Ista hiša s hišnim imenom in brez njega. |
| 13 | »Zapiši koordinate« | Šele ob potrditvi, kot standardni zapis v GEDCOM. |
| 14 | Zaključna kartica | |

---

## 13. Pregled: čiščenje podatkov

**Odloženo:** `rodbina-renko` ima le vsebinske težave (20), nobene težave skladnosti
z GEDCOM, smrti pred rojstvom ali pokvarjene povezave — kadri 4–7 bi potrebovali
namerno vnesene napake.
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

## Odprta vprašanja

1. **Epizoda 13 (Pregled):** `rodbina-renko` nima napak skladnosti, smrti pred
   rojstvom ali pokvarjenih povezav. Namerno vnesene napake v kopiji drevesa le z
   dovoljenjem, in v videu to povemo — ali pa scenarij skrajšamo na vsebinske težave.
