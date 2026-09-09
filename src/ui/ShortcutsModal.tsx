import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  SHORTCUT_GROUPS,
  itemScope,
  renderKeyToken,
  type ShortcutGroup,
  type ShortcutItem,
  type ShortcutScope,
} from "../keyboard/shortcuts";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";
import { Wordmark } from "./icons/LogoMark";

/** Where the printed sheet says it came from. */
const SITE_URL = "gedmerge.com";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Where the user is. The sheet then leads with the keys that work there
   *  and lists the rest under "Elsewhere". Omitted on the landing page. */
  context?: ShortcutScope;
}

/**
 * The keys of one shortcut. Chords that share their modifiers state them once,
 * on a line of their own with the keys that differ beneath — "⌥⇧" over
 * "F / M / P / C" rather than the same modifiers four times across the column,
 * which is wider still where they are spelled Alt and Shift.
 */
function Combo({ item }: { item: ShortcutItem }) {
  // Only worth hoisting when the modifiers actually repeat: a lone ⌘S reads
  // better on one line than stacked.
  const shared: string[] = [];
  const first = item.keys[0] ?? [];
  if (item.keys.length > 1) {
    for (let i = 0; i < first.length - 1; i++) {
      const token = first[i];
      if (!MODIFIERS.has(token) || !item.keys.every((chord) => chord[i] === token)) break;
      shared.push(token);
    }
  }
  const rest = item.keys.map((chord) => chord.slice(shared.length));
  const separator = item.sep === "range" ? "–" : "/";
  return (
    <span className="kbd-combo">
      {shared.length > 0 && (
        <span className="kbd-mods">
          {shared.map((token, i) => (
            <kbd key={`m${i}`}>{renderKeyToken(token)}</kbd>
          ))}
        </span>
      )}
      <span className="kbd-keys">
        {rest.map((chord, ci) => (
          <span key={ci} className="kbd-chord">
            {ci > 0 && <span className="kbd-or">{separator}</span>}
            {chord.map((token, ti) => (
              <kbd key={ti}>{renderKeyToken(token)}</kbd>
            ))}
          </span>
        ))}
      </span>
    </span>
  );
}

const MODIFIERS = new Set(["mod", "alt", "shift"]);

/** A group with the subset of its items a section shows. */
interface Shown {
  group: ShortcutGroup;
  items: ShortcutItem[];
}

function ShortcutsGroup({ group, items }: Shown) {
  const { t } = useTranslation();
  return (
    <section className="shortcuts-group">
      <h3>{t(group.titleKey)}</h3>
      <dl>
        {items.map((item) => (
          <div className="shortcuts-row" key={item.descKey}>
            <dt>
              <Combo item={item} />
            </dt>
            <dd>{t(item.descKey)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The cheat sheet's columns: the groups flow into three, each kept whole.
 *  The legend, where the grid carries it, heads the first column rather
 *  than taking a row of its own above all three. */
function Columns({ shown, legend }: { shown: Shown[]; legend?: React.ReactNode }) {
  return (
    <div className="shortcuts-grid">
      {legend}
      {shown.map((s) => (
        <ShortcutsGroup key={s.group.titleKey} {...s} />
      ))}
    </div>
  );
}

/** On paper the columns are set by hand — flowing columns fragment across
 *  pages unpredictably — so the three fill one A4 landscape page evenly. */
const PRINT_COLUMNS = [
  ["shortcuts.group.general", "shortcuts.group.charts"],
  ["shortcuts.group.modes", "shortcuts.group.navigation"],
  ["shortcuts.group.editing", "shortcuts.group.decisions"],
];

function PrintColumns({ shown }: { shown: Shown[] }) {
  return (
    <div className="shortcuts-grid shortcuts-grid-print">
      {PRINT_COLUMNS.map((titles, i) => (
        <div key={i} className="shortcuts-col">
          {titles
            .map((title) => shown.find((s) => s.group.titleKey === title))
            .filter((s): s is Shown => !!s)
            .map((s) => (
              <ShortcutsGroup key={s.group.titleKey} {...s} />
            ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The keyboard cheat sheet — opened with `?` / F1, the header's ? button, or
 * from the User's Guide and footer. Renders straight from `SHORTCUT_GROUPS`,
 * so it always matches the live bindings. Standard (modifier) and
 * app-specific (bare-key) groups are split with a legend so the two kinds
 * stay visually distinct. Given where the user is, the keys that work there
 * come first, under "Here", and the rest under "Elsewhere".
 *
 * Printing (the Print button, or the browser's own) yields the whole sheet
 * on A4 landscape, in its natural groups: the dialog is portalled beside the
 * app root, which the print stylesheet hides, and marks the document while
 * it is open so that stylesheet knows what to print.
 */
export function ShortcutsModal({ isOpen, onClose, context }: Props) {
  const { t } = useTranslation();
  const ref = useModalKeyboard(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return;
    document.documentElement.classList.add("printing-shortcuts");
    return () => document.documentElement.classList.remove("printing-shortcuts");
  }, [isOpen]);

  if (!isOpen) return null;

  const all: Shown[] = SHORTCUT_GROUPS.map((group) => ({ group, items: group.items }));
  const here: Shown[] = [];
  const elsewhere: Shown[] = [];
  if (context) {
    for (const group of SHORTCUT_GROUPS) {
      const near = group.items.filter((item) => {
        const scope = itemScope(group, item);
        return !scope || scope.includes(context);
      });
      const far = group.items.filter((item) => !near.includes(item));
      if (near.length) here.push({ group, items: near });
      if (far.length) elsewhere.push({ group, items: far });
    }
  }
  const where = context === "chart" ? t("edit.charts.button") : context ? t(`mode.${context}`) : "";
  const legend = (
    <p className="shortcuts-legend">
      <span className="shortcuts-legend-item">
        <kbd>{renderKeyToken("mod")}</kbd>
        <span>{t("shortcuts.legend.standard")}</span>
      </span>
      <span className="shortcuts-legend-item">
        <kbd>A</kbd>
        <span>{t("shortcuts.legend.app")}</span>
      </span>
    </p>
  );

  return createPortal(
    <div className="modal-overlay shortcuts-print-root" onClick={onClose}>
      <div
        className="modal shortcuts-modal"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcuts.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{t("shortcuts.title")}</h2>
          <button className="tree-open-btn shortcuts-print-btn" onClick={() => window.print()} title={t("shortcuts.print")}>
            {t("sheets.print")}
          </button>
          <button className="modal-close" onClick={onClose} title={t("help.close")} aria-label={t("help.close")}>
            ×
          </button>
        </div>
        <div className="modal-body">
          {/* On screen: the keys for where the user is, then the rest. */}
          <div className="shortcuts-screen">
            {context ? (
              <>
                <h3 className="shortcuts-section">{t("shortcuts.section.here", { where })}</h3>
                <Columns shown={here} legend={legend} />
                {elsewhere.length > 0 && (
                  <>
                    <h3 className="shortcuts-section">{t("shortcuts.section.elsewhere")}</h3>
                    <Columns shown={elsewhere} />
                  </>
                )}
              </>
            ) : (
              <Columns shown={all} legend={legend} />
            )}
          </div>
          {/* On paper: the whole sheet, in its groups — a reference card,
              headed by the mark and the address it came from. */}
          <div className="shortcuts-print">
            <div className="shortcuts-print-head">
              <Wordmark size={13} />
              <span className="shortcuts-print-title">{t("shortcuts.title")}</span>
              <span className="shortcuts-print-url">{SITE_URL}</span>
            </div>
            <PrintColumns shown={all} />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
