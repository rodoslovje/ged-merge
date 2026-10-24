import { namedVendorTags, vendorTagInfo, type VendorTagCategory } from "./vendorTags.ts";

/**
 * The documentation behind every URI a GEDCOM 7 header's `HEAD.SCHMA` gets
 * from the app for an extension tag the FamilySearch registry does not cover
 * (see `extensionRegistry.ts`): one page per tag and program, at
 *
 *     https://gedmerge.com/terms/<vendor>/<TAG>
 *
 * where `<vendor>` is the program whose tag it is — the file's own producer
 * (`HEAD.SOUR`) where the vendor-tag registry says it writes the tag, else the
 * program the registry names. A tag no table knows points under `unknown/`,
 * at a page that says so. The pages are built from these tables at build time
 * (`src/terms/`), so a URI the writer can emit always has one.
 */

export const TERMS_ORIGIN = "https://gedmerge.com";

/** A program the terms pages are grouped by. */
export interface TermsVendor {
  slug: string;
  name: string;
  /** Upper-cased `HEAD.SOUR` system ids the program writes. */
  sour: readonly string[];
}

/** The programs of the vendor-tag registry, plus this app, "several
 *  programs" and the unknown. In the order the index lists them. */
export const TERMS_VENDORS: readonly TermsVendor[] = [
  { slug: "myheritage", name: "MyHeritage", sour: ["MYHERITAGE"] },
  { slug: "ancestry", name: "Ancestry", sour: ["ANCESTRY.COM FAMILY TREES", "ANCESTRY.COM", "ANCESTRY"] },
  { slug: "ftm", name: "Family Tree Maker", sour: ["FTM", "FTW", "FAMILY TREE MAKER"] },
  { slug: "familysearch", name: "FamilySearch", sour: ["FAMILYSEARCH", "FAMILYSEARCH FAMILY TREE"] },
  { slug: "rootsmagic", name: "RootsMagic", sour: ["ROOTSMAGIC"] },
  { slug: "legacy", name: "Legacy", sour: ["LEGACY"] },
  { slug: "familyhistorian", name: "Family Historian", sour: ["FAMILY_HISTORIAN", "FAMILY HISTORIAN"] },
  { slug: "macfamilytree", name: "MacFamilyTree", sour: ["MACFAMILYTREE", "SYNIUMFAMILYTREE"] },
  { slug: "gramps", name: "Gramps", sour: ["GRAMPS"] },
  { slug: "webtrees", name: "webtrees", sour: ["WEBTREES"] },
  { slug: "brotherskeeper", name: "Brother's Keeper", sour: ["BROSKEEP", "BROTHER'S KEEPER"] },
  { slug: "paf", name: "PAF", sour: ["PAF"] },
  { slug: "gedmerge", name: "GED Merge", sour: ["GEDMERGE"] },
  { slug: "common", name: "Several programs", sour: [] },
  { slug: "unknown", name: "Unknown program", sour: [] },
];

/** The vendor-tag registry's software names → slug. */
const SOFTWARE_SLUG: Record<string, string> = {
  "MyHeritage": "myheritage",
  "Ancestry": "ancestry",
  "Family Tree Maker": "ftm",
  "FamilySearch": "familysearch",
  "RootsMagic": "rootsmagic",
  "Legacy": "legacy",
  "Family Historian": "familyhistorian",
  "MacFamilyTree": "macfamilytree",
  "Gramps": "gramps",
  "webtrees": "webtrees",
  "Brother's Keeper": "brotherskeeper",
  "PAF": "paf",
  "multiple programs": "common",
};

/** The slugs a page is written for when a tag is "multiple programs'": each
 *  real program's, and `common` for a file from none of them. */
const PROGRAM_SLUGS = TERMS_VENDORS.map((v) => v.slug).filter((s) => s !== "gedmerge" && s !== "unknown");

/** The terms vendor of a file's `HEAD.SOUR` system id, if it is a known one. */
export function producerSlug(headSour: string | undefined): string | undefined {
  const id = headSour?.trim().toUpperCase();
  if (!id) return undefined;
  return TERMS_VENDORS.find((v) => v.sour.includes(id))?.slug;
}

/** A tag's GEDCOM 7 standard counterpart, and whether the app's conversion to
 *  7.0 writes it in the tag's place (`normalize/migrate.ts`). */
