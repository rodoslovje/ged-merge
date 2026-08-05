import { useTranslation } from "react-i18next";
import { SHORTCUT_GROUPS, renderKeyToken, type ShortcutGroup, type ShortcutItem } from "../keyboard/shortcuts";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";

interface Props {
  isOpen: boolean;
  onClose: () => void;
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

function ShortcutsGroup({ group }: { group: ShortcutGroup }) {
  const { t } = useTranslation();
  return (
    <section className="shortcuts-group">
      <h3>{t(group.titleKey)}</h3>
      <dl>
        {group.items.map((item) => (
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

/**
 * The keyboard cheat sheet — opened with `?` / F1, or from the User's Guide and
 * footer. Renders straight from `SHORTCUT_GROUPS`, so it always matches the
 * live bindings. Standard (modifier) and app-specific (bare-key) groups are
 * split with a legend so the two kinds stay visually distinct.
 */
export function ShortcutsModal({ isOpen, onClose }: Props) {
  const { t } = useTranslation();
  const ref = useModalKeyboard(isOpen, onClose);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
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
          <button className="modal-close" onClick={onClose} title={t("help.close")} aria-label={t("help.close")}>
            ×
          </button>
        </div>
        <div className="modal-body">
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
          <div className="shortcuts-grid">
            {(["left", "right"] as const).map((column) => (
              <div key={column} className="shortcuts-col">
                {SHORTCUT_GROUPS.filter((group) => group.column === column).map((group) => (
                  <ShortcutsGroup key={group.titleKey} group={group} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
