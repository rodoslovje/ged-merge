import L from "leaflet";

// "Fit to data" button, added as a third button in the map's own zoom bar:
// after panning around a historical overlay it puts the whole plotted set back
// on screen in one click. The bounds are asked for at click time, so the button
// always frames what is currently drawn (year filters, branch scope, …).

/** Corner brackets — the standard "fit contents" glyph. */
const FIT_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/>' +
  "</svg>";

/** Add the button to `map`. `boundsOf` returns what to frame, or null when
 *  there is nothing plotted (the click is then a no-op). It joins the zoom
 *  control's bar so the three buttons read as one stack; without a zoom
 *  control (never today) it becomes a bar of its own in the same corner. */
export function addFitControl(map: L.Map, title: string, boundsOf: () => L.LatLngBounds | null): void {
  const zoomBar = map.zoomControl?.getContainer();
  const container = zoomBar ?? L.DomUtil.create("div", "leaflet-bar leaflet-control");
  const link = L.DomUtil.create("a", "map-fit-link", container);
  link.href = "#";
  link.title = title;
  link.setAttribute("role", "button");
  link.setAttribute("aria-label", title);
  // Static markup, no interpolation.
  link.innerHTML = FIT_ICON;
  L.DomEvent.on(link, "click", (e) => {
    L.DomEvent.stop(e);
    const bounds = boundsOf();
    if (bounds?.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
  });
  if (zoomBar) return;
  const Standalone = L.Control.extend({
    options: { position: "topleft" as L.ControlPosition },
    onAdd: () => container,
  });
  new Standalone().addTo(map);
}

/** Bounds around a set of coordinates, or null when the set is empty. */
export function boundsOfCoords(coords: readonly { lat: number; lon: number }[]): L.LatLngBounds | null {
  if (!coords.length) return null;
  return L.latLngBounds(coords.map((c) => [c.lat, c.lon] as [number, number]));
}
