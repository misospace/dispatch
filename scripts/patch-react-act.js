#!/usr/bin/env node
/**
 * Postinstall script: patches react-dom-test-utils for React 19 + Vitest compat.
 * React 19 removed `React.act` which react-dom/test-utils depends on.
 */
const fs = require("fs");
const path = require("path");

const pkgRoot = path.join(__dirname, "..", "node_modules", "react-dom", "cjs");
const files = ["react-dom-test-utils.production.js", "react-dom-test-utils.development.js"];

for (const file of files) {
  const filePath = path.join(pkgRoot, file);
  if (!fs.existsSync(filePath)) continue;
  
  let content = fs.readFileSync(filePath, "utf8");
  
  // Check if already patched
  if (content.includes("PATCHED for Vitest")) continue;
  
  // Insert patch after `didWarnAboutUsingAct = !1;` line
  // The original code has: var React = require("react"),\n  didWarnAboutUsingAct = !1;
  const patch = `

// PATCHED for Vitest + React 19 compat
if (typeof React !== 'undefined' && typeof React.act !== 'function') {
  Object.defineProperty(React, "act", {
    value: function act(cb) { return typeof cb === "function" ? cb() : cb; },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}`;

  const patched = content.replace(
    /didWarnAboutUsingAct = !1;/,
    `didWarnAboutUsingAct = !1;` + patch
  );
  
  fs.writeFileSync(filePath, patched);
  console.log(`Patched: ${filePath}`);
}
