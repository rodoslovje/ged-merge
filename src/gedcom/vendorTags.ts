/**
 * Registry of known vendor-extension (`_`-prefixed) GEDCOM tags.
 *
 * Built from a survey of the genealogical-index submission corpus (271 files,
 * ~2.46 M individuals; 2026-07 — see IDEAS.md "Custom-tag support plan"): the
 * output of Brother's Keeper, Family Historian, MyHeritage Family Tree Builder,
 * Legacy, Family Tree Maker, Ancestry, RootsMagic, MacFamilyTree, webtrees,
 * Gramps, PAF and Geni. The registry classifies each tag so the health check
 * can label it ("MyHeritage — last-updated timestamp") instead of listing an
 * opaque inventory, and so privacy/normalization passes can treat whole
 * categories uniformly.
 *
 * This registry never changes how a tag round-trips — unknown and known vendor
 * tags alike are preserved verbatim in the raw `GedNode` tree.
 */

export type VendorTagCategory =
  /** Cross-file person/record identifiers (sync ids, permalinks). */
  | "identity"
  /** Marriage/partnership status and child-to-parent relationship qualifiers. */
  | "familyStatus"
  /** A real life event with DATE/PLAC-style substructure. */
  | "event"
  /** A person-level fact (military service, height, private flag, …). */
  | "attribute"
  /** An additional name form (married, farm/house, religious, call name…). */
  | "name"
  /** Media/photo metadata (primary flag, crop, order, keywords, …). */
  | "media"
  /** Source/citation formatting and template metadata. */
  | "citation"
  /** Software-internal bookkeeping with no genealogical content. */
  | "internal"
  /** Account traces — usernames, e-mails, tokens — that should never be shared. */
  | "privacy";

export interface VendorTagInfo {
  /** Producing software, for display ("Brother's Keeper", "multiple programs"). */
  software: string;
  category: VendorTagCategory;
  /** Short human meaning in both UI languages. */
  meaning: { en: string; sl: string };
}

const BK = "Brother's Keeper";
const FH = "Family Historian";
const MH = "MyHeritage";
const FTM = "Family Tree Maker";
const ANC = "Ancestry";
const RM = "RootsMagic";
const MFT = "MacFamilyTree";
const WT = "webtrees";
const MULTI = "multiple programs";

