#!/usr/bin/env node
// Assert the page's own inline scripts survive its Content-Security-Policy.
//
// dispatch 0.5.41 tightened script-src to 'self' (#829) while layout.tsx still
// initialised the theme from an inline dangerouslySetInnerHTML block. The
// browser blocked it and dark mode stopped working. CI stayed green because the
// test asserted the policy string rather than whether the page's scripts could
// run under it. This checks the relationship instead of either side alone.
//
// Usage:
//   node scripts/smoke-csp.mjs http://dispatch:3000        fetch it directly
//   node scripts/smoke-csp.mjs --raw-response <file>       parse a saved response
//
// The --raw-response form takes the output of `curl -i` (status line, headers,
// blank line, body). CI uses it so the request is made from inside the cluster
// rather than from the runner: the runner is a long-lived pod, and immediately
// after the app's pod IP changes its connection to the Service times out while
// fresh in-cluster pods reach the same address fine. That asymmetry failed the
// assertion repeatedly without anything being wrong with the app.

import { readFile } from "node:fs/promises";

const [arg1, arg2] = process.argv.slice(2);
let html;
let csp;
let source;

if (arg1 === "--raw-response") {
  if (!arg2) {
    console.error("usage: smoke-csp.mjs --raw-response <file>");
    process.exit(2);
  }
  source = arg2;
  const raw = await readFile(arg2, "utf8");
  // curl -i emits CRLF between headers; tolerate both. The first blank line
  // ends the header block, and a proxy may prepend a 100-continue block.
  const parts = raw.split(/\r?\n\r?\n/);
  const headerBlock = parts.shift() ?? "";
  html = parts.join("\n\n");
  const header = (name) =>
    headerBlock
      .split(/\r?\n/)
      .find((l) => l.toLowerCase().startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .trim();
  csp = header("content-security-policy") ?? header("content-security-policy-report-only");
} else {
  if (!arg1) {
    console.error("usage: smoke-csp.mjs <base-url> | --raw-response <file>");
    process.exit(2);
  }
  source = arg1;
  const res = await fetch(arg1, { redirect: "manual" });
  html = await res.text();
  csp =
    res.headers.get("content-security-policy") ??
    res.headers.get("content-security-policy-report-only");
}

const base = source;

if (!csp) {
  console.error(`FAIL no Content-Security-Policy header on ${base}`);
  process.exit(1);
}

const scriptSrc =
  csp.match(/(?:^|;)\s*script-src\b([^;]*)/i)?.[1]?.trim() ??
  csp.match(/(?:^|;)\s*default-src\b([^;]*)/i)?.[1]?.trim();

if (scriptSrc === undefined) {
  console.log("OK  no script-src or default-src directive; nothing constrains scripts");
  process.exit(0);
}

const tokens = scriptSrc.split(/\s+/).filter(Boolean);
const allowsInline = tokens.includes("'unsafe-inline'");
const nonces = tokens
  .filter((t) => /^'nonce-/.test(t))
  .map((t) => t.replace(/^'nonce-|'$/g, ""));
const hashes = tokens.filter((t) => /^'(sha256|sha384|sha512)-/.test(t));

// Inline = a <script> element with no src attribute. Non-JS types (importmap,
// application/json, speculationrules) are also gated by script-src, so they
// count; only an explicitly non-executable type would not, and dispatch has none.
const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attrs]) => !/\bsrc\s*=/.test(attrs))
  .filter(([, , body]) => body.trim().length > 0)
  .map(([, attrs, body]) => ({
    nonce: attrs.match(/\bnonce\s*=\s*["']([^"']+)["']/i)?.[1] ?? null,
    preview: body.trim().slice(0, 80).replace(/\s+/g, " "),
  }));

if (inline.length === 0) {
  console.log(`OK  script-src is "${scriptSrc}" and the page has no inline scripts`);
  process.exit(0);
}

if (allowsInline) {
  console.log(
    `OK  ${inline.length} inline script(s) permitted by 'unsafe-inline'. ` +
      `Worth removing eventually, but nothing is blocked.`,
  );
  process.exit(0);
}

const blocked = inline.filter((s) => !(s.nonce && nonces.includes(s.nonce)));

if (blocked.length > 0) {
  console.error(
    `FAIL script-src is "${scriptSrc}" but ${blocked.length} of ${inline.length} ` +
      `inline script(s) carry no matching nonce, so the browser will block them:`,
  );
  for (const s of blocked) console.error(`  - ${s.preview}`);
  if (hashes.length > 0) {
    console.error(
      `note: the policy carries ${hashes.length} hash source(s); this check cannot ` +
        `verify hashes, so if these scripts are hash-allowlisted, add their nonce ` +
        `or teach this script to compute the digests.`,
    );
  }
  process.exit(1);
}

console.log(`OK  all ${inline.length} inline script(s) carry a nonce allowed by script-src`);
