// UNDERSTUDY server: static files + token exchange + Director endpoints + clip cache.
// Zero web-framework deps; Node 18+ (global fetch).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStoryPack, initialState, entryFor, applyPatch, pushTranscript } from "./state.js";
import { CACHE_DIR, clipHash, clipPath, hasClip, saveClipMeta, listClips } from "./cache.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");

// ---- .env loader (no dep) ----
try {
  const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* no .env yet — fine for static-only dev */ }

const PORT = Number(process.env.PORT || 3000);
const MODEL_SLUG = "reactor/fast-h3"; // verified: docs.reactor.inc/model-api-reference/fast-h3/overview
const DIALOGUE_IN_CLIP = (process.env.DIALOGUE_IN_CLIP ?? "true") !== "false";
const DEMO_MODE = process.env.DEMO_MODE === "true";

// Director is imported lazily so the page + smoke test work without an Anthropic key.
let director = null;
async function getDirector() {
  if (!director) director = await import("./director.js");
  return director;
}

const storyPack = loadStoryPack();
let state = initialState(storyPack);

// ---- Reactor token exchange (API key never leaves the server) ----
let tokenCache = null; // { jwt, expires_at }
async function reactorToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expires_at - now > 120) return tokenCache;
  const key = process.env.REACTOR_API_KEY;
  if (!key) throw new Error("REACTOR_API_KEY is not set in .env");
  const res = await fetch("https://api.reactor.inc/tokens", {
    method: "POST",
    headers: { "Reactor-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      expires_after: 3600,
      authorization_details: [{
        type: "session",
        resources: { models: { match: [MODEL_SLUG] } },
        constraints: { max_sessions: 5 },
      }],
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  tokenCache = await res.json();
  return tokenCache;
}

// ---- turn / skip / branch logic ----
async function handleTurn(playerLine) {
  const d = await getDirector();

  // Speculative branches pending? Try to match first (fast small call).
  if (state.pending_branches.length > 0) {
    const branches = state.pending_branches;
    let idx = -1;
    try {
      idx = await d.matchBranch(playerLine, branches);
    } catch (err) {
      console.error(`[branch-match] failed, falling through to normal turn: ${err.message}`);
    }
    state.pending_branches = [];
    if (idx >= 0) {
      const b = branches[idx];
      pushTranscript(state, state.player_character, playerLine);
      pushTranscript(state, b.npc_speaker, b.npc_line);
      applyPatch(state, b.state_patch);
      console.log(`[turn] branch ${idx} matched: "${b.trigger}"`);
      return {
        type: "branch", index: idx,
        npc_line: b.npc_line, npc_speaker: b.npc_speaker,
        clip_prompt: b.clip_prompt, clip_hash: clipHash(b.clip_prompt),
        branches: [],
      };
    }
  }

  const t0 = Date.now();
  const result = await d.directorTurn(state, storyPack, playerLine, DIALOGUE_IN_CLIP);
  console.log(`[turn] director ${Date.now() - t0}ms | ${result.npc_speaker}: ${result.npc_line}`);
  pushTranscript(state, state.player_character, playerLine);
  pushTranscript(state, result.npc_speaker, result.npc_line);
  applyPatch(state, result.state_patch);
  state.pending_branches = result.branches;
  return {
    type: "turn",
    npc_line: result.npc_line, npc_speaker: result.npc_speaker,
    clip_prompt: result.clip_prompt, clip_hash: clipHash(result.clip_prompt),
    branches: result.branches.map((b, i) => ({
      index: i, trigger: b.trigger, clip_prompt: b.clip_prompt, clip_hash: clipHash(b.clip_prompt),
    })),
  };
}

async function handleSkip(timeTarget) {
  const d = await getDirector();
  state.pending_branches = [];
  const t0 = Date.now();
  const result = await d.directorSkip(state, storyPack, timeTarget, DIALOGUE_IN_CLIP);
  console.log(`[skip] director ${Date.now() - t0}ms → ${timeTarget}`);
  pushTranscript(state, "narrator", `— skip to ${timeTarget} —`);
  if (result.npc_line) pushTranscript(state, result.npc_speaker, result.npc_line);
  applyPatch(state, result.state_patch);
  if (!result.state_patch.time) state.time = timeTarget;
  return {
    type: "skip",
    npc_line: result.npc_line, npc_speaker: result.npc_speaker,
    clip_prompt: result.clip_prompt, clip_hash: clipHash(result.clip_prompt),
    branches: [],
  };
}

// ---- HTTP plumbing ----
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css", ".json": "application/json", ".webm": "video/webm",
  ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".wasm": "application/wasm",
};

// The SDK's wasm core is imported at runtime relative to the page bundle
// (it can't be inlined by esbuild) — serve it from node_modules.
const WASM_DIR = path.join(ROOT, "node_modules", "@reactor-team", "js-sdk", "dist", "wasm");

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req, limit = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  return buf.length ? JSON.parse(buf.toString("utf8")) : {};
}

