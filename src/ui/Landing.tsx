import { useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { SlotState } from "../App";
import { pickFile, fileFromDrop, supportsFilePicker } from "./filePicker";
import { AddPersonIcon } from "./icons/AddPersonIcon";

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

const FEATURES: { key: string; icon: React.ReactNode }[] = [
  {
    key: "intact",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3l7 2.6v5.1c0 4.4-3 7.4-7 8.9-4-1.5-7-4.5-7-8.9V5.6z" />
        <polyline points="9 12 11.3 14.3 15.5 9.6" />
      </svg>
    ),
  },
  {
    key: "score",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3.4" />
        <line x1="12" y1="1.6" x2="12" y2="4.2" />
        <line x1="12" y1="19.8" x2="12" y2="22.4" />
      </svg>
    ),
  },
  {
    key: "compare",
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
    key: "edit",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    ),
  },
  {
    key: "dates",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <line x1="4" y1="7" x2="20" y2="7" />
        <line x1="4" y1="12" x2="14" y2="12" />
        <line x1="4" y1="17" x2="18" y2="17" />
      </svg>
    ),
  },
  {
    key: "export",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <polyline points="14 3 14 8 19 8" />
        <polyline points="8.6 14.5 10.8 16.7 15 12" />
      </svg>
    ),
  },
  {
    key: "local",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="13" rx="1.6" />
        <line x1="8.5" y1="20.5" x2="15.5" y2="20.5" />
        <line x1="12" y1="17" x2="12" y2="20.5" />
      </svg>
    ),
  },
];

const TreeIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="6.5" cy="5" r="2.2" />
    <circle cx="17.5" cy="5" r="2.2" />
    <circle cx="12" cy="19" r="2.2" />
    <path d="M6.5 7.2v3.3a2 2 0 0 0 2 2H12M17.5 7.2v3.3a2 2 0 0 1-2 2H12M12 12.5v4.3" />
  </svg>
);

export function Landing({ mainState, onLoadFile, onLoadSample, onStartNew }: Props) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

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
      {/* Left: main loader */}
      <div className="lb-left">
        <p className="lb-eyebrow">{t("landing.eyebrow")}</p>
        <h1 className="lb-h1">
          <Trans i18nKey="landing.h1">
            Edit, compare &amp; merge GEDCOM — <em>100% in your browser</em>.
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
            <span className="lb-dz-accepts">{t("landing.dropzone.accepts")}</span>
          </div>
        )}

        {mainState.status === "error" && (
          <p className="lb-error error">
            {t("loader.error", { fileName: mainState.fileName, message: mainState.message })}
          </p>
        )}

        {/* Sample tray — kept mounted while loading (disabled) so the layout doesn't shift */}
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
            <div className="lb-sample-rows">
              {SAMPLES.map(({ key, file }) => (
                <button
                  key={key}
                  className="lb-sample-row"
                  onClick={() => onLoadSample(file)}
                  type="button"
                  disabled={loading}
                  tabIndex={loading ? -1 : undefined}
                >
                  <span className="lb-s-ico">
                    <TreeIcon />
                  </span>
                  <span className="lb-s-main">
                    <span className="lb-s-name">{t(`landing.samples.${key}.name`)}</span>
                    <span className="lb-s-meta">{t(`landing.samples.${key}.meta`)}</span>
                  </span>
                  <span className="lb-s-load">{t("landing.samples.load")}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Nothing to import: begin from an empty file and add the first person
            by hand. Same tray shape as the samples above — it is the other way
            to arrive at a tree without a file of your own. */}
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
      </div>

      {/* Right: What GED Merge does */}
      <div className="lb-list">
        <p className="lb-list-h">{t("landing.list.header")}</p>
        {FEATURES.map(({ key, icon }, i) => (
          <div key={key} className={`lb-feat${i === 0 ? " lead" : ""}`}>
            <span className="lb-feat-ico">{icon}</span>
            <div>
              <h4>{t(`landing.feat.${key}.title`)}</h4>
              <p>{t(`landing.feat.${key}.body`)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
