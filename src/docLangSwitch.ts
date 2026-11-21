// The language links in the static pages' top bar (guide, changelog, legal).
// The three translations share their section ids, so a switch keeps the
// section the reader is in, and the language chosen here is the one the app
// opens in next time (the key i18n.ts reads).
document.addEventListener("click", (e) => {
  const link = (e.target as Element | null)?.closest?.("a.guide-lang");
  if (!(link instanceof HTMLAnchorElement)) return;
  try {
    if (link.lang) localStorage.setItem("gedmerge.lang", link.lang);
  } catch {
    // Storage blocked: the link still switches the page.
  }
  if (window.location.hash) link.hash = window.location.hash;
});
