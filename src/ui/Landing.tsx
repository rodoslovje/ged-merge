import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { SlotState } from "../App";
import { pickFile, fileFromDrop, supportsFilePicker } from "./filePicker";
import { AddPersonIcon } from "./icons/AddPersonIcon";
import { useMediaViewer } from "./MediaViewer";
import { usePhone } from "./usePhone";

interface Props {
  mainState: SlotState;
  onLoadFile: (file: File, handle?: FileSystemFileHandle) => void;
  onLoadSample: (fileName: string) => void;
  /** Begin with an empty GEDCOM instead of importing one — for a tree that
   *  doesn't exist anywhere yet. */
  onStartNew: () => void;
}

const MAIN_ACCEPT = { description: "GEDCOM files", mime: { "text/plain": [".ged", ".gedcom"] } };

const SAMPLES: { key: string; file: string }[] = [
  { key: "europe",     file: "EuropeRoyalFamilies.ged" },
  { key: "tudor",      file: "EnglishTudorRoyalFamily.ged" },
  { key: "presidents", file: "USPresidents.ged" },
];

/** The capability grid: one card per mode of the workbench. The page is a map
 *  of the product — "merge is one mode of four" is shown, not argued. */
const CAPS: { key: string; icon: React.ReactNode }[] = [
  {
    key: "edit",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    ),
  },
  {
    key: "merge",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6.5" cy="5" r="2.2" />
        <circle cx="17.5" cy="5" r="2.2" />
        <circle cx="12" cy="19" r="2.2" />
        <path d="M6.5 7.2v3.3a2 2 0 0 0 2 2H12M17.5 7.2v3.3a2 2 0 0 1-2 2H12M12 12.5v4.3" />
      </svg>
    ),
  },
  {
    key: "charts",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 20a12.6 12.6 0 0 1 0-16" />
        <path d="M12 20a12.6 12.6 0 0 0 0-16" />
        <path d="M12 20V4" />
        <path d="M4.6 14.5h14.8M3.8 9h16.4" />
      </svg>
    ),
  },
  {
    key: "tools",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14.7 6.3a4.4 4.4 0 0 0-6 5.6L3 17.6a2 2 0 0 0 0 2.8l.6.6a2 2 0 0 0 2.8 0l5.7-5.7a4.4 4.4 0 0 0 5.6-6l-3 3-2.5-.5-.5-2.5z" />
      </svg>
    ),
  },
];

/** Proof strip: numbers only, no prose. Each figure is verified against the
 *  app — 8 = the chart hub's kinds (tree, grid, fan, circle, timeline,
 *  relationship, map, report); "offline" = the PWA precaches everything. */
const PROOF_KEYS = ["views", "versions", "offline", "account"] as const;

/** Screenshot strip: image basename + the app's own label for the caption.
 *  UI shots are PNG (flat color, crisp); map scans are JPEG (photographic). */
const SHOTS: { key: string; caption: string; ext: string }[] = [
  { key: "edit",    caption: "mode.edit",                ext: "png" },
  { key: "merge",   caption: "mode.merge",               ext: "png" },
  { key: "tree",    caption: "tree.settings.type.tree",  ext: "png" },
  { key: "fan",     caption: "tree.settings.type.fan",   ext: "png" },
  { key: "map",     caption: "map.button",               ext: "jpg" },
  { key: "maphist", caption: "landing.shots.maphist",    ext: "jpg" },
];

const TreeIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="6.5" cy="5" r="2.2" />
    <circle cx="17.5" cy="5" r="2.2" />
    <circle cx="12" cy="19" r="2.2" />
    <path d="M6.5 7.2v3.3a2 2 0 0 0 2 2H12M17.5 7.2v3.3a2 2 0 0 1-2 2H12M12 12.5v4.3" />
  </svg>
);

interface News {
  date: string;
  items: string[];
}

/** The newest changelog entry, read from the static changelog page of the
 *  current language — zero-maintenance: each merge's changelog edit shows up
 *  here by itself. The pages are precached by the PWA, so this works offline.
 *  On any failure the panel simply doesn't render. */
