// Two "don't show this again" choices about the media folder, kept in
// localStorage rather than in the settings object: both are about this
// browser's dialogs (the folder itself can only be remembered per browser),
// and they must survive a settings reset the same way the folder handle does.

const OFFER_KEY = "mediaFolderNeverOffer";
const WARN_KEY = "mediaFolderNoWarn";

/** The user chose "Don't ask again" on the offer to connect a media folder. */
export const mediaOfferSuppressed = () => localStorage.getItem(OFFER_KEY) === "true";
export const suppressMediaOffer = () => localStorage.setItem(OFFER_KEY, "true");

/** The user ticked "Don't warn me again" on the Firefox/Brave upload notice. */
export const mediaWarnSuppressed = () => localStorage.getItem(WARN_KEY) === "true";
export const suppressMediaWarn = () => localStorage.setItem(WARN_KEY, "true");

/** Whether either dialog is currently silenced (drives the Settings row). */
export const anyMediaDialogSuppressed = () => mediaOfferSuppressed() || mediaWarnSuppressed();

/** Bring both dialogs back. */
export function resetMediaDialogs() {
  localStorage.removeItem(OFFER_KEY);
  localStorage.removeItem(WARN_KEY);
}
