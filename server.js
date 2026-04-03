/**
 * Minimal static server for production (e.g. Render Web Service).
 * Serves Vite build output from ./dist (resolved against several possible layouts).
 */
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDistDir() {
  const candidates = [
    path.join(__dirname, "dist"),
    path.join(__dirname, "..", "dist"),
    path.join(process.cwd(), "dist"),
    path.join(process.cwd(), "..", "dist"),
  ];
  for (const dir of candidates) {
    const index = path.join(dir, "index.html");
    if (fs.existsSync(index)) {
      return path.resolve(dir);
    }
  }
  return null;
}

const dist = resolveDistDir();
const app = express();
const port = Number(process.env.PORT) || 3000;

if (!dist) {
  const tried = [
    path.join(__dirname, "dist"),
    path.join(__dirname, "..", "dist"),
    path.join(process.cwd(), "dist"),
    path.join(process.cwd(), "..", "dist"),
  ];
  console.error(
    "[server] No dist/index.html found. Tried:",
    tried.join(", "),
    "\n[server] Run: npm install && npm run build"
  );
  process.exit(1);
}

console.log("[server] Serving static files from", dist);

app.use(express.static(dist));

app.get("*", (_req, res) => {
  res.sendFile(path.join(dist, "index.html"));
});

app.listen(port);
