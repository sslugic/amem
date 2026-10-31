// Lint for the shipped TypeScript (src/). Three rules matter here:
// - no floating promises: an unhandled rejection can kill the MCP server or a hook
// - no unused vars
// - no console.log outside the CLI and the app shell: the MCP server speaks JSON-RPC on
//   stdout, so a stray log line there corrupts the protocol stream
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "shop/**", "desktop/**", "test/**", "scripts/**", "bench/**", "ui-static/**"] },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    files: ["src/cli.ts", "src/app-shell.ts"],
    rules: { "no-console": "off" },
  },
);
