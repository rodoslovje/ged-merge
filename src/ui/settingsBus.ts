/**
 * "Open Settings, on this tab" — from anywhere, without threading a callback
 * through every panel between App and the caller.
 *
 * A setting that belongs in Settings still has to be reachable from the place
 * where you discover you need it: the Geocode tool cannot work without a place
 * directory, and telling the researcher to go and find the right tab themselves
 * is the dead end this avoids. Sending them there is a one-line request rather
 * than an `onOpenSettings` prop on the four components in between, none of which
 * has anything to do with settings.
 *
 * A module-level listener set, like {@link invalidateGazetteerIndex} and the
 * gazetteer manager's cross-instance refresh: App subscribes once, everyone else
 * just calls.
 */

/** The Settings modal's tabs, in the order it shows them. */
export type SettingsTab = "general" | "format" | "map" | "advanced";

type Listener = (tab: SettingsTab) => void;

const listeners = new Set<Listener>();

/** Ask for the Settings modal, opened on `tab`. No-op if nothing is listening
 *  (a panel rendered outside the app shell, e.g. in a test). */
export function requestSettings(tab: SettingsTab): void {
  for (const listener of listeners) listener(tab);
}

/** Subscribe to those requests; returns the unsubscribe. App owns the modal, so
 *  App is the only listener in practice. */
export function onSettingsRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
