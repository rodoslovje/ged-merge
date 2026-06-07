# GedMerge

Compare and merge GEDCOM files entirely in your browser. Nothing is uploaded, keeping your genealogical data private and secure.

## Features

- 🔒 **Privacy First:** All parsing, matching, and merging happens locally in your browser via Web Workers. Your family tree is never sent to a server.
- 🤝 **Smart Matching:** Automatically calculates match scores between individuals and families from a Master and Incoming GEDCOM file.
- 🌳 **Compare Tree:** Visual comparison of ancestor and descendant trees to spot major and minor differences or conflicts.
- 🎛️ **Advanced Filtering & Sorting:** Filter matches by new data, differences, links, or a minimum score threshold. Sort by score, distance, and more.
- 🏠 **Home Person Context:** Set a home person to automatically rank matches by relationship distance.
- ⚖️ **Conflict Resolution:** Easily review conflicts field-by-field and decide whether to keep the master record, take the incoming record, or keep both.
- 💾 **Export:** Export the merged GEDCOM file along with a detailed merge report.
- 🌍 **Localization:** Available in English and Slovenian (Slovenščina).

## Architecture

- **React & TypeScript:** Modern, type-safe UI components.
- **Web Workers:** Heavy GEDCOM parsing and matching calculations are offloaded to web workers to keep the UI responsive.
- **i18next:** Fully internationalized interface (`en`, `sl`).

## Getting Started

Make sure you have Node.js installed.

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Development Server

```bash
npm run dev
```

This will start the local development server. Open the provided `localhost` URL in your browser to start comparing trees.

### 3. Build for Production

```bash
npm run build
```

This creates a static, production-ready bundle in the `dist` directory that can be hosted on any static file server (GitHub Pages, Netlify, Vercel, etc.).

## Usage

1. **Load GEDCOMs:** Select your Master GEDCOM and the Incoming GEDCOM you wish to merge.
2. **Review Matches:** Go through the list of generated matches. Use the keyboard shortcuts (`C` for Confirm, `R` for Reject, `D` for Defer) to quickly organize them.
3. **Export:** Once you are satisfied with your decisions, click **Export merged GEDCOM** to download your new `.ged` file.
