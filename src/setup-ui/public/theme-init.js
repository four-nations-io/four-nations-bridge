// Four Nations Bridge — setup UI theme bootstrap.
//
// Runs SYNCHRONOUSLY in <head> (before first paint) so the resolved theme is on
// <html> with no flash-of-wrong-theme. Order of preference:
//   1. the user's saved choice (localStorage 'fnBridgeTheme')
//   2. the OS preference (prefers-color-scheme)
// Loaded as an external file rather than inline so it satisfies the page's CSP
// (script-src 'self'; inline scripts are blocked). The toggle wiring + live OS
// change handling live in app.js.
(function () {
  try {
    var saved = localStorage.getItem('fnBridgeTheme');
    var theme =
      saved === 'light' || saved === 'dark'
        ? saved
        : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    // No storage / matchMedia (very old or locked-down browser) — default dark.
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
