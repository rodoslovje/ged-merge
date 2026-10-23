import type { SpecTable } from "./types";

/**
 * The GEDCOM 5.5.1 structure table, typed from the specification's grammar
 * (*The GEDCOM Standard, Release 5.5.1*, chapter 2 "Lineage-Linked Grammar":
 * the record structures and the substructures they include by `<<…>>`, with
 * the `{min:max}` each line carries) and its value definitions (chapter 2,
 * "Primitive elements": the enumerated `SEX_VALUE`, `PEDIGREE_LINKAGE_TYPE`,
 * `CERTAINTY_ASSESSMENT`, … sets). Notation in ./types.
 *
 * Where the grammar offers two shapes for one line (a `SOUR` citation is a
 * pointer *or* a text, and only the text shape has no `PAGE`), the table
 * holds the union of both: the check would rather miss a line in the wrong
 * shape than call a sound one wrong.
 *
 * 5.5.5 and 5.5 differ in a few places, laid over this table by
 * {@link SPEC_555} and {@link SPEC_55}.
 */

/** ADDRESS_STRUCTURE, spliced into the structures that include it. */
const ADDRESS = "ADDR:01 PHON:03 EMAIL:03 FAX:03 WWW:03";
/** CHANGE_DATE, NOTE_STRUCTURE, SOURCE_CITATION, MULTIMEDIA_LINK. */
const CITES = "NOTE:0M SOUR=SOUR-CIT:0M OBJE=OBJE-LINK:0M";
/** EVENT_DETAIL. */
const EVENT_DETAIL = `TYPE:01 DATE:01 PLAC:01 ${ADDRESS} AGNC:01 RELI=TXT:01 CAUS:01 RESN:01 ${CITES}`;
/** INDIVIDUAL_EVENT_DETAIL. */
const INDI_EVENT = `${EVENT_DETAIL} AGE:01`;
/** FAMILY_EVENT_DETAIL. */
const FAM_EVENT = `${EVENT_DETAIL} HUSB=EVEN-SPOUSE:01 WIFE=EVEN-SPOUSE:01`;
/** PERSONAL_NAME_PIECES. */
const NAME_PIECES = "NPFX:01 GIVN:01 NICK:01 SPFX:01 SURN:01 NSFX:01 NOTE:0M SOUR=SOUR-CIT:0M";
/** LDS ordinance lines common to BAPL/CONL/ENDL/SLGC/SLGS. */
const LDS = "DATE:01 TEMP:01 PLAC:01 NOTE:0M SOUR=SOUR-CIT:0M";

/** The individual events of INDIVIDUAL_EVENT_STRUCTURE by structure id. */
const INDI_EVENTS: Record<string, string> = {
  BIRT: "BIRT", CHR: "BIRT", ADOP: "ADOP",
  DEAT: "IEVEN", BURI: "IEVEN", CREM: "IEVEN", BAPM: "IEVEN", BARM: "IEVEN", BASM: "IEVEN",
  BLES: "IEVEN", CHRA: "IEVEN", CONF: "IEVEN", FCOM: "IEVEN", ORDN: "IEVEN", NATU: "IEVEN",
  EMIG: "IEVEN", IMMI: "IEVEN", CENS: "IEVEN", PROB: "IEVEN", WILL: "IEVEN", GRAD: "IEVEN",
  RETI: "IEVEN", EVEN: "IEVEN",
  // INDIVIDUAL_ATTRIBUTE_STRUCTURE: the same detail lines.
  CAST: "IEVEN", DSCR: "IEVEN", EDUC: "IEVEN", IDNO: "IEVEN", NATI: "IEVEN", NCHI: "IEVEN",
  NMR: "IEVEN", OCCU: "IEVEN", PROP: "IEVEN", RELI: "IEVEN", RESI: "IEVEN", SSN: "IEVEN",
  TITL: "IEVEN", FACT: "IEVEN",
};
const FAM_EVENTS = ["ANUL", "CENS", "DIV", "DIVF", "ENGA", "MARB", "MARC", "MARR", "MARL", "MARS", "RESI", "EVEN"];

const each = (tags: Record<string, string> | string[], card: string): string =>
  (Array.isArray(tags) ? tags.map((t) => `${t}=FEVEN`) : Object.entries(tags).map(([t, id]) => `${t}=${id}`))
    .map((c) => `${c}:${card}`)
    .join(" ");

