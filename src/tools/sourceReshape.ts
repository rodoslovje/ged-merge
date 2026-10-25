/**
 * Whole-file "source reshape": convert Matricula Online / Geneanet Cemeteries /
 * FamilySearch URL links — wherever they appear on a record — into proper
 * top-level `SOUR` records cited via `SOUR @Sn@` + `PAGE n` (the "paginated"
 * shape `resolveSourceCitation` links page-accurately: `TITL/AGNC/PLAC/FILN`
 * plus one `OBJE` per page scan).
 *
 * Like `sourceDuplicates`, this is a pure, synchronous whole-file tool: the
 * scan (`findReshapableLinks`) reports what would change, the apply
 * (`reshapeSources`) clones the record forest and never mutates the input; the
 * caller serializes the result to a download. Metadata is extracted offline
 * from the URL itself; `fetchReshapeMeta` optionally enriches new sources with
 * the real book title / archive / date range from the Matricula book page
 * (one fetch per book, never per page).
 *
 * Not converted (deliberately): pointer NOTEs (shared records — rewriting them
 * has non-local effects), URLs appearing only in a `SOUR` record's own NOTE,
 * non-book Matricula URLs (archive indexes), and unrecognized hosts unless the
 * "other" site category is enabled. FamilySearch is enriched for collection
 * image links only (`parseFamilySearchArkJson`): everything else there — record
 * pages, catalog films — sits behind a login, and offline signals (quoted
 * collection titles, `cat`/`i` params) carry it. Deferred follow-ups: FS API
 * OAuth for record pages, and a placement audit for pre-existing pointer
 * citations.
 */

// The tool lives in ./sourceReshape/, one module per stage — model (types and
// site list), urls (offline URL recognition), scan (register classification
// and the occurrence scan), report (grouping), apply, and enrich (the optional
// online lookups). This file is the public entry point.

export {
  ALL_SITES,
  isFetchableSite,
} from "./sourceReshape/model";
export type {
  ReshapeSite,
  ReshapeShape,
  BookType,
  ReshapeOccurrence,
  ReshapeGroup,
  ReshapeReport,
  ReshapeMeta,
  ReshapeEnrichment,
  PageMediaStyle,
  ReshapeOptions,
  ReshapeCounts,
} from "./sourceReshape/model";
export {
  parseMatriculaUrl,
  pageObjeTitle,
  recognizeSourceUrl,
  SITE_ICON,
  siteQuay,
  siteIconForUrl,
  parseFamilySearchUrl,
} from "./sourceReshape/urls";
export type {
  MatriculaUrlParts,
  RecognizedSourceUrl,
  FamilySearchUrlParts,
} from "./sourceReshape/urls";
export {
  classifyBookType,
  baptismTargetTag,
  hasSourcePageMedia,
  detectPageMediaStyle,
  prefersDoubledLinks,
} from "./sourceReshape/scan";
export {
  siteEventTag,
  reshapeOptionsFromOverrides,
  findReshapableLinks,
} from "./sourceReshape/report";
export {
  makePlaceResolver,
  detectCitationPlacement,
  smartCitationTarget,
  normalizeSourceCoverage,
  repoNameTail,
  repoCountryFacet,
  proposedSiteRepo,
  fsRepoCountry,
  createSiteRepo,
  applySiteSourceExtras,
  sourceRegisterOf,
  siteSourceTitle,
  reshapeSources,
} from "./sourceReshape/apply";
export type {
  FsCollection,
} from "./sourceReshape/apply";
export {
  parseMatriculaTitle,
  parseMatriculaBookPage,
  parseGeneanetCemeteryPage,
  FS_GEDCOMX_ACCEPT,
  parseFamilySearchArkJson,
  parsePastedFsCitation,
  splitFsRegisters,
  narrowFsRegister,
  cachedBookMeta,
  fetchBookMeta,
  fetchReshapeMeta,
  readBookPages,
  queueBookPages,
  resetBookQueue,
  mergeFsBooks,
} from "./sourceReshape/enrich";
