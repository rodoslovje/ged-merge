import { useEffect, useState } from "react";

/**
 * A transient status message that clears itself after `timeoutMs`. Setting a new
 * message restarts the timer; setting it to `null` hides it immediately.
 */
export function useAutoDismissToast(timeoutMs = 4000): [string | null, (msg: string | null) => void] {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), timeoutMs);
    return () => clearTimeout(id);
  }, [toast, timeoutMs]);
  return [toast, setToast];
}
