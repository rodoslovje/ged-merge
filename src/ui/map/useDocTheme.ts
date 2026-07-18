import { useEffect, useState } from "react";

/** Current live document theme (App's useTheme owns the attribute). */
export function useDocTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"),
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
