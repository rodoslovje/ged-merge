import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePopoverKeyboard } from "../keyboard/usePopoverKeyboard";
import { BackButton } from "./BackButton";
import { ChartTrailNav } from "./ChartTrail";
import { MenuIcon } from "./icons/MenuIcon";
import { usePhone } from "./usePhone";

// The shared full-page chart/report scaffold: Back button + title toolbar with
// the settings/export actions on the right, then the controls row (kind
// switcher and direction toggle left, legend right). Every hub page (pedigree
// trees, relationship, timeline, report) renders inside this one skeleton, so
// the layout and its CSS hooks stay identical across kinds; the pages differ
// only in what they pour into the slots and the canvas below.
//
// On a phone the toolbar is one row — Back, the title, a ☰ — and the actions
// and the controls row fold into the ☰'s panel, so the chart keeps the screen.

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
  const phone = usePhone();
  const hasControls = !!(controlsLeft || controlsRight);
  return (
    <div className="tree-page">
      <div className="tree-toolbar">
        <BackButton label={backLabel} shortcutHint="Esc" onClick={onBack} />
        <ChartTrailNav />
        <h2 className="tree-title">{title}</h2>
        {phone ? (
          <ChartMenu>
            {actions && <div className="chart-menu-actions">{actions}</div>}
            {hasControls && (
              <div className="tree-controls chart-menu-controls">
                <div className="tree-controls-left">{controlsLeft}</div>
                {controlsRight}
              </div>
            )}
          </ChartMenu>
        ) : (
          actions
        )}
      </div>
      {!phone && hasControls && (
        <div className="tree-controls">
          <div className="tree-controls-left">{controlsLeft}</div>
          {controlsRight}
        </div>
      )}
      {children}
    </div>
  );
}

/** The phone chart's ☰: a toggle and the panel holding the chart's controls. */
function ChartMenu({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { containerRef, triggerRef, onTriggerKeyDown } = usePopoverKeyboard(open, setOpen);
  return (
    <div className="chart-menu" ref={containerRef}>
      <button
        ref={triggerRef}
        className={`nav-btn icon-only chart-menu-btn${open ? " open" : ""}`}
        onClick={() => setOpen(!open)}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="true"
        aria-expanded={open}
        title={t("chart.menu.title")}
        aria-label={t("chart.menu.title")}
      >
        <MenuIcon size={18} />
      </button>
      {open && <div className="chart-menu-panel">{children}</div>}
    </div>
  );
}
