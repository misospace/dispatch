/*
 * Theme initialiser, loaded render-blocking from <head> (see src/app/layout.tsx).
 *
 * Lives in a static file served from 'self' rather than inline because the
 * CSP tightened in #829 sets `script-src 'self'` with no 'unsafe-inline',
 * nonce, or hash. An inline copy of this script is blocked by the policy and
 * the theme class is never applied (dark mode silently dies, dispatch#841).
 *
 * A classic (non-module, non-defer) script in <head> is render-blocking, so
 * it still runs before first paint — no flash of the wrong theme.
 *
 * Keep this in sync with the storage key and preference fallback used by
 * src/components/theme-toggle.tsx.
 */
(function () {
  var theme = localStorage.getItem("dispatch-theme");
  if (theme === "dark" || (!theme && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.classList.add("dark");
  }
})();
