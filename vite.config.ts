import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath, type Plugin } from "vite";

const ADJUSTMENTS_FILE = fileURLToPath(new URL("./src/adjustments.json", import.meta.url));
// Windows drive letters can differ in case between the watcher and import.meta.url.
const isAdjustmentsFile = (file: string) => normalizePath(file).toLowerCase() === normalizePath(ADJUSTMENTS_FILE).toLowerCase();

// Lets the Debug panel's "Save" button write src/adjustments.json (dev server only).
function saveAdjustments(): Plugin {
  return {
    name: "save-adjustments",
    apply: "serve",
    // The page already shows what it saved; don't reload it when the file changes.
    hotUpdate({ file }) {
      if (isAdjustmentsFile(file)) return [];
    },
    configureServer(server) {
      server.middlewares.use("/__save-adjustments", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            const data = JSON.parse(body);
            if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("expected an object");
            await writeFile(ADJUSTMENTS_FILE, JSON.stringify(data, null, 2) + "\n");
            res.statusCode = 204;
            res.end();
          } catch (error) {
            res.statusCode = 400;
            res.end(String(error));
          }
        });
      });
    }
  };
}

export default defineConfig({
  plugins: [saveAdjustments()],
  // maplibre-gl v6 loads its web worker relative to its own module URL,
  // which breaks if Vite pre-bundles it into node_modules/.vite/deps.
  optimizeDeps: { exclude: ["maplibre-gl"] }
});
