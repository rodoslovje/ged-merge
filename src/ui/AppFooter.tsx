import { useTranslation } from "react-i18next";

interface Props {
  onShortcuts: () => void;
}

/** `·` between footer entries. */
function Sep() {
  return <span className="app-footer-sep">·</span>;
}

/**
 * The page footer, shared by the main app shell and the full-page tree/chart
 * overlays. The changelog, User's Guide and the two legal pages are standalone
 * static pages on localized slugs (`/posodobitve`, `/navodila`, `/zasebnost`,
 * `/pogoji`), not in-app modals, so they are plain links; only the shortcut
 * sheet is a modal the app owns. Legal text lives on those pages alone — one
 * copy per language, with a durable address to link and print.
 */
export function AppFooter({ onShortcuts }: Props) {
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
      <a
        href={sl ? "zasebnost/" : "privacy/"}
        className="app-footer-link"
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("footer.privacy")}
      </a>
      <Sep />
      <a
        href={sl ? "pogoji/" : "terms/"}
        className="app-footer-link"
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("footer.terms")}
      </a>
      <Sep />
      <a href="mailto:support@gedmerge.com">{t("footer.contact")}</a>
    </footer>
  );
}