/** tag → classification. Keep alphabetical-ish within category blocks. */
export const VENDOR_TAGS: Record<string, VendorTagInfo> = {
  // ── Identity ──────────────────────────────────────────────────────────────
  _UID: { software: MULTI, category: "identity", meaning: { en: "unique record identifier (GEDCOM 7 UID)", sl: "enolični identifikator zapisa (GEDCOM 7 UID)" } },
  _FID: { software: `${MFT}/FamilySearch`, category: "identity", meaning: { en: "FamilySearch person ID", sl: "FamilySearch ID osebe" } },
  _FSFTID: { software: RM, category: "identity", meaning: { en: "FamilySearch Family Tree ID", sl: "FamilySearch Family Tree ID" } },
  _APID: { software: ANC, category: "identity", meaning: { en: "Ancestry source-record ID", sl: "Ancestry ID izvornega zapisa" } },
  _AMTID: { software: `${FTM}/${ANC}`, category: "identity", meaning: { en: "Ancestry Member Tree ID", sl: "Ancestry ID družinskega drevesa" } },
  _WPID: { software: ANC, category: "identity", meaning: { en: "wife's Ancestry record ID", sl: "Ancestry ID zapisa žene" } },
  _HPID: { software: ANC, category: "identity", meaning: { en: "husband's Ancestry record ID", sl: "Ancestry ID zapisa moža" } },
  _FGRAVE: { software: BK, category: "identity", meaning: { en: "Find a Grave memorial ID", sl: "Find a Grave ID spomenika" } },

  // ── Family status / pedigree ──────────────────────────────────────────────
  _FREL: { software: `${FTM}/${ANC}/${BK}`, category: "familyStatus", meaning: { en: "child's relationship to father (natural/adopted/step)", sl: "otrokovo razmerje do očeta (biološki/posvojen/pastorek)" } },
  _MREL: { software: `${FTM}/${ANC}/${BK}`, category: "familyStatus", meaning: { en: "child's relationship to mother (natural/adopted/step)", sl: "otrokovo razmerje do matere (biološki/posvojen/pastorek)" } },
  _MSTAT: { software: BK, category: "familyStatus", meaning: { en: "how the partnership began (married/partners/single…)", sl: "kako se je zveza začela (poroka/partnerja/samski …)" } },
  _MARRIED: { software: BK, category: "familyStatus", meaning: { en: "married flag (Y/N)", sl: "zastavica poroke (D/N)" } },
  _NMR: { software: BK, category: "familyStatus", meaning: { en: "couple never married", sl: "par ni bil poročen" } },
  _SEPR: { software: BK, category: "familyStatus", meaning: { en: "separation (couple split without divorce)", sl: "razhod (brez razveze)" } },
  _STAT: { software: FTM, category: "familyStatus", meaning: { en: "marriage status", sl: "zakonski status" } },
  _MEND: { software: FTM, category: "familyStatus", meaning: { en: "how the marriage ended", sl: "kako se je zakon končal" } },
  _PEDI: { software: FH, category: "familyStatus", meaning: { en: "child-to-family pedigree (illegitimate/adopted…)", sl: "otrokov rodovniški status (nezakonski/posvojen …)" } },
  _PREF: { software: WT, category: "familyStatus", meaning: { en: "preferred parent/child link", sl: "prednostna povezava starš–otrok" } },
  _PRIMARY: { software: "PAF", category: "familyStatus", meaning: { en: "primary parent family", sl: "primarna družina staršev" } },

  // ── Events (real genealogical content with DATE/PLAC) ─────────────────────
  _INTE: { software: BK, category: "event", meaning: { en: "interment (placing of remains)", sl: "položitev v grob" } },
  _FNRL: { software: BK, category: "event", meaning: { en: "funeral", sl: "pogreb" } },
  _MILT: { software: `${BK}/${FTM}`, category: "event", meaning: { en: "military service", sl: "vojaška služba" } },
  _MILI: { software: BK, category: "event", meaning: { en: "military service", sl: "vojaška služba" } },
  _MEDC: { software: BK, category: "event", meaning: { en: "medical condition", sl: "zdravstveno stanje" } },
  _COML: { software: BK, category: "event", meaning: { en: "common-law (unmarried) union", sl: "zunajzakonska skupnost" } },
  _ELEC: { software: "Gramps", category: "event", meaning: { en: "elected to office", sl: "izvolitev" } },
  _DEG: { software: "Gramps", category: "event", meaning: { en: "academic degree", sl: "akademski naziv" } },
  _MDCL: { software: "Gramps", category: "event", meaning: { en: "medical condition", sl: "zdravstveno stanje" } },
  _EMPLOY: { software: ANC, category: "event", meaning: { en: "employment", sl: "zaposlitev" } },
  _ORDI: { software: ANC, category: "event", meaning: { en: "ordinance", sl: "obred" } },
  _SHAN: { software: FH, category: "event", meaning: { en: "shared event — witness names", sl: "deljen dogodek — imena prič" } },
  _SHAR: { software: FH, category: "event", meaning: { en: "shared event — witness reference", sl: "deljen dogodek — sklic na pričo" } },

  // ── Attributes ────────────────────────────────────────────────────────────
  _ATTR: { software: FH, category: "attribute", meaning: { en: "custom attribute", sl: "atribut po meri" } },
  _NMAR: { software: BK, category: "attribute", meaning: { en: "person never married", sl: "oseba ni bila nikoli poročena" } },
  _NLIV: { software: FH, category: "attribute", meaning: { en: "person is not living", sl: "oseba ni več živa" } },
  _HEIG: { software: BK, category: "attribute", meaning: { en: "height", sl: "višina" } },
  _WEIG: { software: BK, category: "attribute", meaning: { en: "weight", sl: "teža" } },
  _PRMN: { software: BK, category: "attribute", meaning: { en: "permanent number / phone", sl: "stalna številka / telefon" } },
  _ADNA: { software: BK, category: "attribute", meaning: { en: "DNA reference", sl: "sklic na DNK" } },
  _PRIV: { software: `${MH}/${BK}`, category: "attribute", meaning: { en: "private flag — exclude from publishing", sl: "zasebno — izloči iz objave" } },
  _TODO: { software: `${BK}/${FH}`, category: "attribute", meaning: { en: "research to-do item", sl: "raziskovalna naloga" } },
  _LOCL: { software: FH, category: "attribute", meaning: { en: "to-do locality", sl: "kraj raziskovalne naloge" } },
  _ADPF: { software: BK, category: "attribute", meaning: { en: "adopted by father", sl: "posvojil oče" } },
  _ADPM: { software: BK, category: "attribute", meaning: { en: "adopted by mother", sl: "posvojila mati" } },
  _MEMR: { software: BK, category: "attribute", meaning: { en: "memories note", sl: "spomini" } },
  _SEX: { software: FH, category: "attribute", meaning: { en: "extended sex value", sl: "razširjena oznaka spola" } },
  _WEBTAG: { software: FH, category: "attribute", meaning: { en: "web link", sl: "spletna povezava" } },
  _EMAIL: { software: MULTI, category: "attribute", meaning: { en: "e-mail address", sl: "e-poštni naslov" } },

  // ── Name forms ────────────────────────────────────────────────────────────
  _MARNM: { software: MULTI, category: "name", meaning: { en: "married surname", sl: "priimek po poroki" } },
  _AKA: { software: MULTI, category: "name", meaning: { en: "also-known-as name", sl: "znan(a) tudi kot" } },
  _AKAN: { software: BK, category: "name", meaning: { en: "also-known-as name", sl: "znan(a) tudi kot" } },
  _BIRN: { software: BK, category: "name", meaning: { en: "birth name", sl: "rojstno ime" } },
  _MARN: { software: BK, category: "name", meaning: { en: "married name", sl: "ime po poroki" } },
  _OTHN: { software: BK, category: "name", meaning: { en: "other name", sl: "drugo ime" } },
  _SHON: { software: BK, category: "name", meaning: { en: "shown name (display form)", sl: "prikazno ime" } },
  _FARN: { software: BK, category: "name", meaning: { en: "farm/house name (vulgo)", sl: "domače/hišno ime (vulgo)" } },
  _CURN: { software: BK, category: "name", meaning: { en: "current name", sl: "sedanje ime" } },
  _INDG: { software: BK, category: "name", meaning: { en: "indexed given name", sl: "indeksirano ime" } },
  _ADPN: { software: BK, category: "name", meaning: { en: "adoptive name", sl: "ime po posvojitvi" } },
  _SLDN: { software: BK, category: "name", meaning: { en: "soldier name", sl: "vojaško ime" } },
  _FORMERNAME: { software: `${FH}/${MH}`, category: "name", meaning: { en: "former name", sl: "prejšnje ime" } },
  _RNAME: { software: MH, category: "name", meaning: { en: "religious name", sl: "redovniško ime" } },
  _RUFNAME: { software: "Gramps", category: "name", meaning: { en: "call name (Rufname)", sl: "klicno ime" } },
  _CALL: { software: MULTI, category: "name", meaning: { en: "call name", sl: "klicno ime" } },
  _NICK: { software: FH, category: "name", meaning: { en: "nickname", sl: "vzdevek" } },
  _USED: { software: FH, category: "name", meaning: { en: "used name", sl: "uporabljano ime" } },
  _FRKA: { software: FH, category: "name", meaning: { en: "formerly known as", sl: "prej znan(a) kot" } },

  // ── Media / photo metadata ────────────────────────────────────────────────
  _PRIM: { software: MULTI, category: "media", meaning: { en: "primary photo flag", sl: "glavna fotografija" } },
  _PHOTO: { software: MH, category: "media", meaning: { en: "primary photo reference", sl: "sklic na glavno fotografijo" } },
  _PHOTO_RIN: { software: MH, category: "media", meaning: { en: "photo record number", sl: "številka fotografije" } },
  _FILESIZE: { software: MH, category: "media", meaning: { en: "media file size", sl: "velikost datoteke" } },
  _POSITION: { software: MH, category: "media", meaning: { en: "photo crop rectangle", sl: "izrez fotografije" } },
  _CUTOUT: { software: MH, category: "media", meaning: { en: "cropped-from-parent-photo flag", sl: "izrez iz nadrejene fotografije" } },
  _PRIM_CUTOUT: { software: MH, category: "media", meaning: { en: "primary cutout flag", sl: "glavni izrez" } },
  _PARENTRIN: { software: MH, category: "media", meaning: { en: "parent photo record number", sl: "številka nadrejene fotografije" } },
  _PERSONALPHOTO: { software: MH, category: "media", meaning: { en: "personal photo flag", sl: "osebna fotografija" } },
  _PARENTPHOTO: { software: MH, category: "media", meaning: { en: "parent photo flag", sl: "nadrejena fotografija" } },
  _ALBUM: { software: MH, category: "media", meaning: { en: "photo album reference", sl: "sklic na album" } },
  _PRIN: { software: MH, category: "media", meaning: { en: "album photo record number", sl: "številka fotografije v albumu" } },
  _SCAN: { software: MH, category: "media", meaning: { en: "scanned-document flag", sl: "skeniran dokument" } },
  _DESC: { software: MH, category: "media", meaning: { en: "album description", sl: "opis albuma" } },
  _SEQ: { software: FH, category: "media", meaning: { en: "media display order", sl: "vrstni red predstavnosti" } },
  _KEYS: { software: FH, category: "media", meaning: { en: "media keywords", sl: "ključne besede predstavnosti" } },
  _ASID: { software: FH, category: "media", meaning: { en: "photo face/area set ID", sl: "ID območja na fotografiji" } },
  _AREA: { software: FH, category: "media", meaning: { en: "photo face/area rectangle", sl: "območje na fotografiji" } },
  _NOTE: { software: FH, category: "media", meaning: { en: "media note", sl: "opomba k predstavnosti" } },
  _EXCL: { software: FH, category: "media", meaning: { en: "exclude from reports", sl: "izloči iz poročil" } },
  _SCBK: { software: RM, category: "media", meaning: { en: "scrapbook flag", sl: "album izrezkov" } },
  _THUM: { software: WT, category: "media", meaning: { en: "use as thumbnail", sl: "uporabi kot sličico" } },
  _CROP: { software: ANC, category: "media", meaning: { en: "photo crop region", sl: "izrez fotografije" } },
  _WDTH: { software: ANC, category: "media", meaning: { en: "image width", sl: "širina slike" } },
  _HGHT: { software: ANC, category: "media", meaning: { en: "image height", sl: "višina slike" } },
  _LEFT: { software: ANC, category: "media", meaning: { en: "crop left offset", sl: "levi odmik izreza" } },
  _TOP: { software: ANC, category: "media", meaning: { en: "crop top offset", sl: "zgornji odmik izreza" } },
  _STYPE: { software: ANC, category: "media", meaning: { en: "media file type", sl: "vrsta datoteke" } },
  _SIZE: { software: ANC, category: "media", meaning: { en: "media file size", sl: "velikost datoteke" } },
  _MTYPE: { software: ANC, category: "media", meaning: { en: "media kind (photo/document…)", sl: "vrsta predstavnosti (fotografija/dokument …)" } },
  _ORIG: { software: ANC, category: "media", meaning: { en: "media origin collection", sl: "izvorna zbirka" } },
  _FACE: { software: ANC, category: "media", meaning: { en: "face tag reference", sl: "oznaka obraza" } },
  _PLACE: { software: MH, category: "media", meaning: { en: "media place", sl: "kraj predstavnosti" } },
  _DATE: { software: MULTI, category: "media", meaning: { en: "media/source date", sl: "datum predstavnosti/vira" } },

  // ── Source / citation ─────────────────────────────────────────────────────
  _ITALIC: { software: BK, category: "citation", meaning: { en: "print source title in italics", sl: "naslov vira v ležečem tisku" } },
  _PAREN: { software: BK, category: "citation", meaning: { en: "print source in parentheses", sl: "vir v oklepajih" } },
  _QUAL: { software: `${RM}/${MFT}`, category: "citation", meaning: { en: "citation quality", sl: "kakovost navedbe" } },
  _INFO: { software: `${RM}/${MFT}`, category: "citation", meaning: { en: "citation information type", sl: "vrsta podatka navedbe" } },
  _SOUR: { software: MFT, category: "citation", meaning: { en: "citation source type", sl: "vrsta vira navedbe" } },
  _TMPLT: { software: RM, category: "citation", meaning: { en: "source template fields", sl: "polja predloge vira" } },
  _BIBL: { software: RM, category: "citation", meaning: { en: "bibliography form", sl: "bibliografska oblika" } },
  _SUBQ: { software: RM, category: "citation", meaning: { en: "short-form citation", sl: "kratka navedba" } },
  _EVDEF: { software: RM, category: "citation", meaning: { en: "event sentence definition", sl: "definicija stavka dogodka" } },
  _MEDI: { software: MH, category: "citation", meaning: { en: "source media reference", sl: "sklic na predstavnost vira" } },
  _FIELD: { software: FH, category: "citation", meaning: { en: "source template field", sl: "polje predloge vira" } },
  _SRCT: { software: FH, category: "citation", meaning: { en: "source template reference", sl: "sklic na predlogo vira" } },
  _FOOT: { software: FH, category: "citation", meaning: { en: "footnote form", sl: "oblika opombe" } },
  _ABBR: { software: FH, category: "citation", meaning: { en: "abbreviated source name", sl: "okrajšano ime vira" } },
  _TYPE: { software: MULTI, category: "citation", meaning: { en: "vendor type qualifier", sl: "vrsta po meri" } },

  // ── Software-internal bookkeeping ─────────────────────────────────────────
  _UPD: { software: MH, category: "internal", meaning: { en: "last-updated timestamp", sl: "časovni žig zadnje spremembe" } },
  _RINS: { software: MH, category: "internal", meaning: { en: "record-number summary", sl: "povzetek številk zapisov" } },
  _RTLSAVE: { software: MH, category: "internal", meaning: { en: "right-to-left save marker", sl: "oznaka shranjevanja od desne proti levi" } },
  _PROJECT_GUID: { software: MH, category: "internal", meaning: { en: "project identifier", sl: "identifikator projekta" } },
  _EXPORTED_FROM_SITE_ID: { software: MH, category: "internal", meaning: { en: "exporting site ID", sl: "ID izvornega spletnega mesta" } },
  _DESCRIPTION_AWARE: { software: MH, category: "internal", meaning: { en: "export format marker", sl: "oznaka oblike izvoza" } },
  _TIMEZONE: { software: MH, category: "internal", meaning: { en: "export time zone", sl: "časovni pas izvoza" } },
  _SM_MERGES: { software: MH, category: "internal", meaning: { en: "Smart-Match merge counter", sl: "števec združitev Smart Match" } },
  _DISABLED: { software: MH, category: "internal", meaning: { en: "publish disabled flag", sl: "objava onemogočena" } },
  _SITEADDRESS: { software: MH, category: "internal", meaning: { en: "published site address", sl: "naslov objavljenega mesta" } },
  _SITENAME: { software: MH, category: "internal", meaning: { en: "published site name", sl: "ime objavljenega mesta" } },
  _SITEID: { software: MH, category: "internal", meaning: { en: "published site ID", sl: "ID objavljenega mesta" } },
  _DESCRIPTION: { software: MH, category: "internal", meaning: { en: "note edit marker", sl: "oznaka urejanja opombe" } },
  _EVN: { software: BK, category: "internal", meaning: { en: "event sequence number", sl: "zaporedna številka dogodka" } },
  _FLGS: { software: BK, category: "internal", meaning: { en: "user flag set", sl: "uporabniške zastavice" } },
  _COLOR: { software: FH, category: "internal", meaning: { en: "display color", sl: "barva prikaza" } },
  _ROOT: { software: FH, category: "internal", meaning: { en: "file root person", sl: "izhodiščna oseba datoteke" } },
  _VAR: { software: MULTI, category: "internal", meaning: { en: "program variant marker", sl: "oznaka različice programa" } },
  _SCHEMA: { software: FTM, category: "internal", meaning: { en: "custom fact schema", sl: "shema dejstev po meri" } },
  _LIST: { software: BK, category: "internal", meaning: { en: "mailing-list flag", sl: "zastavica seznama" } },
  _CLON: { software: ANC, category: "internal", meaning: { en: "cloned media bookkeeping", sl: "evidenca podvojene predstavnosti" } },
  _OID: { software: ANC, category: "internal", meaning: { en: "media object ID", sl: "ID predstavnostnega objekta" } },
  _TID: { software: ANC, category: "internal", meaning: { en: "source tree ID", sl: "ID izvornega drevesa" } },
  _PID: { software: ANC, category: "internal", meaning: { en: "source person ID", sl: "ID izvorne osebe" } },
  _MSER: { software: ANC, category: "internal", meaning: { en: "media series bookkeeping", sl: "evidenca serije predstavnosti" } },
  _LKID: { software: ANC, category: "internal", meaning: { en: "media link ID", sl: "ID povezave predstavnosti" } },
  _META: { software: ANC, category: "internal", meaning: { en: "media metadata XML", sl: "metapodatki predstavnosti (XML)" } },
  _ATL: { software: ANC, category: "internal", meaning: { en: "attached-to-list flag", sl: "zastavica pripetosti" } },
  _CREA: { software: ANC, category: "internal", meaning: { en: "creation timestamp", sl: "časovni žig nastanka" } },
  _URL: { software: ANC, category: "internal", meaning: { en: "media source URL", sl: "URL vira predstavnosti" } },
  _DSCR: { software: ANC, category: "internal", meaning: { en: "media source description", sl: "opis vira predstavnosti" } },
  _TREE: { software: ANC, category: "internal", meaning: { en: "source tree name", sl: "ime izvornega drevesa" } },
  _ENV: { software: ANC, category: "internal", meaning: { en: "export environment", sl: "okolje izvoza" } },
  _PLAC: { software: `${FH}/${MFT}`, category: "internal", meaning: { en: "place-dictionary record", sl: "zapis imenika krajev" } },
  _GEO: { software: MFT, category: "internal", meaning: { en: "GeoNames place ID", sl: "GeoNames ID kraja" } },
  _EVENT_DEFN: { software: "PAF", category: "internal", meaning: { en: "custom event definition", sl: "definicija dogodka po meri" } },
  _NAME: { software: "Legacy", category: "internal", meaning: { en: "address name line", sl: "imenska vrstica naslova" } },
  _STO: { software: MFT, category: "internal", meaning: { en: "storage location record", sl: "zapis mesta hrambe" } },
  _STS: { software: MFT, category: "internal", meaning: { en: "storage state", sl: "stanje hrambe" } },
  _LABL: { software: MFT, category: "internal", meaning: { en: "label record", sl: "zapis oznake" } },
  _BKM: { software: MFT, category: "internal", meaning: { en: "bookmark", sl: "zaznamek" } },
  _SIF: { software: MFT, category: "internal", meaning: { en: "media bookkeeping", sl: "evidenca predstavnosti" } },
  _SMC: { software: MFT, category: "internal", meaning: { en: "media bookkeeping", sl: "evidenca predstavnosti" } },
  _WT_OBJE_SORT: { software: WT, category: "internal", meaning: { en: "media sort order", sl: "vrstni red predstavnosti" } },

  // ── MacFamilyTree non-underscore vendor tags ──────────────────────────────
  // MacFamilyTree exports several custom facts as bare (non-`_`) tags borrowed
  // from GEDCOM 5.5-EL or invented; without these entries the health check
  // would flag a MacFamilyTree file's own data as "unknown tags".
  RACE: { software: MFT, category: "attribute", meaning: { en: "race / ethnicity", sl: "rasa / etnična pripadnost" } },
  SECG: { software: MFT, category: "name", meaning: { en: "second given name", sl: "drugo rojstno ime" } },
  MISE: { software: MFT, category: "event", meaning: { en: "military service", sl: "vojaška služba" } },
  NOBI: { software: MFT, category: "event", meaning: { en: "award / nobility title (5.5-EL)", sl: "priznanje / plemiški naziv (5.5-EL)" } },
  PRIV: { software: MFT, category: "internal", meaning: { en: "private-note flag", sl: "oznaka zasebne opombe" } },
  LATR: { software: MFT, category: "event", meaning: { en: "legal transaction", sl: "pravni posel" } },
};

