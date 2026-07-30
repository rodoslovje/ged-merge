import type { Dataset } from "../gedcom/types";
import type { Translate } from "../locales/i18n";

/**
 * What saving does to this file's encoding, in the user's words — empty when
 * there's nothing to say.
 *
 * Serialized text always leaves the app as UTF-8 bytes (a `Blob` of a JS string
 * is), so `ensureUtf8Charset` rewrites `HEAD.CHAR` to match on the way out. That
 * is a silent change to a line other software trusts, so both places the user
 * meets it — the health check (before saving) and the save preview (at the
 * moment of saving) — say the same thing, from here.
 *
 * The second line is about the one thing saving cannot put right: bytes the
 * decoder couldn't read, which are already `�` in the loaded file.
 */
export function charsetNotices(ds: Pick<Dataset, "charset" | "warnings">, t: Translate): string[] {
  const notes: string[] = [];
  if (ds.charset !== "UTF-8") notes.push(t("gedcom.charsetNotice", { charset: ds.charset }));
  if (ds.warnings.some((w) => w.code === "undecodable")) notes.push(t("gedcom.charsetLost"));
  return notes;
}
