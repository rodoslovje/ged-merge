import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "guide"] },
  tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Only the two long-stable rules — the plugin's newer rules (refs,
      // set-state-in-effect, immutability) flag too many intentional patterns.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // TypeScript already enforces these via strict tsconfig.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // A Playwright call that is not awaited passes or fails by luck: the test
    // moves on before the click or the assertion has happened. Type-aware, so
    // these two rules are worth their cost here and nowhere else.
    files: ["e2e/**/*.ts"],
    languageOptions: { parserOptions: { project: "./tsconfig.e2e.json", tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
);