/** MacFamilyTree source/place template machinery — one shared classification. */
const MFT_TEMPLATE_TAGS = new Set([
  "_STE", "_STF", "_PTE", "_PTF", "_SCS", "_LCS", "_VCS", "_NCS", "_ORD", "_ACT",
  "_NKY", "_FOM", "_BRM", "_TAG", "_TTL", "_DAT", "_TYP", "_LNA", "_USA", "_INA",
  "_FAV", "_DEF", "_PRS", "_PEDW", "_PEDH",
]);
const MFT_TEMPLATE_INFO: VendorTagInfo = {
  software: MFT,
  category: "internal",
  meaning: { en: "source/place template machinery", sl: "predloge virov/krajev" },
};

/** Account traces that must never leave the user's machine in a shared file. */
const PRIVACY_INFO: Record<string, VendorTagInfo> = {
  _PUBLISH: { software: MH, category: "privacy", meaning: { en: "site publish configuration (contains account e-mail)", sl: "nastavitve objave (vsebujejo e-pošto računa)" } },
  _USERNAME: { software: MH, category: "privacy", meaning: { en: "account user name / e-mail", sl: "uporabniško ime / e-pošta računa" } },
  _USER: { software: ANC, category: "privacy", meaning: { en: "account token", sl: "žeton računa" } },
  _ENCR: { software: ANC, category: "privacy", meaning: { en: "encrypted account token", sl: "šifriran žeton računa" } },
  _WT_USER: { software: WT, category: "privacy", meaning: { en: "editing user name", sl: "uporabniško ime urejevalca" } },
};

