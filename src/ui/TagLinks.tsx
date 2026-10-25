import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { hasTermsPage, TERMS_ORIGIN, termsUri } from "../gedcom/extensionTerms";

/** A GEDCOM tag standing alone in a text: `_UID`, `FILN`, `INDI` in
 *  `INDI.EDUC`, `NOBI` in "Award (NOBI)". A capitalized word (`MacFamilyTree`)
 *  is not one. */
const TAG_TOKEN = /(?<![A-Za-z0-9_])(_?[A-Z][A-Z0-9_]*)(?![A-Za-z0-9_])/;

/** The page on this site that explains `tag`, when there is one: a program's
 *  own tag or an extension (`/terms/<program>/<TAG>`). `headSour` (the file's
 *  `HEAD.SOUR`) picks the producer's page where it has one. */
export function termsHref(tag: string, headSour?: string): string | undefined {
  return hasTermsPage(tag) ? termsUri(tag, headSour).slice(TERMS_ORIGIN.length) : undefined;
}

/**
 * `text` with every tag the terms site documents linked to its page, which
 * opens beside the app — so a reader meeting `NOBI` or `_UID` anywhere can
 * look up what it is. Standard tags have no page and stay plain. `unknown`
 * names one more tag to link, to the page for tags no table knows.
 */
export function LinkedTags({ text, headSour, unknown }: { text: string; headSour?: string; unknown?: string }): ReactNode {
  const { t } = useTranslation();
  const parts = text.split(TAG_TOKEN);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    const href = i % 2 === 1
      ? termsHref(part, headSour) ?? (part === unknown ? termsUri(part, headSour).slice(TERMS_ORIGIN.length) : undefined)
      : undefined;
    return href ? (
      <a key={i} className="tag-terms-link" href={href} target="_blank" rel="noopener" title={t("tools.validate.struct.terms")}>
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    );
  });
}
