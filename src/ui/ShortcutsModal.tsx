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

/** The two-column cheat-sheet grid, each group in the column it asks for. */
function Columns({ shown }: { shown: Shown[] }) {
  return (
    <div className="shortcuts-grid">
      {(["left", "right"] as const).map((column) => (
        <div key={column} className="shortcuts-col">
          {shown
            .filter(({ group }) => group.column === column)
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
 */
export function ShortcutsModal({ isOpen, onClose, context }: Props) {
  const { t } = useTranslation();
  const ref = useModalKeyboard(isOpen, onClose);

  if (!isOpen) return null;

  const here: Shown[] = [];
  const elsewhere: Shown[] = [];
  for (const group of SHORTCUT_GROUPS) {
    if (!context) {
      here.push({ group, items: group.items });
      continue;
    }
    const near = group.items.filter((item) => {
      const scope = itemScope(group, item);
      return !scope || scope.includes(context);
    });
    const far = group.items.filter((item) => !near.includes(item));
    if (near.length) here.push({ group, items: near });
    if (far.length) elsewhere.push({ group, items: far });
  }
  const where = context === "chart" ? t("edit.charts.button") : context ? t(`mode.${context}`) : "";

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
          {context && <h3 className="shortcuts-section">{t("shortcuts.section.here", { where })}</h3>}
          <Columns shown={here} />
          {context && elsewhere.length > 0 && (
            <>
              <h3 className="shortcuts-section">{t("shortcuts.section.elsewhere")}</h3>
              <Columns shown={elsewhere} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