/** Vendor tags carrying account traces — the privacy scrub removes these. */
export const VENDOR_PRIVACY_TAGS: Set<string> = new Set(Object.keys(PRIVACY_INFO));

/**
 * Vendor tags that are pure synonyms of another (better-supported) tag: the
 * normalization pass rewrites the key to the value so the rest of the app only
 * ever sees the canonical form. `_MILI` is Brother's Keeper's older spelling of
 * its `_MILT` military-service event. Deliberately conservative — only alias a
 * tag when the two are the same fact in the same shape; anything needing value
 * or structure translation belongs to a real normalization step instead
 * (see `normalize/familyStatus.ts` for the _NMR/_MARRIED/_FREL/_MREL rules).
 * `_SEPR` is Brother's Keeper's separation event — same DATE/PLAC shape as
 * the standard `SEPA` family event the app already supports.
 */
export const VENDOR_TAG_ALIASES: Record<string, string> = {
  _MILI: "_MILT",
  _SEPR: "SEPA",
  // MacFamilyTree's bare military-service fact — same value-event shape.
  MISE: "_MILT",
};

/**
 * HEAD>SOUR system ids of the programs whose native tags appear in
 * `VENDOR_TAG_ALIASES`, mapped to their registry software names. Only those
 * programs need entries — the map exists solely to feed `nativeAliasTags`.
 */
