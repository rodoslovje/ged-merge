import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "guide"] },
  tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Only the two long-stable rules — the newer v5 rules (refs,
      // set-state-in-effect, immutability) flag too many intentional patterns.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // TypeScript already enforces these via strict tsconfig.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