export interface StandardForm {
  form: string;
  converted: boolean;
}

const FS_EXID = "EXID with TYPE https://www.familysearch.org/tree/person/";

/** Extension tags with a standard GEDCOM 7 counterpart. */
export const STANDARD_FORMS: Record<string, StandardForm> = {
  _UID: { form: "UID", converted: true },
  _FID: { form: FS_EXID, converted: true },
  _FSFTID: { form: FS_EXID, converted: true },
  _MARNM: { form: "a NAME of its own with TYPE MARRIED", converted: true },
  _NO: { form: "NO", converted: true },
  _SDATE: { form: "SDATE", converted: true },
  _MIME: { form: "NOTE.MIME", converted: true },
  _LANG: { form: "NOTE.LANG", converted: true },
  _TRAN: { form: "NOTE.TRAN", converted: true },
  _SEX: { form: "SEX X", converted: true },
  _CREA: { form: "CREA with a DATE", converted: false },
  _PRIV: { form: "RESN PRIVACY", converted: false },
  _AKA: { form: "a NAME of its own with TYPE AKA", converted: false },
  _AKAN: { form: "a NAME of its own with TYPE AKA", converted: false },
  _BIRN: { form: "a NAME of its own with TYPE BIRTH", converted: false },
  _MARN: { form: "a NAME of its own with TYPE MARRIED", converted: false },
  _NICK: { form: "NAME.NICK", converted: false },
  _EMAIL: { form: "EMAIL", converted: false },
  _WEBTAG: { form: "WWW", converted: false },
  _PEDI: { form: "FAMC.PEDI", converted: false },
};

/** One of the app's own extension tags: what it writes where a version has
 *  no standard structure for the content. */
export interface OwnTag {
  tag: string;
  meaning: { en: string; sl: string };
  /** Where it appears, in English. */
  context: string;
}

