/** Slovenian UI strings. */
export const sl = {
  app: {
    title: "GedMerge",
    subtitle:
      "Primerjajte in združite datoteke GEDCOM v celoti v brskalniku. Nič se ne naloži v splet.",
  },
  section: {
    load: "Naloži GEDCOM",
    compare: "Primerjava",
    matches: "Ujemanja",
  },
  load: {
    master: "Glavni GEDCOM",
    incoming: "Vhodni GEDCOM",
  },
  matches: {
    calculating: "Računanje ujemanj…",
    individuals: "Osebe",
    families: "Družine",
    empty: "Naložite obe datoteki za izračun ujemanj.",
  },
  compare: {
    empty: "Noben zadetek ni izbran — izberite enega s seznama Ujemanja.",
  },
  nav: {
    prev: "Prejšnje ujemanje (Bližnjica: ← ali ↑)",
    next: "Naslednje ujemanje (Bližnjica: → ali ↓)",
    pos: "{{current}} od {{total}}",
  },
  tree: {
    button: "Primerjalno drevo",
    title: "Primerjalno drevo",
    back: "Nazaj",
    ancestors: "Predniki",
    descendants: "Potomci",
    empty: "Za to osebo ni ničesar za prikaz.",
    legend: {
      match: "Popolno ujemanje",
      minor: "Manjša razlika",
      major: "Večja razlika",
      masterOnly: "Samo v Glavni",
      incomingOnly: "Samo v Vhodni",
    },
  },
} as const;
