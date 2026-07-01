import { useEffect, useState } from "react";

export type LegalPage = "privacy" | "terms";

/**
 * State for the Privacy/Terms modal. Also opens it when the page is arrived at
 * via `?legal=privacy|terms` (the standalone guide pages link here, having no
 * React modal of their own), then strips the param so a reload or Back doesn't
 * reopen it.
 */
export function useLegalModal(): {
  legalOpen: boolean;
  legalPage: LegalPage;
  openLegal: (page: LegalPage) => void;
  closeLegal: () => void;
} {
  const [legalOpen, setLegalOpen] = useState(false);
  const [legalPage, setLegalPage] = useState<LegalPage>("privacy");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const legal = params.get("legal");
    if (legal !== "privacy" && legal !== "terms") return;
    setLegalPage(legal);
    setLegalOpen(true);
    params.delete("legal");
    const search = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + (search ? `?${search}` : "") + window.location.hash,
    );
  }, []);

  return {
    legalOpen,
    legalPage,
    openLegal: (page: LegalPage) => {
      setLegalPage(page);
      setLegalOpen(true);
    },
    closeLegal: () => setLegalOpen(false),
  };
}
