import { useTranslation } from "react-i18next";

/**
 * Shared fallback shown by an {@link ErrorBoundary} when a view throws. Offers a
 * "Try again" (re-render the failed subtree) and a full reload, and tucks the
 * error message behind a details toggle for a bug report.
 */
export function ErrorFallback({
  error,
  reset,
  title,
}: {
  error: Error;
  reset: () => void;
  /** Optional heading override; defaults to the generic app-error title. */
  title?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="error-fallback" role="alert">
      <h2>{title ?? t("error.title")}</h2>
      <p>{t("error.body")}</p>
      <div className="error-fallback-actions">
        <button className="nav-btn primary" onClick={reset}>
          {t("error.retry")}
        </button>
        <button className="nav-btn" onClick={() => window.location.reload()}>
          {t("error.reload")}
        </button>
      </div>
      <details className="error-fallback-details">
        <summary>{t("error.details")}</summary>
        <pre>{error.message || String(error)}</pre>
      </details>
    </div>
  );
}
