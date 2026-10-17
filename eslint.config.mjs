import jsdoc from "eslint-plugin-jsdoc";
import tseslint from "typescript-eslint";
import perfectionist from "eslint-plugin-perfectionist";

/**
 * ESLint Configuration
 *
 * Enforces the house style: imports and class members ordered short to long,
 * grouped by kind, and JSDoc blocks on every class, function, and export.
 */
export default tseslint.config(
  {
    ignores: ["**/*.js", "**/*.d.ts", "cdk.out/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mts", "**/*.mjs"],
    plugins: { jsdoc, perfectionist },
    rules: {
      /**
       * Import ordering: named imports, then namespace imports, then type
       * imports, each group separated by a blank line and sorted by line
       * length ascending.
       */
      "perfectionist/sort-imports": [
        "error",
        {
          type: "line-length",
          order: "asc",
          newlinesBetween: 1,
          groups: [
            "side-effect",
            "value-named-import",
            "value-default-import",
            "value-wildcard-import",
            "type-import",
          ],
        },
      ],
      "perfectionist/sort-named-imports": [
        "error",
        { type: "alphabetical", order: "asc" },
      ],
      "perfectionist/sort-classes": [
        "error",
        {
          type: "line-length",
          order: "asc",
          groups: ["property", "constructor", "method"],
        },
      ],
      "perfectionist/sort-interfaces": [
        "error",
        { type: "line-length", order: "asc" },
      ],

      /**
       * JSDoc: every class, method, function, interface, and exported
       * declaration carries a block with a description.
       */
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: false,
          require: {
            ClassDeclaration: true,
            FunctionDeclaration: true,
          },
          contexts: [
            'MethodDefinition[kind!="constructor"]',
            'ExportNamedDeclaration[declaration.type="VariableDeclaration"]',
            "TSInterfaceDeclaration",
          ],
        },
      ],
      "jsdoc/require-description": "error",

      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: { "jsdoc/require-jsdoc": "off" },
  },
);