/** The extension tags GED Merge itself writes. */
export const GEDMERGE_TAGS: readonly OwnTag[] = [
  {
    tag: "_SUBN",
    meaning: {
      en: "a GEDCOM 5.5.1 submission record (SUBN), kept when the file is converted to GEDCOM 7.0, which has no such record",
      sl: "zapis o oddaji (SUBN) iz GEDCOM 5.5.1, ohranjen ob pretvorbi datoteke v GEDCOM 7.0, ki takega zapisa nima",
    },
    context: "a record of its own (level 0), and the header's line that points to it (HEAD._SUBN)",
  },
  {
    tag: "_UID",
    meaning: {
      en: "the record's unique identifier (GEDCOM 7.0 UID), kept in a GEDCOM 5.5.1 file",
      sl: "enolični identifikator zapisa (UID iz GEDCOM 7.0), ohranjen v datoteki GEDCOM 5.5.1",
    },
    context: "on a record or an event, where GEDCOM 7.0 writes UID",
  },
  {
    tag: "_FSFTID",
    meaning: {
      en: "a FamilySearch Family Tree person ID (GEDCOM 7.0 EXID of the FamilySearch type), kept in a GEDCOM 5.5.1 file",
      sl: "ID osebe v drevesu FamilySearch (EXID vrste FamilySearch iz GEDCOM 7.0), ohranjen v datoteki GEDCOM 5.5.1",
    },
    context: "on a person record (INDI)",
  },
  {
    tag: "_CREA",
    meaning: {
      en: "when the record was created (GEDCOM 7.0 CREA), kept in a GEDCOM 5.5.1 file",
      sl: "datum nastanka zapisa (CREA iz GEDCOM 7.0), ohranjen v datoteki GEDCOM 5.5.1",
    },
    context: "on a record, with a DATE line under it",
  },
  {
    tag: "_NO",
    meaning: {
      en: "an event that did not happen (GEDCOM 7.0 NO), kept in a GEDCOM 5.5.1 file",
      sl: "dogodek, ki se ni zgodil (NO iz GEDCOM 7.0), ohranjen v datoteki GEDCOM 5.5.1",
    },
    context: "on a person or a family record; its value is the event's tag (NO MARR)",
  },
  {
    tag: "_SDATE",
    meaning: {
      en: "the date an event is sorted by (GEDCOM 7.0 SDATE), kept in a GEDCOM 5.5.1 file",
      sl: "datum, po katerem se dogodek razvršča (SDATE iz GEDCOM 7.0), ohranjen v datoteki GEDCOM 5.5.1",
    },
    context: "under an event",
  },
  {
    tag: "_MIME",
    meaning: {
      en: "the media type of a note's text, such as text/html (GEDCOM 7.0 NOTE.MIME), kept in a GEDCOM 5.5.1 file",
      sl: "vrsta vsebine besedila opombe, na primer text/html (MIME iz GEDCOM 7.0), ohranjena v datoteki GEDCOM 5.5.1",
    },
    context: "under a NOTE or a shared note record",
  },
  {
    tag: "_LANG",
    meaning: {
      en: "the language of a note (GEDCOM 7.0 NOTE.LANG), kept in a GEDCOM 5.5.1 file",
      sl: "jezik opombe (LANG iz GEDCOM 7.0), ohranjen v datoteki GEDCOM 5.5.1",
    },
    context: "under a NOTE or a shared note record",
  },
  {
    tag: "_TRAN",
    meaning: {
      en: "a translation of a note (GEDCOM 7.0 NOTE.TRAN), kept in a GEDCOM 5.5.1 file",
      sl: "prevod opombe (TRAN iz GEDCOM 7.0), ohranjen v datoteki GEDCOM 5.5.1",
    },
    context: "under a NOTE or a shared note record",
  },
  {
    tag: "_SEX",
    meaning: {
      en: "the sex X — does not fit only male or only female (GEDCOM 7.0 SEX X) — kept beside SEX U in a GEDCOM 5.5.1 file",
      sl: "spol »Drugo« (SEX X iz GEDCOM 7.0) za osebo, ki ni samo moškega ali samo ženskega spola, ohranjen ob SEX U v datoteki GEDCOM 5.5.1",
    },
    context: "under SEX",
  },
  {
    tag: "_FILN",
    meaning: {
      en: "a source's filing number — the archive's id for it (GEDCOM 5.5-EL FILN), which neither GEDCOM 5.5.1 nor 7.0 has",
      sl: "arhivska številka vira (FILN iz GEDCOM 5.5-EL), ki je ne pozna ne GEDCOM 5.5.1 ne 7.0",
    },
    context: "on a source record (SOUR)",
  },
  {
    tag: "_PERI",
    meaning: {
      en: "the periodical or collection a source belongs to (GEDCOM 5.5-EL PERI), which neither GEDCOM 5.5.1 nor 7.0 has",
      sl: "periodika ali zbirka, v katero sodi vir (PERI iz GEDCOM 5.5-EL), ki je ne pozna ne GEDCOM 5.5.1 ne 7.0",
    },
    context: "on a source record (SOUR)",
  },
];

const OWN_BY_TAG = new Map(GEDMERGE_TAGS.map((t) => [t.tag, t]));

/** Where a category's tags appear, for a tag never seen in the sample files. */
const CATEGORY_CONTEXT: Record<VendorTagCategory, string> = {
  identity: "on a record — a person, a family or a source",
  familyStatus: "on a family record (FAM), or on a child's link to it",
  event: "on a person or a family record, as an event with its own date and place",
  attribute: "on a person record (INDI)",
  name: "under a person's NAME",
  media: "on a media object (OBJE) or a link to one",
  citation: "on a source record or a citation (SOUR)",
  internal: "wherever the program keeps its own bookkeeping — the header, a record or one of its lines",
  privacy: "in the header or on a record; it carries account details",
};

/** A category's name on the pages. */
export const CATEGORY_LABEL: Record<VendorTagCategory, string> = {
  identity: "Identifier",
  familyStatus: "Family or pedigree status",
  event: "Event",
  attribute: "Fact about the person",
  name: "Name form",
  media: "Media",
  citation: "Source or citation",
  internal: "Program bookkeeping",
  privacy: "Account details",
};

/**
 * Where each tag was found in the files the vendor-tag registry was surveyed
 * from (the test corpus and the genealogical-index submissions): the parent
 * paths it stood under most often, record tag first; `""` is a record of its
 * own (level 0).
 */