function useLatestNews(): News | null {
  const { i18n } = useTranslation();
  const sl = i18n.language === "sl";
  const [news, setNews] = useState<News | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNews(null);
    fetch(sl ? "posodobitve/" : "changelog/")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((html) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const entry = doc.querySelector(".changelog-entry");
        const date = entry?.querySelector("h2")?.textContent?.trim() ?? "";
        // One line per bullet: the <strong> lead-in is each bullet's title.
        const items = Array.from(entry?.querySelectorAll("li") ?? [])
          .map((li) => li.querySelector("strong")?.textContent?.replace(/[.!]\s*$/, "").trim() ?? "")
          .filter(Boolean)
          .slice(0, 3);
        if (!cancelled && date && items.length) setNews({ date, items });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sl]);

  return news;
}

export function Landing({ mainState, onLoadFile, onLoadSample, onStartNew }: Props) {
  const { t, i18n } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { openItems } = useMediaViewer();
  const news = useLatestNews();
  // Phones get their own portrait captures (suffix `-m`) — a desktop window is
  // the wrong preview on the device the visitor is actually holding.
  const phone = usePhone();
  const suffix = phone ? "-m" : "";

  /** Expand a strip thumbnail into the app's shared photo viewer (prev/next,
   *  keyboard nav) with the current theme's variant of every shot. */
  function openShot(index: number) {
    const theme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    openItems(
      SHOTS.map(({ key, caption, ext }) => ({
        url: `landing/${key}-${theme}${suffix}.${ext}`,
        title: t(caption),
      })),
      index,
    );
  }

  const loading = mainState.status === "loading";

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onLoadFile(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function browse() {
    if (!supportsFilePicker) {
      inputRef.current?.click(); // unsupported browser — fall back to the hidden input
      return;
    }
    const picked = await pickFile(MAIN_ACCEPT);
    if (picked) onLoadFile(picked.file, picked.handle); // null = user cancelled — do nothing
  }

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const picked = await fileFromDrop(e.dataTransfer);
    if (picked) onLoadFile(picked.file, picked.handle);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void browse();
    }
  }

  return (
    <div className="landing-b">
      <div className="lp-grid">
        {/* Left: main loader — keeps its position and order so the drop zone
            stays visible without scrolling for returning users. */}
        <div className="lb-left">
          <p className="lb-eyebrow">{t("landing.eyebrow")}</p>
          <h1 className="lb-h1">
            <Trans i18nKey="landing.h1">
              The whole GEDCOM workbench — <em>in your browser</em>.
            </Trans>
          </h1>
          <p className="lb-sub">{t("landing.sub")}</p>

          {/* Dropzone */}
          {loading ? (
            <div className="lb-drop lb-drop-loading">
              <span className="spinner" aria-hidden="true" />
              <span className="parsing-status-text">
                {t("loader.parsing", { fileName: (mainState as { status: "loading"; fileName: string }).fileName })}
              </span>
            </div>
          ) : (
            <div
              className={`lb-drop${dragging ? " dragover" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => void browse()}
              onKeyDown={onKeyDown}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input
                ref={inputRef}
                className="file-input"
                type="file"
                accept=".ged,.gedcom,text/plain"
                onChange={onChange}
                onClick={(e) => e.stopPropagation()}
              />
              <svg
                className="lb-dz-ico"
                width="34"
                height="34"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <polyline points="9 15 12 12 15 15" />
              </svg>
              <span className="lb-dz-title">{t("landing.dropzone.title")}</span>
              <span className="lb-dz-hint">{t("landing.dropzone.hint")}</span>
            </div>
          )}

          <p className="lb-free">{t("landing.trust")}</p>

          {mainState.status === "error" && (
            <p className="lb-error error">
              {t("loader.error", { fileName: mainState.fileName, message: mainState.message })}
            </p>
          )}

          {/* Nothing to import: begin from an empty file and add the first person
              by hand. Sits above the samples — it is the product, the samples are
              a demo. Same tray shape; kept mounted while loading (disabled) so
              the layout doesn't shift. */}
          {(mainState.status === "empty" || loading) && (
            <div className={`lb-samples${loading ? " disabled" : ""}`} aria-hidden={loading || undefined}>
              <p className="lb-samples-h">
                <AddPersonIcon size={14} />
                {t("landing.startNew.header")}
              </p>
              <div className="lb-sample-rows">
                <button
                  className="lb-sample-row"
                  onClick={onStartNew}
                  type="button"
                  disabled={loading}
                  tabIndex={loading ? -1 : undefined}
                >
                  <span className="lb-s-ico">
                    <AddPersonIcon />
                  </span>
                  <span className="lb-s-main">
                    <span className="lb-s-name">{t("landing.startNew.name")}</span>
                    <span className="lb-s-meta">{t("landing.startNew.meta")}</span>
                  </span>
                  <span className="lb-s-load">{t("landing.startNew.load")}</span>
                </button>
              </div>
            </div>
          )}

          {/* Sample tray: one row of three compact tiles — name + count only,
              the tile itself is the affordance. */}
          {(mainState.status === "empty" || loading) && (
            <div className={`lb-samples${loading ? " disabled" : ""}`} aria-hidden={loading || undefined}>
              <p className="lb-samples-h">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z" />
                </svg>
                {t("landing.samples.header")}
              </p>
              <div className="lp-sample-tiles">
                {SAMPLES.map(({ key, file }) => (
                  <button
                    key={key}
                    className="lp-sample-tile"
                    onClick={() => onLoadSample(file)}
                    type="button"
                    disabled={loading}
                    tabIndex={loading ? -1 : undefined}
                  >
                    <span className="lb-s-ico">
                      <TreeIcon />
                    </span>
                    <span className="lp-st-name">{t(`landing.samples.${key}.name`)}</span>
                    <span className="lp-st-count">{t(`landing.samples.${key}.count`)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: privacy bar, capability grid, proof strip, what's new. */}
        <div className="lp-right">
          <div className="lp-privbar">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3l7 2.6v5.1c0 4.4-3 7.4-7 8.9-4-1.5-7-4.5-7-8.9V5.6z" />
              <polyline points="9 12 11.3 14.3 15.5 9.6" />
            </svg>
            <p>
              <strong>{t("landing.privacy.title")}</strong> {t("landing.privacy.body")}
            </p>
          </div>

          <div className="lp-caps">
            {CAPS.map(({ key, icon }) => (
              <div key={key} className="lp-cap">
                <div className="lp-cap-head">
                  <span className="lp-cap-ico">{icon}</span>
                  <h3>{t(`landing.cap.${key}.title`)}</h3>
                  <span className="lp-cap-tag">{t("landing.cap.tag")}</span>
                </div>
                <p>{t(`landing.cap.${key}.body`)}</p>
                <div className="lp-chips">
                  {t(`landing.cap.${key}.chips`)
                    .split("·")
                    .map((chip) => (
                      <span key={chip.trim()} className="lp-chip">{chip.trim()}</span>
                    ))}
                </div>
              </div>
            ))}
          </div>

          <div className="lp-proof">
            {PROOF_KEYS.map((key) => (
              <div key={key} className="lp-proof-cell">
                <span className="lp-proof-n">{t(`landing.proof.${key}.n`)}</span>
                <span className="lp-proof-l">{t(`landing.proof.${key}.l`)}</span>
              </div>
            ))}
          </div>

          {news && (
            <div className="lp-news">
              <span className="lp-news-tag">{t("landing.news.tag")}</span>
              <ul className="lp-news-list">
                {news.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <a
                className="lp-news-link"
                href={i18n.language === "sl" ? "posodobitve/" : "changelog/"}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("landing.news.link")}
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Full-width strip: screenshots straight from the app (Tudor sample).
          One image per theme; CSS shows the one matching data-theme. */}
      <div className="lp-strip">
        <p className="lb-list-h">{t("landing.shots.header")}</p>
        <div className="lb-shots">
          {SHOTS.map(({ key, caption, ext }, i) => (
            <figure key={key} className="lb-shot">
              {/* aria-label keeps this button's accessible name distinct from
                  the app's mode buttons ("Edit", "Merge") — same-named buttons
                  break assistive tech and role-based test selectors. */}
              <button
                type="button"
                className="lb-shot-btn"
                onClick={() => openShot(i)}
                title={t(caption)}
                aria-label={`${t(caption)} — ${t("landing.shots.header")}`}
              >
                <img className="lb-shot-dark" src={`landing/${key}-dark${suffix}.${ext}`} alt={t(caption)} loading="lazy" />
                <img className="lb-shot-light" src={`landing/${key}-light${suffix}.${ext}`} alt={t(caption)} loading="lazy" />
                <span className="lb-shot-zoom" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                </span>
              </button>
              <figcaption>{t(caption)}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}
