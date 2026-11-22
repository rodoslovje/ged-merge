// The family calendar's colour schemes: paper colours, not the app theme's —
// each page carries its scheme as inline custom properties, so the preview and
// the print document (which has no app stylesheet) look the same. The cover's
// fan reads the app's node, sex and surface tokens; a scheme sets those too,
// inside the page, so the fan takes the calendar's colours.

export type CalendarScheme = "gedmerge" | "classic" | "sea" | "autumn" | "pastel" | "mono";
export const CALENDAR_SCHEMES: CalendarScheme[] = ["gedmerge", "classic", "sea", "autumn", "pastel", "mono"];

interface Palette {
  paper: string;
  ink: string;
  muted: string;
  faint: string;
  rule: string;
  tint: string;
  accent: string;
  holiday: string;
  birthday: string;
  anniversary: string;
  memorial: string;
  /** The fan's ancestor and descendant halves. */
  fanAnc: string;
  fanDesc: string;
  male: string;
  female: string;
}

export const PALETTES: Record<CalendarScheme, Palette> = {
  // The app's light theme: Heritage Pine green, with its event colours.
  gedmerge: {
    paper: "#fffefc", ink: "#27221d", muted: "#6d6863", faint: "#b5afa7", rule: "#e2dfda", tint: "#f3efe8",
    accent: "#31715b", holiday: "#c0392b", birthday: "#31715b", anniversary: "#a9750e", memorial: "#7a6f63",
    fanAnc: "#31715b", fanDesc: "#2b6b7d", male: "#166daf", female: "#b73c7c",
  },
  classic: {
    paper: "#fffdf7", ink: "#1f1a17", muted: "#5f5650", faint: "#b8aea4", rule: "#ddd3c6", tint: "#f5efe4",
    accent: "#7b1e2b", holiday: "#7b1e2b", birthday: "#7b1e2b", anniversary: "#8a6d1f", memorial: "#5f5650",
    fanAnc: "#7b1e2b", fanDesc: "#4b5d3a", male: "#2c3e66", female: "#7b1e2b",
  },
  sea: {
    paper: "#fbfdff", ink: "#16273a", muted: "#566679", faint: "#a9b6c4", rule: "#d6e0ea", tint: "#ecf3f9",
    accent: "#1f4e79", holiday: "#c2452d", birthday: "#1f7a8c", anniversary: "#c08a1e", memorial: "#566679",
    fanAnc: "#1f4e79", fanDesc: "#1f7a8c", male: "#1f4e79", female: "#b0466e",
  },
  autumn: {
    paper: "#fffcf6", ink: "#2b1d14", muted: "#6e5a4b", faint: "#c2ac98", rule: "#e8dacb", tint: "#f8eedf",
    accent: "#b5532a", holiday: "#a8321c", birthday: "#6b7d2a", anniversary: "#c48a1b", memorial: "#6e5a4b",
    fanAnc: "#b5532a", fanDesc: "#6b7d2a", male: "#40618c", female: "#b5532a",
  },
  pastel: {
    paper: "#fffdfd", ink: "#33293a", muted: "#776c80", faint: "#c4bacb", rule: "#ece3ef", tint: "#f7f0f8",
    accent: "#a85a7a", holiday: "#c4566a", birthday: "#5f9a8a", anniversary: "#c29546", memorial: "#776c80",
    fanAnc: "#a85a7a", fanDesc: "#6b8fb8", male: "#6b8fb8", female: "#c2678a",
  },
  // Saves ink: greys only, the holidays in the darkest tone.
  mono: {
    paper: "#ffffff", ink: "#1a1a1a", muted: "#5c5c5c", faint: "#b0b0b0", rule: "#d4d4d4", tint: "#f2f2f2",
    accent: "#1a1a1a", holiday: "#1a1a1a", birthday: "#1a1a1a", anniversary: "#5c5c5c", memorial: "#8a8a8a",
    fanAnc: "#6b6b6b", fanDesc: "#9a9a9a", male: "#1a1a1a", female: "#1a1a1a",
  },
};

/** A scheme as the custom properties a page carries. */
export function schemeVars(scheme: CalendarScheme): Record<string, string> {
  const p = PALETTES[scheme];
  return {
    "--paper": p.paper, "--ink": p.ink, "--muted": p.muted, "--faint": p.faint, "--rule": p.rule, "--tint": p.tint,
    "--accent": p.accent, "--holiday": p.holiday,
    // Memorial days: dark grey on every scheme, set apart from the living.
    "--remembrance": "#4a4744",
    "--glyph-birthday": p.birthday, "--glyph-anniversary": p.anniversary, "--glyph-memorial": p.memorial,
    // The app tokens the fan draws with.
    "--node-main": p.fanAnc, "--node-desc": p.fanDesc, "--panel": p.paper, "--text": p.ink,
    "--border": p.rule, "--sex-male": p.male, "--sex-female": p.female,
  };
}
