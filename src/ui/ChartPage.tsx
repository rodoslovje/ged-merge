import type { ReactNode } from "react";
import { BackButton } from "./BackButton";

// The shared full-page chart/report scaffold: Back button + title toolbar with
// the settings/export actions on the right, then the controls row (kind
// switcher and direction toggle left, legend right). Every hub page (pedigree
// trees, relationship, timeline, report) renders inside this one skeleton, so
// the layout and its CSS hooks stay identical across kinds; the pages differ
// only in what they pour into the slots and the canvas below.

interface Props {
  /** Translated label for where Back lands. */
  backLabel: string;
  onBack: () => void;
  /** Contents of the page's `<h2 class="tree-title">`. */
  title: ReactNode;
  /** Toolbar controls right of the title (ChartSettings + ExportMenu). */
  actions?: ReactNode;
  /** Left side of the controls row (kind switcher, direction toggle). The row
   *  is omitted entirely when both sides are empty. */
  controlsLeft?: ReactNode;
  /** Right side of the controls row (the legend). */
  controlsRight?: ReactNode;
  /** Everything below the controls row: any extra control rows, then the
   *  canvas wrap with its overlays (minimap, zoom, detail panel). */
  children: ReactNode;
}

export function ChartPage({ backLabel, onBack, title, actions, controlsLeft, controlsRight, children }: Props) {
  return (
    <div className="tree-page">
      <div className="tree-toolbar">
        <BackButton label={backLabel} shortcutHint="Esc" onClick={onBack} />
        <h2 className="tree-title">{title}</h2>
        {actions}
      </div>
      {(controlsLeft || controlsRight) && (
        <div className="tree-controls">
          <div className="tree-controls-left">{controlsLeft}</div>
          {controlsRight}
        </div>
      )}
      {children}
    </div>
  );
}
