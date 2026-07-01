import { useTranslation } from "react-i18next";
import { useRegisterSW } from "virtual:pwa-register/react";

// Toast shown when the service worker has fetched a new build. Updates are
// user-driven on purpose (registerType "prompt"): in-progress edit-mode
// changes are not persisted, so we never reload out from under the user.
export function PwaReloadPrompt() {
  const { t } = useTranslation();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className="pwa-toast" role="status">
      <span>{t("pwa.updateAvailable")}</span>
      <div className="pwa-toast-actions">
        <button className="pwa-toast-reload" onClick={() => updateServiceWorker(true)}>
          {t("pwa.reload")}
        </button>
        <button className="btn-secondary" onClick={() => setNeedRefresh(false)}>
          {t("pwa.dismiss")}
        </button>
      </div>
    </div>
  );
}
