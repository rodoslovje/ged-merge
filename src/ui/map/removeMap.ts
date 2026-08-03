import type L from "leaflet";

/** Tear down a Leaflet map safely. `map.remove()` does not clear the wheel
 *  zoom's debounce timer — a wheel turn within ~40 ms of removal still fires
 *  `_performZoom` on the destroyed map, which walks the deleted panes and
 *  crashes with `_leaflet_pos … undefined`. Stop the handler and its pending
 *  timer first. Used by every map the app removes (the Places map's panes,
 *  the small place maps). */
export function removeMap(map: L.Map): void {
  // `_timer` is the handler's private debounce handle; there is no public way
  // to flush or cancel it.
  const wheel = map.scrollWheelZoom as L.Map["scrollWheelZoom"] & { _timer?: ReturnType<typeof setTimeout> };
  wheel.disable();
  if (wheel._timer) clearTimeout(wheel._timer);
  map.remove();
}
