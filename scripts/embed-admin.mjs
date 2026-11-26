import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(path.join(root, "admin.html"), "utf8").replace(
  /<script src="api-config\.js(?:\?[^"]*)?"><\/script>/u,
  '<script>window.NORTHGO_API_BASE="";</script>'
);
writeFileSync(
  path.join(root, "lib/admin-html.mjs"),
  `// Auto-generated from admin.html — run: npm run embed-admin\nexport default ${JSON.stringify(html)};\n`
);
console.log("embed-admin: wrote lib/admin-html.mjs");
