import { useEffect, useState } from "react";

/** `Date.now()`, re-read every second while `active` — for a clock beside work
 *  that has nothing else to count yet. Not ticking (and no re-render) when idle. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
