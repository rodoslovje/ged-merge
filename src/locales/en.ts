/** English UI strings (default / fallback language). */
export const en = {
  app: {
    title: "GedMerge",
    subtitle:
      "Compare and merge GEDCOM files entirely in your browser. Nothing is uploaded.",
  },
  section: {
    load: "Load GEDCOM",
    compare: "Compare",
    matches: "Matches",
  },
  load: {
    master: "Master GEDCOM",
    incoming: "Incoming GEDCOM",
  },
  matches: {
    calculating: "Calculating matches…",
    individuals: "Individuals",
    families: "Families",
    empty: "Load both files to calculate matches.",
  },
  compare: {
    empty: "No match selected — pick one from the Matches list.",
  },
  nav: {
    prev: "Previous match (Keyboard shortcut: ← or ↑)",
    next: "Next match (Keyboard shortcut: → or ↓)",
    pos: "{{current}} of {{total}}",
  },
  tree: {
    button: "Compare tree",
    title: "Compare tree",
    back: "Back",
    ancestors: "Ancestors",
    descendants: "Descendants",
    empty: "Nothing to show for this person.",
    legend: {
      match: "Full match",
      minor: "Minor difference",
      major: "Major difference",
      masterOnly: "Only in Master",
      incomingOnly: "Only in Incoming",
    },
  },
} as const;