/** Text lines with no children of their own. */
const TEXT_LEAVES = [
  "TXT", "VERS", "NAME", "DEST", "FILE", "COPR", "LANG", "TIME", "ADR1", "ADR2", "ADR3", "CITY",
  "STAE", "POST", "CTRY", "PHON", "EMAIL", "FAX", "WWW", "AGNC", "CAUS", "TYPE", "PAGE", "TEXT",
  "AUTH", "TITL", "ABBR", "PUBL", "RIN", "RFN", "AFN", "LATI", "LONG", "FORM", "NPFX", "GIVN",
  "NICK", "SPFX", "SURN", "NSFX", "TEMP", "FAMF", "ANCE", "DESC", "ORDI", "RELA",
];

export const SPEC_551: SpecTable = {
  version: "5.5.1",
  roots: {
    HEAD: "HEAD", TRLR: "TRLR", INDI: "record-INDI", FAM: "record-FAM", SOUR: "record-SOUR",
    REPO: "record-REPO", OBJE: "record-OBJE", NOTE: "record-NOTE", SUBM: "record-SUBM", SUBN: "record-SUBN",
  },
  structs: {
    ...Object.fromEntries(TEXT_LEAVES.map((t) => [t, ["T", ""]])),
    // ── HEADER
    // HEAD.SUBM is {1:1} in the 5.5.1 grammar, but held as {0:1} here, as 7.0
    // made it: a submitter with no name is noise, so GED Merge's own new file
    // writes none, and a third of the exporters in the test corpus skip it too.
    HEAD: ["", "SOUR=HEAD-SOUR:11 DEST:01 DATE=HEAD-DATE:01 SUBM=SUBM-PTR:01 SUBN=SUBN-PTR:01 FILE:01 COPR:01 GEDC:11 CHAR:11 LANG:01 PLAC=HEAD-PLAC:01 NOTE=TXT:01"],
    "HEAD-SOUR": ["T", "VERS:01 NAME:01 CORP:01 DATA=HEAD-SOUR-DATA:01"],
    CORP: ["T", ADDRESS],
    "HEAD-SOUR-DATA": ["T", "DATE=TXT:01 COPR:01"],
    "HEAD-DATE": ["D", "TIME:01"],
    GEDC: ["", "VERS:11 FORM=GEDC-FORM:11"],
    "GEDC-FORM": ["E:GEDC-FORM", ""],
    CHAR: ["E:CHAR", "VERS:01"],
    "HEAD-PLAC": ["", "FORM:11"],
    TRLR: ["", ""],
    // ── Shared substructures
    ADDR: ["T", "ADR1:01 ADR2:01 ADR3:01 CITY:01 STAE:01 POST:01 CTRY:01"],
    CHAN: ["", "DATE=CHAN-DATE:11 NOTE:0M"],
    "CHAN-DATE": ["D", "TIME:01"],
    DATE: ["D", ""],
    NOTE: ["@NOTE?", "SOUR=SOUR-CIT:0M"],
    "SOUR-CIT": ["@SOUR?", "PAGE:01 EVEN=CIT-EVEN:01 DATA=CIT-DATA:01 QUAY:01 OBJE=OBJE-LINK:0M NOTE:0M TEXT:0M"],
    "CIT-EVEN": ["T", "ROLE:01"],
    ROLE: ["E:ROLE", ""],
    "CIT-DATA": ["", "DATE:01 TEXT:0M"],
    QUAY: ["E:QUAY", ""],
    // The 5.5 shape — FORM beside FILE rather than under it — is what most
    // 5.5.1 exporters still write, and 5.5.1 readers are told to accept it.
    "OBJE-LINK": ["@OBJE?", "FILE=OBJE-FILE:0M FORM=OBJE-FORM:01 TITL:01"],
    "OBJE-FILE": ["T", "FORM=OBJE-FORM:01 TITL:01"],
    "OBJE-FORM": ["T", "MEDI:01 TYPE=MEDI:01"],
    MEDI: ["E:MEDI", ""],
    REFN: ["T", "TYPE:01"],
    RESN: ["E:RESN", ""],
    // SOUR is 5.5's citation of the place itself, kept so a 5.5.1 file that
    // still writes it is not faulted for the older grammar.
    PLAC: ["T", "FORM:01 FONE=PLAC-VARIANT:0M ROMN=PLAC-VARIANT:0M MAP:01 NOTE:0M SOUR=SOUR-CIT:0M"],
    "PLAC-VARIANT": ["T", "TYPE:11"],
    MAP: ["", "LATI:11 LONG:11"],
    AGE: ["A", ""],
    "SUBM-PTR": ["@SUBM", ""],
    "SUBN-PTR": ["@SUBN", ""],
    // ── INDIVIDUAL_RECORD
    "record-INDI": ["", [
      "RESN:01 NAME=INDI-NAME:0M SEX:01", each(INDI_EVENTS, "0M"),
      "BAPL=BAPL:0M CONL=BAPL:0M ENDL:0M SLGC:0M",
      "FAMC=INDI-FAMC:0M FAMS=INDI-FAMS:0M SUBM=SUBM-PTR:0M ASSO:0M ALIA:0M ANCI=SUBM-PTR:0M DESI=SUBM-PTR:0M",
      "RFN:01 AFN:01 REFN:0M RIN:01 CHAN:01", CITES,
    ].join(" ")],
    "INDI-NAME": ["T", `TYPE=NAME-TYPE:01 ${NAME_PIECES} FONE=NAME-VARIANT:0M ROMN=NAME-VARIANT:0M`],
    "NAME-TYPE": ["T", ""],
    "NAME-VARIANT": ["T", `TYPE:11 ${NAME_PIECES}`],
    SEX: ["E:SEX", ""],
    IEVEN: ["T", INDI_EVENT],
    BIRT: ["T", `${INDI_EVENT} FAMC=EVEN-FAMC:01`],
    ADOP: ["T", `${INDI_EVENT} FAMC=ADOP-FAMC:01`],
    "EVEN-FAMC": ["@FAM", ""],
    "ADOP-FAMC": ["@FAM", "ADOP=ADOP-ADOP:01"],
    "ADOP-ADOP": ["E:ADOP", ""],
    BAPL: ["", `${LDS} STAT=STAT-BAPL:01`],
    ENDL: ["", `${LDS} STAT=STAT-ENDL:01`],
    SLGC: ["", `${LDS} STAT=STAT-SLGC:01 FAMC=EVEN-FAMC:11`],
    "STAT-BAPL": ["E:STAT-BAPL", "DATE=TXT:11"],
    "STAT-ENDL": ["E:STAT-ENDL", "DATE=TXT:11"],
    "STAT-SLGC": ["E:STAT-SLGC", "DATE=TXT:11"],
    "STAT-SLGS": ["E:STAT-SLGS", "DATE=TXT:11"],
    "INDI-FAMC": ["@FAM", "PEDI:01 STAT=FAMC-STAT:01 NOTE:0M"],
    PEDI: ["E:PEDI", ""],
    "FAMC-STAT": ["E:FAMC-STAT", ""],
    "INDI-FAMS": ["@FAM", "NOTE:0M"],
    // TYPE is the 5.5 form of the line, still written by 5.5.1 exporters.
    ASSO: ["@INDI", "TYPE:01 RELA:11 SOUR=SOUR-CIT:0M NOTE:0M"],
    ALIA: ["@INDI", ""],
    // ── FAM_RECORD
    "record-FAM": ["", [
      "RESN:01", each(FAM_EVENTS, "0M"),
      "HUSB=FAM-SPOUSE:01 WIFE=FAM-SPOUSE:01 CHIL:0M NCHI=TXT:01 SUBM=SUBM-PTR:0M SLGS:0M",
      "REFN:0M RIN:01 CHAN:01", CITES,
    ].join(" ")],
    FEVEN: ["T", FAM_EVENT],
    "EVEN-SPOUSE": ["", "AGE:11"],
    "FAM-SPOUSE": ["@INDI", ""],
    CHIL: ["@INDI", ""],
    SLGS: ["", `${LDS} STAT=STAT-SLGS:01`],
    // ── SOURCE_RECORD
    "record-SOUR": ["", `DATA=SOUR-DATA:01 AUTH:01 TITL:01 ABBR:01 PUBL:01 TEXT:01 REPO=REPO-CIT:0M REFN:0M RIN:01 CHAN:01 NOTE:0M OBJE=OBJE-LINK:0M`],
    "SOUR-DATA": ["", "EVEN=SOUR-DATA-EVEN:0M AGNC:01 NOTE:0M"],
    "SOUR-DATA-EVEN": ["T", "DATE=TXT:01 PLAC=TXT:01"],
    "REPO-CIT": ["@REPO?", "NOTE:0M CALN:0M"],
    CALN: ["T", "MEDI:01"],
    // ── REPOSITORY_RECORD, MULTIMEDIA_RECORD, NOTE_RECORD, SUBMITTER_RECORD, SUBMISSION_RECORD
    "record-REPO": ["", `NAME:11 ${ADDRESS} NOTE:0M REFN:0M RIN:01 CHAN:01`],
    "record-OBJE": ["", "FILE=OBJE-FILE:1M REFN:0M RIN:01 NOTE:0M SOUR=SOUR-CIT:0M CHAN:01"],
    "record-NOTE": ["T", "REFN:0M RIN:01 SOUR=SOUR-CIT:0M CHAN:01"],
    "record-SUBM": ["", `NAME:11 ${ADDRESS} OBJE=OBJE-LINK:0M LANG:03 RFN:01 RIN:01 NOTE:0M CHAN:01`],
    "record-SUBN": ["", "SUBM=SUBM-PTR:01 FAMF:01 TEMP:01 ANCE:01 DESC:01 ORDI:01 RIN:01 NOTE:0M CHAN:01"],
  },
  enums: {
    SEX: "M F U",
    PEDI: "adopted birth foster sealing",
    "FAMC-STAT": "challenged disproven proven",
    QUAY: "0 1 2 3",
    RESN: "confidential locked privacy",
    ROLE: "CHIL HUSB WIFE MOTH FATH SPOU ()",
    MEDI: "audio book card electronic fiche film magazine manuscript map newspaper photo tombstone video",
    ADOP: "HUSB WIFE BOTH",
    CHAR: "ANSEL UTF-8 UNICODE ASCII",
    "GEDC-FORM": "LINEAGE-LINKED",
    "STAT-BAPL": "CHILD COMPLETED EXCLUDED PRE-1970 STILLBORN SUBMITTED UNCLEARED",
    "STAT-ENDL": "CHILD COMPLETED EXCLUDED INFANT PRE-1970 STILLBORN SUBMITTED UNCLEARED",
    "STAT-SLGC": "BIC COMPLETED EXCLUDED DNS PRE-1970 STILLBORN SUBMITTED UNCLEARED",
    "STAT-SLGS": "CANCELED COMPLETED DNS EXCLUDED DNS/CAN PRE-1970 SUBMITTED UNCLEARED",
  },
};

