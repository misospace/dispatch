#!/usr/bin/env node
// Assert the page's own inline scripts survive its Content-Security-Policy.
//
// dispatch 0.5.41 tightened script-src to 'self' (#829) while layout.tsx still
// initialised the theme from an inline dangerouslySetInnerHTML block. The
// browser blocked it and dark mode stopped working. CI stayed green because the
// test asserted the policy string rather than whether the page's scripts could
// run under it. This checks the relationship instead of either side alone.
//
// Usage: node scripts/smoke-csp.mjs http://dispatch:3000

const base = process.argv[2];
if (!base) {
  console.error("usage: smoke-csp.mjs <base-url>");
  process.exit(2);
}

const res = await fetch(base, { redirect: "manual" });
const html = await res.text();
const csp =
  res.headers.get("content-security-policy") ??
  res.headers.get("content-security-policy-report-only");

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
