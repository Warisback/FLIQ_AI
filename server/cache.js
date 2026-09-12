// Clip cache: cache/<sha1(prompt)>.webm (recorded playback) + .json (prompt metadata).
// The browser records each clip as it plays and POSTs it here; demo mode replays.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = path.join(here, "..", "cache");

fs.mkdirSync(CACHE_DIR, { recursive: true });

export function clipHash(prompt) {
  return crypto.createHash("sha1").update(prompt, "utf8").digest("hex");
}

export function clipPath(hash) {
  return path.join(CACHE_DIR, `${hash}.webm`);
}

export function hasClip(hash) {
  return /^[0-9a-f]{40}$/.test(hash) && fs.existsSync(clipPath(hash));
}

export function saveClipMeta(hash, meta) {
  fs.writeFileSync(
    path.join(CACHE_DIR, `${hash}.json`),
    JSON.stringify(meta, null, 2),
  );
}

export function listClips() {
  return fs.readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith(".webm"))
    .map((f) => f.replace(/\.webm$/, ""));
}