export const SEEN_IN: Record<string, readonly string[]> = {
  _ACT: ["_STE._STF._SCS", "_STE._STF._LCS", "_PTE._PTF._VCS"],
  _ADNA: ["INDI"],
  _ADPF: ["INDI"],
  _ADPN: ["INDI.NAME"],
  _AKA: ["INDI.NAME"],
  _AKAN: ["INDI.NAME"],
  _ALBUM: ["INDI.OBJE", "INDI.DEAT.OBJE", "INDI.NCHI.OBJE"],
  _AMTID: ["INDI"],
  _APID: ["INDI.SOUR", "INDI.NAME.SOUR", "INDI.RESI.SOUR"],
  _AREA: ["INDI.OBJE"],
  _ATL: ["OBJE"],
  _ATTR: ["FAM"],
  _BIBL: ["SOUR"],
  _BIRN: ["INDI.NAME"],
  _BKM: ["INDI", "FAM", "_PLAC"],
  _BRM: ["_STE._STF._LCS", "_STE._STF._SCS"],
  _CALL: ["INDI.NAME"],
  _CLON: ["OBJE"],
  _COLOR: ["INDI"],
  _COLOR1: ["INDI"],
  _COLOR2: ["INDI"],
  _COLOR3: ["INDI"],
  _COLOR4: ["INDI"],
  _COLOR5: ["INDI"],
  _COML: ["FAM"],
  _CREA: ["OBJE"],
  _CROP: ["INDI.OBJE"],
  _CURN: ["INDI.NAME"],
  _CUTOUT: ["INDI.OBJE"],
  _DAT: ["_STE._STF"],
  _DATE: ["OBJE", "OBJE._CLON", "INDI.OBJE"],
  _DEF: ["_PTE", "_STE"],
  _DEG: ["INDI"],
  _DESC: ["ALBUM"],
  _DESCRIPTION: ["INDI.EVEN.NOTE", "FAM.MARR.NOTE", "INDI.BIRT.NOTE"],
  _DESCRIPTION_AWARE: [""],
  _DISABLED: ["_PUBLISH"],
  _DSCR: ["OBJE"],
  _ELEC: ["INDI"],
  _EMAIL: ["INDI"],
  _EMPLOY: ["INDI"],
  _ENCR: ["OBJE._USER", "OBJE._CLON._USER"],
  _ENV: ["HEAD.SOUR._TREE"],
  _EVDEF: [""],
  _EVN: ["FAM.MARR"],
  _EXCL: ["INDI.OBJE"],
  _EXPORTED_FROM_SITE_ID: [""],
  _FARN: ["INDI.NAME"],
  _FAV: ["_STE", "_PTE"],
  _FID: ["INDI", "OBJE"],
  _FIELD: ["SOUR"],
  _FILESIZE: ["INDI.OBJE", "INDI.BIRT.OBJE", "INDI.DEAT.OBJE"],
  _FNRL: ["INDI"],
  _FOM: ["_STE._STF._LCS", "_STE._STF._SCS"],
  _FORMERNAME: ["INDI.NAME"],
  _FREL: ["FAM.CHIL", "INDI.FAMC"],
  _FRKA: ["INDI.NAME"],
  _FSFTID: ["INDI"],
  _GEO: ["_PLAC"],
  _HGHT: ["OBJE.FILE.FORM", "INDI.OBJE._CROP"],
  _HPID: ["FAM.MARR.SOUR", "FAM.DIV.SOUR"],
  _INA: ["_PTF"],
  _INFO: ["INDI.SOUR._QUAL", "INDI.CENS.SOUR._QUAL", "INDI.BIRT.SOUR._QUAL"],
  _INTE: ["INDI"],
  _ITALIC: ["SOUR"],
  _KEYS: ["OBJE"],
  _LABL: ["INDI", ""],
  _LCS: ["_STE._STF"],
  _LEFT: ["INDI.OBJE._CROP"],
  _LKID: ["OBJE._MSER"],
  _LNA: ["_PTF"],
  _MARNM: ["INDI.NAME"],
  _MARRIED: ["FAM"],
  _MDCL: ["INDI"],
  _MEDC: ["INDI"],
  _MEDI: ["SOUR"],
  _MEMR: ["INDI"],
  _META: ["OBJE"],
  _MILI: ["INDI"],
  _MILT: ["INDI"],
  _MREL: ["FAM.CHIL", "INDI.FAMC"],
  _MSER: ["OBJE"],
  _MSTAT: ["FAM"],
  _MTYPE: ["OBJE.FILE.FORM"],
  _NCS: ["_PTE._PTF"],
  _NKY: ["_STE", "_STF", "_PTF"],
  _NLIV: ["INDI"],
  _NMAR: ["INDI"],
  _NMR: ["FAM"],
  _OID: ["OBJE", "OBJE._CLON"],
  _ORD: ["_STE._STF._SCS", "_STE._STF._LCS", "_PTE._PTF._VCS"],
  _ORIG: ["OBJE"],
  _OTHN: ["INDI.NAME"],
  _PAREN: ["SOUR"],
  _PARENTPHOTO: ["INDI.OBJE"],
  _PARENTRIN: ["INDI.OBJE"],
  _PEDH: ["INDI.FAMC"],
  _PEDI: ["INDI.FAMC"],
  _PEDW: ["INDI.FAMC"],
  _PERSONALPHOTO: ["INDI.OBJE"],
  _PHOTO: ["ALBUM"],
  _PHOTO_RIN: ["INDI.OBJE", "INDI.BIRT.OBJE", "INDI.DEAT.OBJE"],
  _PID: ["OBJE._CLON"],
  _PLAC: ["", "INDI.EMIG", "INDI.IMMI"],
  _PLACE: ["INDI.OBJE", "INDI.BIRT.OBJE", "INDI.EMIG.OBJE"],
  _POSITION: ["INDI.OBJE"],
  _PREF: ["FAM.WIFE", "FAM.HUSB", "FAM.CHIL"],
  _PRIM: ["INDI.OBJE", "OBJE"],
  _PRIM_CUTOUT: ["INDI.OBJE"],
  _PRIN: ["ALBUM._PHOTO"],
  _PRIV: ["INDI"],
  _PRMN: ["INDI"],
  _PROJECT_GUID: [""],
  _PRS: ["FAM"],
  _PTE: ["_PLAC", ""],
  _PTF: ["_PTE", ""],
  _PUBLISH: [""],
  _QUAL: ["INDI.SOUR", "INDI.CENS.SOUR", "INDI.BIRT.SOUR"],
  _RINS: [""],
  _RNAME: ["INDI.NAME"],
  _ROOT: ["HEAD", ""],
  _RTLSAVE: ["HEAD.SOUR"],
  _RUFNAME: ["INDI.NAME"],
  _SCAN: ["INDI.OBJE", "INDI.BIRT.OBJE"],
  _SCS: ["_STE._STF", "_PTE._PTF"],
  _SENT: ["INDI.BIRT"],
  _SEPR: ["FAM"],
  _SEQ: ["INDI.OBJE"],
  _SHAN: ["INDI.BIRT", "FAM.MARR"],
  _SHAR: ["INDI.BIRT"],
  _SIF: ["OBJE"],
  _SITEADDRESS: ["_PUBLISH"],
  _SITEID: ["_PUBLISH"],
  _SITENAME: ["_PUBLISH"],
  _SIZE: ["OBJE.FILE.FORM"],
  _SMC: ["OBJE"],
  _SOUR: ["INDI.CENS.SOUR._QUAL", "INDI.BIRT.SOUR._QUAL"],
  _SRCT: ["SOUR", ""],
  _STAT: ["FAM"],
  _STE: ["SOUR", ""],
  _STF: ["_STE", ""],
  _STO: ["INDI", ""],
  _STS: ["_STO"],
  _STYPE: ["OBJE.FILE.FORM"],
  _SUBQ: ["SOUR"],
  _TAG: ["_PTF", "_STF"],
  _THUM: ["OBJE"],
  _TID: ["OBJE._CLON"],
  _TIMEZONE: ["HEAD.DATE"],
  _TMPLT: ["INDI.SOUR", "INDI.BIRT.SOUR", "INDI.DEAT.SOUR"],
  _TOP: ["INDI.OBJE._CROP"],
  _TREE: ["HEAD.SOUR"],
  _TTL: ["_STE._STF"],
  _TYP: ["_STF"],
  _TYPE: ["SOUR", "INDI.RESI.PHON", "INDI.OBJE._CROP"],
  _UID: ["INDI", "INDI.BIRT", "INDI.DEAT"],
  _UPD: ["INDI", "FAM", "SOUR"],
  _URL: ["OBJE._ORIG"],
  _USA: ["_PTE._PTF"],
  _USED: ["INDI.NAME"],
  _USER: ["OBJE", "OBJE._CLON"],
  _USERNAME: ["_PUBLISH"],
  _VAR: ["HEAD.GEDC", "HEAD.GEDC"],
  _VCS: ["_PTE._PTF"],
  _WDTH: ["OBJE.FILE.FORM", "INDI.OBJE._CROP"],
  _WEBTAG: ["INDI"],
  _WPID: ["FAM.MARR.SOUR", "FAM.DIV.SOUR"],
  _WT_USER: ["INDI.CHAN", "FAM.CHAN", "OBJE.CHAN"],
};