function serveFile(res, filePath, method) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return false; }
  if (!stat.isFile()) return false;
  const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size });
  if (method === "HEAD") { res.end(); return true; }
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // --- API ---
    if (p === "/api/token" && req.method === "POST") {
      const tok = await reactorToken();
      return json(res, 200, { jwt: tok.jwt, expires_at: tok.expires_at, model: MODEL_SLUG });
    }
    if (p === "/api/config" && req.method === "GET") {
      return json(res, 200, {
        model: MODEL_SLUG,
        dialogueInClip: DIALOGUE_IN_CLIP,
        demoMode: DEMO_MODE,
        // SPECULATE=false lightens FastH3 load when the venue is slammed
        speculate: process.env.SPECULATE !== "false",
      });
    }
    if (p === "/api/state" && req.method === "GET") {
      return json(res, 200, state);
    }
    if (p === "/api/story" && req.method === "GET") {
      return json(res, 200, storyPack);
    }
    if (p === "/api/reset" && req.method === "POST") {
      const body = await readJson(req);
      state = initialState(storyPack, body.player_character);
      const entry = entryFor(storyPack, state.player_character);
      console.log(`[reset] player_character=${state.player_character}`);
      return json(res, 200, {
        ok: true,
        opening: {
          npc_line: entry.opening_npc_line,
          npc_speaker: entry.opening_npc_speaker,
          clip_prompt: entry.opening_clip_prompt,
          clip_hash: clipHash(entry.opening_clip_prompt),
        },
      });
    }
    if (p === "/api/turn" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.transcript?.trim()) return json(res, 400, { error: "transcript required" });
      return json(res, 200, await handleTurn(body.transcript.trim()));
    }
    if (p === "/api/skip" && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, await handleSkip(body.time?.trim() || "dawn"));
    }
    if (p === "/api/cache" && req.method === "GET") {
      return json(res, 200, { clips: listClips() });
    }
    const cacheMatch = p.match(/^\/api\/cache\/([0-9a-f]{40})$/);
    if (cacheMatch) {
      const hash = cacheMatch[1];
      if (req.method === "POST") {
        const buf = await readBody(req);
        fs.writeFileSync(clipPath(hash), buf);
        saveClipMeta(hash, { prompt: url.searchParams.get("prompt") || "", saved_at: new Date().toISOString(), bytes: buf.length });
        console.log(`[cache] saved ${hash} (${buf.length} bytes)`);
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" || req.method === "HEAD") {
        if (!hasClip(hash)) return json(res, 404, { error: "not cached" });
        return void serveFile(res, clipPath(hash), req.method);
      }
    }

    // --- static ---
    if (req.method === "GET" || req.method === "HEAD") {
      const wasmMatch = p.match(/^\/wasm\/([A-Za-z0-9_.-]+)$/);
      if (wasmMatch && serveFile(res, path.join(WASM_DIR, wasmMatch[1]), req.method)) return;
      const route = p === "/" ? "/index.html" : p;
      const safe = path.normalize(route).replace(/^([/\\]|\.\.)+/, "");
      for (const base of ["web", "assets"]) {
        if (serveFile(res, path.join(ROOT, base, safe), req.method)) return;
      }
    }
    json(res, 404, { error: `no route: ${req.method} ${p}` });
  } catch (err) {
    console.error(`[error] ${req.method} ${p}: ${err.stack || err.message}`);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`UNDERSTUDY on http://localhost:${PORT}  (model: ${MODEL_SLUG}, dialogue_in_clip: ${DIALOGUE_IN_CLIP}, demo_mode: ${DEMO_MODE})`);
  console.log(`cache dir: ${CACHE_DIR} (${listClips().length} clips)`);
});

// The browser owns the Reactor session; nothing to close here. Ctrl+C exits clean.
process.on("SIGINT", () => { console.log("\nbye"); process.exit(0); });