/**
 * GEDCOM 5.5.5 (2019), the stricter revision of 5.5.1: the file is Unicode
 * (`CHAR UTF-8`, or `UNICODE` for UTF-16), and the form line names its own
 * version (`2 FORM LINEAGE-LINKED` / `3 VERS 5.5.5`).
 */
export const SPEC_555: SpecTable = {
  ...SPEC_551,
  version: "5.5.5",
  structs: { ...SPEC_551.structs, "GEDC-FORM": ["E:GEDC-FORM", "VERS:11"] },
  enums: { ...SPEC_551.enums, CHAR: "UTF-8 UNICODE" },
};

/**
 * GEDCOM 5.5 (1996): a multimedia link or record carries its `FORM`, `TITL`
 * and `FILE` (or embedded `BLOB`) at its own level rather than under `FILE`,
 * an association may point at any record its `TYPE` names, and UTF-8 is not
 * yet a declared character set (files say it anyway; that is left alone).
 */
export const SPEC_55: SpecTable = {
  ...SPEC_551,
  version: "5.5",
  structs: {
    ...SPEC_551.structs,
    "OBJE-LINK": ["@OBJE?", "FORM=TXT:01 TITL:01 FILE=OBJE-FILE:0M BLOB=TXT:01 NOTE:0M"],
    "record-OBJE": ["", "FORM=TXT:01 TITL:01 FILE=OBJE-FILE:0M BLOB=TXT:01 OBJE=OBJE-LINK:01 REFN:0M RIN:01 NOTE:0M SOUR=SOUR-CIT:0M CHAN:01"],
  },
};