/** One terms page: a tag as one program writes it. */
export interface TermsEntry {
  vendor: string;
  tag: string;
  meaning: { en: string; sl?: string };
  /** The program as the vendor-tag registry names it (`MacFamilyTree/FamilySearch`). */
  software: string;
  category?: VendorTagCategory;
  /** Where it appears: parent paths seen in files, or a sentence. */
  seenIn?: readonly string[];
  context: string;
  standard?: StandardForm;
}

let cache: TermsEntry[] | undefined;

/** Every page the terms site has for a tag, sorted by vendor then tag. Each
 *  (vendor, tag) pair is listed once. */
export function termsEntries(): TermsEntry[] {
  if (cache) return cache;
  const out: TermsEntry[] = [];
  for (const tag of namedVendorTags()) {
    const info = vendorTagInfo(tag)!;
    const slugs = info.software === "multiple programs"
      ? PROGRAM_SLUGS
      : [...new Set(info.software.split("/").map((name) => SOFTWARE_SLUG[name]).filter(Boolean))];
    for (const vendor of slugs) {
      out.push({
        vendor, tag, meaning: info.meaning, software: info.software, category: info.category,
        seenIn: SEEN_IN[tag], context: CATEGORY_CONTEXT[info.category], standard: STANDARD_FORMS[tag],
      });
    }
  }
  for (const own of GEDMERGE_TAGS) {
    out.push({ vendor: "gedmerge", tag: own.tag, meaning: own.meaning, software: "GED Merge", context: own.context, standard: STANDARD_FORMS[own.tag] });
  }
  const order = new Map(TERMS_VENDORS.map((v, i) => [v.slug, i]));
  cache = out.sort((a, b) => order.get(a.vendor)! - order.get(b.vendor)! || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  return cache;
}

let vendorsByTag: Map<string, string[]> | undefined;

/** The vendors with a page for `tag` (upper-cased), in table order. */
function pageVendors(tag: string): string[] {
  if (!vendorsByTag) {
    vendorsByTag = new Map();
    for (const e of termsEntries()) {
      const list = vendorsByTag.get(e.tag) ?? [];
      list.push(e.vendor);
      vendorsByTag.set(e.tag, list);
    }
  }
  return vendorsByTag.get(tag) ?? [];
}

/** The site path of a tag's page, without a trailing slash. */
export function termsPath(vendor: string, tag: string): string {
  return `/terms/${vendor}/${encodeURIComponent(tag)}`;
}

/**
 * The GED Merge URI that documents extension `tag` (as the file writes it) in
 * a file produced by `headSour`: the producer's page where it has one for the
 * tag, the app's own for a tag the app writes, else the first program the
 * registry names (`common` for "multiple programs"); `unknown/<tag>` for a
 * tag no table knows.
 */
export function termsUri(tag: string, headSour: string | undefined): string {
  const upper = tag.toUpperCase();
  const vendors = pageVendors(upper);
  // A tag no table knows gets the one page that explains unknown tags, the tag
  // named in the fragment: a URI per tag that resolves on any static host,
  // with no server rule needed for a page that cannot exist ahead of time.
  if (vendors.length === 0) return `${TERMS_ORIGIN}/terms/unknown/#${encodeURIComponent(tag)}`;
  const producer = producerSlug(headSour);
  const info = vendorTagInfo(upper);
  let vendor: string;
  if (producer && vendors.includes(producer)) vendor = producer;
  else if (!info) vendor = "gedmerge";
  else if (info.software === "multiple programs") vendor = "common";
  else vendor = SOFTWARE_SLUG[info.software.split("/")[0]];
  return TERMS_ORIGIN + termsPath(vendor, upper);
}

/** The app's own description of a tag it writes, if it is one. */
export function ownTag(tag: string): OwnTag | undefined {
  return OWN_BY_TAG.get(tag);
}