const HEAD_SOUR_SOFTWARE: Record<string, string> = {
  SYNIUMFAMILYTREE: MFT,
  MACFAMILYTREE: MFT,
  BROSKEEP: BK,
};

/**
 * Alias source-tags that are the *native dialect* of the file's own producing
 * software (per its HEAD>SOUR id) and whose canonical target is foreign to it.
 * The bulk-normalize tool skips these renames when re-rendering the main file
 * to its own house style: a MacFamilyTree file keeps its native `MISE`
 * (rewriting it to `_MILT` would make a re-import into MacFamilyTree lose the
 * military-service fact), while `_MILI` → `_MILT` still runs on a Brother's
 * Keeper file because both spellings are BK's own. Compare-file normalization
 * ignores this — there the goal is the app's canonical form, not round-trip
 * fidelity with the compare file's producer.
 */
export function nativeAliasTags(headSour: string | undefined): Set<string> {
  const keep = new Set<string>();
  const software = headSour ? HEAD_SOUR_SOFTWARE[headSour.trim().toUpperCase()] : undefined;
  if (!software) return keep;
  for (const [src, dst] of Object.entries(VENDOR_TAG_ALIASES)) {
    const srcNative = VENDOR_TAGS[src]?.software.includes(software) ?? false;
    const dstNative = VENDOR_TAGS[dst]?.software.includes(software) ?? false;
    if (srcNative && !dstNative) keep.add(src);
  }
  return keep;
}

