import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { AddMediaDialog } from "../AddMediaDialog";
import { useMediaFolder } from "../MediaFolderContext";
import { basename } from "../mediaPath";

/**
 * The family website's cover photo: a file of the media folder, shown on the
 * front page and as a shared link's picture. The author's own choice, so it
 * goes in whoever is on it (see `planSitePhotos`); a link preview needs the
 * website's address to find it.
 */
export function PublishCover({ dataset, value, hasUrl, onChange }: {
  dataset: Dataset;
  /** The chosen file's path in the media folder; "" for none. */
  value: string;
  hasUrl: boolean;
  onChange: (path: string) => void;
}) {
  const { t } = useTranslation();
  const media = useMediaFolder();
  const [picking, setPicking] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (value) void media.resolveFile(value).then((url) => { if (live) setThumb(url); });
    return () => { live = false; };
  }, [value, media]);

  return (
    <div className="tools-publish-cover">
      <div className="tools-publish-cover-row">
        <span>{t("tools.publish.cover")}</span>
        {value && thumb && <img className="tools-publish-cover-thumb" src={thumb} alt="" />}
        {value && <span className="tools-publish-cover-name" title={value}>{basename(value)}</span>}
        <button type="button" className="tools-issue-link" onClick={() => setPicking(true)}>
          {t(value ? "tools.publish.coverChange" : "tools.publish.coverChoose")}
        </button>
        {value && (
          <button type="button" className="tools-issue-link" onClick={() => onChange("")}>{t("tools.publish.coverRemove")}</button>
        )}
      </div>
      <p className="tools-fix-hint">{t(hasUrl ? "tools.publish.coverHint" : "tools.publish.coverNoUrl")}</p>
      <AddMediaDialog
        isOpen={picking}
        onClose={() => setPicking(false)}
        onAdd={(picked) => { if (picked[0]) onChange(picked[0].path); }}
        dataset={dataset}
        t={t}
        single={{ title: t("tools.publish.cover"), pick: t("tools.publish.coverPick") }}
      />
    </div>
  );
}
