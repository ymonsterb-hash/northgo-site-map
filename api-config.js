// Classroom homework path: GitHub Pages → Cloudflare Worker + D1.
// Local / Cursor-hosted app can leave this blank for same-origin.
window.NORTHGO_API_BASE = "";
if (typeof location !== "undefined" && location.hostname === "ymonsterb-hash.github.io") {
  window.NORTHGO_API_BASE = "https://northgo-inquiry-crud.almondine-canopy.workers.dev";
}