/**
 * Classify a vendor-extension tag. Exact matches first, then the numbered /
 * prefixed families some programs emit (`__FLAG_3`, `_FA1`…`_FA13`,
 * `_COLOR2`, `_LIST6`, PAF `_SEN*` sentence templates).
 */
export function vendorTagInfo(tag: string): VendorTagInfo | undefined {
  const exact = PRIVACY_INFO[tag] ?? VENDOR_TAGS[tag];
  if (exact) return exact;
  if (MFT_TEMPLATE_TAGS.has(tag)) return MFT_TEMPLATE_INFO;
  if (/^__FLAG_\d+$/.test(tag)) return VENDOR_TAGS._FLGS;
  if (/^_FA\d+$/.test(tag)) {
    return { software: FTM, category: "internal", meaning: { en: "custom fact link", sl: "povezava dejstva po meri" } };
  }
  if (/^_COLOR\d+$/.test(tag)) return VENDOR_TAGS._COLOR;
  if (/^_LIST\d+$/.test(tag)) return VENDOR_TAGS._LIST;
  if (/^_SEN[A-Z]*$/.test(tag) || tag === "_DATE_TYPE" || tag === "_PLACE_TYPE" || tag === "_DESC_FLAG" || tag === "_CONF_FLAG") {
    return { software: "PAF", category: "internal", meaning: { en: "event sentence template", sl: "predloga stavka dogodka" } };
  }
  return undefined;
}
