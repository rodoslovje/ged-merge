import { useTranslation } from "react-i18next";
import type { LegalPage } from "./useLegalModal";

interface Props {
  onShortcuts: () => void;
  onLegal: (page: LegalPage) => void;
}

/** `·` between footer entries. */
function Sep() {
  return <span className="app-footer-sep">·</span>;
}

/**
 * The page footer, shared by the main app shell and the full-page tree/chart
 * overlays. The changelog and User's Guide are standalone static pages on
 * localized slugs (`/posodobitve`, `/navodila`), not in-app modals, so they are
 * plain links; the shortcut sheet and the legal pages are modals the app owns.
 */
export function AppFooter({ onShortcuts, onLegal }: Props) {
  const { t, i18n } = useTranslation();
  const sl = i18n.language === "sl";

  return (
    <footer className="app-footer">
      <a href="https://luka.renko.fyi" target="_blank" rel="noopener noreferrer">
        © 2026 Luka Renko
      </a>
      <Sep />
      <a
        href={sl ? "posodobitve/" : "changelog/"}
        className="app-footer-link"
        target="_blank"
        rel="noopener noreferrer"
        title={t("footer.changelog")}
      >
        v{__APP_VERSION__}
      </a>
      <Sep />
      <a
        href={sl ? "navodila/" : "guide/"}
        className="app-footer-link"
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("help.title")}
      </a>
      <Sep />
      <button className="app-footer-link" onClick={onShortcuts}>
        {t("shortcuts.title")}
      </button>
      <Sep />
      <button className="app-footer-link" onClick={() => onLegal("privacy")}>
        {t("footer.privacy")}
      </button>
      <Sep />
      <button className="app-footer-link" onClick={() => onLegal("terms")}>
        {t("footer.terms")}
      </button>
      <Sep />
      <a href="mailto:support@gedmerge.com">{t("footer.contact")}</a>
    </footer>
  );
}
