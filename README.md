# GedMerge

Compare and merge GEDCOM files entirely in your browser. Nothing is uploaded, keeping your genealogical data private and secure.

## Features

- 🔒 **Privacy First:** All parsing, matching, merging, and editing happens locally in your browser via Web Workers. Your family tree is never sent to a server.
- ✏️ **Direct Editing:** Edit mode lets you browse and modify your Master GEDCOM without a second file — names, sex, events, notes, links, and family relationships.
- 🤝 **Smart Matching:** Automatically calculates match scores between individuals and families from a Master and Incoming GEDCOM file.
- 🌳 **Compare Tree:** Visual comparison of ancestor and descendant trees to spot major and minor differences or conflicts.
- 🎛️ **Advanced Filtering & Sorting:** Filter matches by new data, differences, links, or a minimum score threshold. Sort by score, distance, and more.
- 🏠 **Home Person Context:** Set a home person to automatically rank matches by relationship distance.
- ⚖️ **Conflict Resolution:** Easily review conflicts field-by-field and decide whether to keep the master record, take the incoming record, or keep both.
- 💾 **Export:** Export the merged or edited GEDCOM file.
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

### Edit Mode
1. **Load Master GEDCOM:** Select your primary `.ged` file.
2. **Switch to Edit:** Click the **Edit** tab to enter edit mode.
3. **Browse & Edit:** Jump to any person via the search box, or click family member cards to navigate. Edit names, sex, events (birth, death, and many more via the grouped **+ Add event** dropdown), family relationships (add/detach parents, partners, children), and attach notes and URL links to individuals or families.
4. **Delete with care:** The trash icon permanently removes a person from all families. The **−** detach icon only removes the family link.
5. **Save:** Click **Save GEDCOM** to preview your changes and download the edited file.

### Merge Mode
1. **Load GEDCOMs:** Select your Master GEDCOM and the Incoming GEDCOM you wish to merge.
2. **Review Matches:** Go through the list of generated matches. Use the keyboard shortcuts (`C` for Confirm, `R` for Reject, `D` for Defer) to quickly organize them.
3. **Export:** Once you are satisfied with your decisions, click **Save GEDCOM** to download your merged `.ged` file.
