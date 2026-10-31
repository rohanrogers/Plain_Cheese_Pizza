import { mkdir, copyFile } from "node:fs/promises";
await mkdir("frontend/vendor", { recursive: true });
await copyFile(
  "node_modules/chart.js/dist/chart.umd.js",
  "frontend/vendor/chart.umd.js",
);
await copyFile(
  "node_modules/chart.js/LICENSE.md",
  "frontend/vendor/CHART-LICENSE.md",
);
