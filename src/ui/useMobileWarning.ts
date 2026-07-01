import { useState } from "react";

const DISMISSED_KEY = "mobileWarningDismissed";

/**
 * One-time "this app works best on a larger screen" notice. Shown on narrow
 * viewports until dismissed; the dismissal is remembered in localStorage.
 */
export function useMobileWarning(): { showMobileWarning: boolean; dismissMobileWarning: () => void } {
  const [showMobileWarning, setShowMobileWarning] = useState(
    () => window.innerWidth <= 880 && !localStorage.getItem(DISMISSED_KEY),
  );

  function dismissMobileWarning() {
    localStorage.setItem(DISMISSED_KEY, "true");
    setShowMobileWarning(false);
  }

  return { showMobileWarning, dismissMobileWarning };
}
