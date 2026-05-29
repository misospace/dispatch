import { fixupConfigRules } from "@eslint/compat";
import nextVitals from "eslint-config-next/core-web-vitals";

function patchParser(parser) {
  return {
    ...parser,
    parseForESLint(code, options) {
      const result = parser.parseForESLint(code, options);

      if (result.scopeManager && !result.scopeManager.addGlobals) {
        result.scopeManager.addGlobals = (names) => {
          const globalScope = result.scopeManager.globalScope ?? result.scopeManager.scopes[0];
          if (globalScope?.addVariables) {
            globalScope.addVariables(names);
            return;
          }

          for (const name of names) {
            if (!globalScope?.set?.has(name)) {
              const variable = { name, identifiers: [], references: [] };
              globalScope?.set?.set(name, variable);
              globalScope?.variables?.push(variable);
            }
          }
        };
      }

      return result;
    },
  };
}

const config = [
  { ignores: [".next/**", "out/**", "build/**", "next-env.d.ts", "vitest/dist/**"] },
  ...fixupConfigRules(nextVitals).map((config) => ({
    ...config,
    rules: {
      ...config.rules,
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
    ...(config.languageOptions
      ? {
          languageOptions: {
            ...config.languageOptions,
            ...(config.languageOptions.parser
              ? { parser: patchParser(config.languageOptions.parser) }
              : {}),
          },
        }
      : {}),
  })),
];

export default config;
