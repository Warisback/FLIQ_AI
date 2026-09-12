// Phase 1 smoke test (runs in the browser at /smoke.html — Reactor sessions are
// WebRTC, so Node can't hold one without native deps).
// Flow: connect → enqueue one Dracula clip with a spoken line → wait clip_generated
// → play → human checks video/audio/speech intelligibility. Logs EVERY event.

import { Reactor } from "@reactor-team/js-sdk";

const logEl = document.getElementById("log");
const video = document.getElementById("video");
const log = (line) => {
  const ts = new Date().toISOString().slice(11, 23);
  logEl.textContent += `[${ts}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log(`[smoke ${ts}]`, line);
};

const TEST_PROMPT =
  'First-person POV of a traveller standing in the torchlit great hall of a gothic castle at night, 1897: ' +
  'cold stone walls, iron-bound doors, dust hanging in the torchlight. A tall pale nobleman in black descends ' +
  'a wide staircase toward the viewer, arms open. Slow push-in. He speaks, S1: "Welcome to my house. ' +
  'Enter freely, and of your own will." Torches crackle, footsteps echo on stone, wind moans high in the tower.';

let reactor = null;
const mediaStream = new MediaStream();
const generatedWaiters = new Map();

async function connect() {
  if (reactor) return;
  log("POST /api/token …");
  const res = await fetch("/api/token", { method: "POST" });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const { jwt, model } = await res.json();
  log(`token ok, model=${model}`);

  reactor = new Reactor({ modelName: model });
  reactor.on("statusChanged", (s) => log(`status → ${s}`));
  reactor.on("trackReceived", (name, track, stream) => {
    log(`trackReceived: name=${name} kind=${track.kind}`);
    mediaStream.addTrack(track);
    video.srcObject = mediaStream;
    video.play().catch((e) => log(`video.play blocked: ${e.message} — click the video`));
  });
  reactor.on("message", (msg) => {
    log(`event: ${JSON.stringify(msg).slice(0, 400)}`);
    const type = msg?.type, data = msg?.data ?? msg;
    if ((type === "clip_generated" || type === "clip_failed") && data?.clip?.clip_id) {
      generatedWaiters.get(data.clip.clip_id)?.(type === "clip_failed" ? new Error("clip_failed") : null);
      generatedWaiters.delete(data.clip.clip_id);
    }
  });
  reactor.on("error", (e) => log(`ERROR: ${JSON.stringify(e)}`));
  reactor.on("schemaReceived", (s) => log(`schemaReceived: commands=${Object.keys(s?.commands || s || {}).join(",").slice(0, 300)}`));

  log("connecting…");
  await reactor.connect(jwt);
  log(`connected, session=${reactor.getSessionId?.() ?? "?"}`);
  await reactor.sendCommand("set_canvas", { aspect: "16:9" });
  await reactor.sendCommand("set_clip_seconds", { seconds: 8 });
  await reactor.sendCommand("set_autoplay", { enabled: false });
}

async function runSmoke(withFrame) {
  const t0 = performance.now();
  await connect();

  const params = { prompt: TEST_PROMPT };
  if (withFrame) {
    // Optional variant: upload a starting frame first (any image at /refs/castle_hall.jpg).
    const imgRes = await fetch("/refs/castle_hall.jpg");
    if (!imgRes.ok) { log("no /assets/refs/castle_hall.jpg — run scripts/gen_refs.js first; falling back to text-only"); }
    else {
      const blob = await imgRes.blob();
      const file = new File([blob], "castle_hall.jpg", { type: "image/jpeg" });
      const ref = await reactor.uploadFile(file);
      log(`uploaded starting frame: ${JSON.stringify(ref)}`);
      params.starting_frame = ref;
    }
  }

  log(`enqueue: "${TEST_PROMPT.slice(0, 80)}…"`);
  const reply = await reactor.sendCommand("enqueue", params);
  log(`enqueue reply: ${JSON.stringify(reply).slice(0, 400)}`);
  const clip = reply?.clip || reply?.data?.clip;
  if (!clip?.clip_id) throw new Error("no clip_id in enqueue reply");

  log(`waiting for clip_generated (${clip.clip_id})…`);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout: no clip_generated in 90s")), 90000);
    generatedWaiters.set(clip.clip_id, (err) => { clearTimeout(t); err ? reject(err) : resolve(); });
  });
  log(`clip generated in ${Math.round((performance.now() - t0) / 1000)}s — playing`);
  await reactor.sendCommand("play", { clip_id: clip.clip_id });
  log("PLAYING — now judge: video? audio? is the spoken line intelligible? Tick the boxes above.");
}

document.getElementById("run").onclick = () =>
  runSmoke(false).catch((e) => log(`SMOKE FAILED: ${e.message}`));
document.getElementById("run-frame").onclick = () =>
  runSmoke(true).catch((e) => log(`SMOKE FAILED: ${e.message}`));
document.getElementById("close").onclick = async () => {
  try { await reactor?.disconnect(false); } catch {}
  reactor = null;
  log("session closed (stop the billing meter!)");
};
window.addEventListener("beforeunload", () => { try { reactor?.disconnect(false); } catch {} });
