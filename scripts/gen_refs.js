// Generate location starting-frame images with Runware → assets/refs/<id>.jpg
// FastH3 takes no reference images; these are used as `starting_frame` to open a
// clip in the right place. Run: node scripts/gen_refs.js
//
// NOTE: request shape written from Runware's public REST API (api.runware.ai/v1,
// taskType imageInference). If it 4xxs, check https://docs.runware.ai — model id
// can be overridden with RUNWARE_MODEL.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const OUT = path.join(ROOT, "assets", "refs");

// .env loader
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const API_KEY = process.env.RUNWARE_API_KEY;
if (!API_KEY) { console.error("RUNWARE_API_KEY not set in .env"); process.exit(1); }
const MODEL = process.env.RUNWARE_MODEL || "runware:101@1";

const STYLE = "1897 Victorian gothic, cinematic film still, first-person eye-level, muted candlelight palette, photorealistic, no people in frame";
const SCENES = {
  harker_room: `A Victorian bedroom at night seen from the bed: canopy posts framing the view, dark oak panelling, a guttering candle on the nightstand, moonlight through lace curtains, a heavy closed door. ${STYLE}`,
  castle_hall: `The torchlit great hall of a Transylvanian castle: cold stone, a wide staircase, iron-bound doors, centuries of dust in the torchlight. ${STYLE}`,
  whitby_cliff: `A clifftop at Whitby under storm light: ruined abbey above, grey sea below, leaning gravestones in coarse grass. ${STYLE}`,
  asylum: `A gaslit asylum corridor at night: barred windows, green-tiled walls, a long row of locked doors. ${STYLE}`,
  graveyard: `A London churchyard at night: yew trees, leaning headstones, a marble family tomb with an iron door, moonlit mist. ${STYLE}`,
};

fs.mkdirSync(OUT, { recursive: true });

const tasks = Object.entries(SCENES).map(([id, positivePrompt]) => ({
  taskType: "imageInference",
  taskUUID: crypto.randomUUID(),
  positivePrompt,
  model: MODEL,
  width: 1344,
  height: 768,
  numberResults: 1,
  outputFormat: "JPEG",
  _id: id,
}));

const res = await fetch("https://api.runware.ai/v1", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
  body: JSON.stringify(tasks.map(({ _id, ...t }) => t)),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`Runware ${res.status}:`, JSON.stringify(body)); process.exit(1); }
if (body.errors?.length) console.error("Runware errors:", JSON.stringify(body.errors));

const byUUID = new Map(tasks.map((t) => [t.taskUUID, t._id]));
for (const item of body.data || []) {
  const id = byUUID.get(item.taskUUID);
  if (!id || !item.imageURL) continue;
  const img = await fetch(item.imageURL);
  fs.writeFileSync(path.join(OUT, `${id}.jpg`), Buffer.from(await img.arrayBuffer()));
  console.log(`saved assets/refs/${id}.jpg`);
}
console.log("done — images are served at /refs/<id>.jpg");
