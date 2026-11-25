// Default: same-origin (Cursor-hosted app / local npm start).
// GitHub Pages is static, so only that host sets the published API origin.
window.NORTHGO_API_BASE = "";
if (typeof location !== "undefined" && location.hostname === "ymonsterb-hash.github.io") {
  window.NORTHGO_API_BASE = "https://northgo-inquiry.apps.grok.bot";
}
