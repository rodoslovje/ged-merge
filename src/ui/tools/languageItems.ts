import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { UNDETERMINED } from "../../tools/fixTranslationLang";
import type { PickerItem } from "../PickerMenu";

/** The languages a translation's picker offers before any the file already uses. */
const OFFERED = [UNDETERMINED, "sl", "de", "la", "it", "hu", "hr", "cs"];

/** A translation's language picker items: each code named in the interface
 *  language ("German (de)"), the offered ones first, then `extra`. */
export function useLanguageItems(extra: readonly string[]): PickerItem<string>[] {
  const { t, i18n } = useTranslation();
  const extraKey = extra.join(" ");
  return useMemo(() => {
    let names: Intl.DisplayNames | undefined;
    try {
      names = new Intl.DisplayNames([i18n.language], { type: "language" });
    } catch {
      names = undefined;
    }
    const codes = [...new Set([...OFFERED, ...(extraKey ? extraKey.split(" ") : [])])];
    return codes.map((code) => {
      let name: string | undefined;
      try {
        name = code === UNDETERMINED ? t("tools.validate.tranLang.undetermined") : names?.of(code);
      } catch {
        name = undefined;
      }
      return { key: code, label: name && name !== code ? `${name} (${code})` : code };
    });
  }, [extraKey, i18n.language, t]);
}
