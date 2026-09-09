import { renderKeyToken } from "../keyboard/shortcuts";

/**
 * A row of keycaps beside a list's controls — the keys that drive the list,
 * shown where they apply rather than only in the sheet behind `?`. Tokens
 * are the registry's ("mod", "alt", "shift" are spelled for the platform).
 */
export function KeyHint({ keys, title }: { keys: readonly string[]; title: string }) {
  return (
    <span className="key-hint" title={title} aria-label={title}>
      {keys.map((k, i) => (
        <kbd key={i}>{renderKeyToken(k)}</kbd>
      ))}
    </span>
  );
}
