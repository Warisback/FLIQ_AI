// UNDERSTUDY client: Reactor session, mic, Director turns, speculative branching,
// clip recording (the cache parachute), and the demo UI.
// Bundled with esbuild → /bundle.js. The Reactor API key never reaches this file.

import { Reactor } from "@reactor-team/js-sdk";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const ui = {
  picker: $("picker"), dot: $("status-dot"), statusText: $("status-text"),
  demoBadge: $("demo-badge"), connect: $("btn-connect"), disconnect: $("btn-disconnect"),
  stateBtn: $("btn-state"), pregen: $("btn-pregen"),
  liveVideo: $("live-video"), cachedVideo: $("cached-video"),
  subtitle: $("subtitle"), stageNote: $("stage-note"),
  transcript: $("transcript"), statePanel: $("state-panel"), stateJson: $("state-json"),
  mic: $("mic"), typed: $("typed"), send: $("send"), skip: $("skip"), log: $("log"),
};

// ---------- config / state ----------
let config = { model: "reactor/fast-h3", dialogueInClip: true, demoMode: false };
let reactor = null;
let mediaStream = new MediaStream();
let lastPlayedClipId = null;      // for continue_from_clip_id visual continuity
let currentTurnToken = 0;         // invalidates stale async work after a newer turn
let speculative = [];             // [{index, clip_id, clip_hash, prompt}]
const generated = new Set();      // clip_ids whose clip_generated has fired
const generatedWaiters = new Map(); // clip_id -> resolve()
const clipHashById = new Map();   // clip_id -> cache hash (for recording)
const clipPromptById = new Map();
let recorder = null, recordingHash = null, recordingChunks = [];
let idleTimer = null;

const log = (line) => {
  const ts = new Date().toISOString().slice(11, 23);
  ui.log.textContent += `[${ts}] ${line}\n`;
  ui.log.scrollTop = ui.log.scrollHeight;
  console.log(`[understudy ${ts}]`, line);
};

// ---------- session ----------
async function connect() {
  if (reactor) return;
  setStatus("connecting");
  const res = await fetch("/api/token", { method: "POST" });
  if (!res.ok) { setStatus("disconnected"); log(`token exchange failed: ${await res.text()}`); return; }
  const { jwt, model } = await res.json();

  reactor = new Reactor({ modelName: model });

  reactor.on("statusChanged", (status) => {
    setStatus(status);
    log(`status → ${status}`);
  });
  reactor.on("trackReceived", (name, track, stream) => {
    log(`trackReceived: ${name} (${track.kind})`);
    mediaStream.addTrack(track);
    ui.liveVideo.srcObject = mediaStream;
    ui.liveVideo.play().catch(() => note("click the video to start playback"));
  });
  reactor.on("message", (msg) => {
    const type = msg?.type ?? "?";
    const data = msg?.data ?? msg;
    log(`event: ${type} ${briefly(data)}`);
    if (type === "clip_generated" && data?.clip?.clip_id) {
      generated.add(data.clip.clip_id);
      generatedWaiters.get(data.clip.clip_id)?.();
      generatedWaiters.delete(data.clip.clip_id);
    }
    if (type === "clip_started" && data?.clip?.clip_id) {
      lastPlayedClipId = data.clip.clip_id;
      startRecording(data.clip.clip_id);
    }
    if (type === "clip_finished" || type === "clip_stopped") stopRecording();
    if (type === "clip_failed" && data?.clip?.clip_id) {
      log(`CLIP FAILED: ${data.clip.clip_id}`);
      generatedWaiters.get(data.clip.clip_id)?.("failed");
      generatedWaiters.delete(data.clip.clip_id);
    }
    if (type === "command_error") log(`COMMAND ERROR: ${data?.command}: ${data?.reason}`);
  });
  reactor.on("error", (err) => log(`reactor error [${err?.code}] ${err?.message} (recoverable: ${err?.recoverable})`));

  await reactor.connect(jwt);
  await reactor.sendCommand("set_canvas", { aspect: "16:9" });
  await reactor.sendCommand("set_clip_seconds", { seconds: 8 });
  await reactor.sendCommand("set_autoplay", { enabled: false });
  ui.connect.disabled = true;
  ui.disconnect.disabled = false;
  touchIdle();
}

async function disconnect() {
  if (!reactor) return;
  try { await reactor.disconnect(false); } catch {}
  reactor = null;
  mediaStream = new MediaStream();
  setStatus("disconnected");
  ui.connect.disabled = false;
  ui.disconnect.disabled = true;
  log("session closed");
}

function setStatus(status) {
  ui.dot.className = `dot ${status}`;
  ui.statusText.textContent = status;
}

// Billing is per second of open session: auto-close after 3 idle minutes.
function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (reactor) { log("idle 3 min — closing session to stop the meter"); disconnect(); note("session closed (idle) — Connect to resume"); }
  }, 3 * 60 * 1000);
}

window.addEventListener("beforeunload", () => { try { reactor?.disconnect(false); } catch {} });

// ---------- clips ----------
async function enqueueClip(prompt, { continueFrom = null, hash = null } = {}) {
  const params = { prompt };
  if (continueFrom) params.continue_from_clip_id = continueFrom;
  const reply = await reactor.sendCommand("enqueue", params);
  const clip = reply?.clip || reply?.data?.clip;
  if (!clip?.clip_id) { log(`enqueue reply had no clip_id: ${briefly(reply)}`); return null; }
  if (hash) clipHashById.set(clip.clip_id, hash);
  clipPromptById.set(clip.clip_id, prompt);
  log(`enqueued ${clip.clip_id.slice(0, 8)}… "${prompt.slice(0, 60)}…"`);
  return clip.clip_id;
}

function waitGenerated(clipId, timeoutMs = 45000) {
  if (generated.has(clipId)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { generatedWaiters.delete(clipId); reject(new Error("generation timeout")); }, timeoutMs);
    generatedWaiters.set(clipId, (failed) => {
      clearTimeout(t);
      failed ? reject(new Error("clip_failed")) : resolve();
    });
  });
}

async function playClip(clipId) {
  hideCached();
  await reactor.sendCommand("play", { clip_id: clipId });
}

async function popClip(clipId) {
  try { await reactor.sendCommand("pop", { clip_id: clipId }); } catch {}
}

// ---------- cache parachute ----------
async function cacheHas(hash) {
  try { return (await fetch(`/api/cache/${hash}`, { method: "HEAD" })).ok; } catch { return false; }
}

function playCached(hash, npcLine) {
  ui.cachedVideo.src = `/api/cache/${hash}`;
  ui.cachedVideo.style.display = "block";
  ui.cachedVideo.onended = hideCached;
  ui.cachedVideo.play().catch(() => note("click the video to play"));
  note("replaying from cache");
  log(`cache replay ${hash.slice(0, 8)}…`);
}

function hideCached() {
  ui.cachedVideo.style.display = "none";
  ui.cachedVideo.pause();
  note("");
}

function startRecording(clipId) {
  const hash = clipHashById.get(clipId);
  if (!hash || mediaStream.getTracks().length === 0) return;
  try {
    stopRecording();
    recordingHash = hash;
    recordingChunks = [];
    recorder = new MediaRecorder(mediaStream, { mimeType: pickMime() });
    recorder.ondataavailable = (e) => { if (e.data.size) recordingChunks.push(e.data); };
    recorder.onstop = () => uploadRecording(recordingHash, clipPromptById.get(clipId) || "");
    recorder.start();
  } catch (e) { log(`recorder unavailable: ${e.message}`); recorder = null; }
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
  recorder = null;
}

function pickMime() {
  for (const m of ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

async function uploadRecording(hash, prompt) {
  const blob = new Blob(recordingChunks, { type: "video/webm" });
  recordingChunks = [];
  if (blob.size < 20000) return; // too short to be a real clip
  try {
    await fetch(`/api/cache/${hash}?prompt=${encodeURIComponent(prompt.slice(0, 200))}`, { method: "POST", body: blob });
    log(`cached clip ${hash.slice(0, 8)}… (${Math.round(blob.size / 1024)} KB)`);
  } catch (e) { log(`cache upload failed: ${e.message}`); }
}

// ---------- the beat pipeline ----------
// Show the line immediately, then get the clip on screen by the fastest route.
async function runBeat(beat, { chain = true } = {}) {
  const token = ++currentTurnToken;
  showSubtitle(beat.npc_speaker, beat.npc_line);
  if (beat.npc_line) addTranscript(beat.npc_speaker, beat.npc_line);
  if (!config.dialogueInClip && beat.npc_line) speak(beat.npc_line);

  // Demo mode: cached clip wins outright, no session cost.
  if (config.demoMode && await cacheHas(beat.clip_hash)) return playCached(beat.clip_hash);

  if (!reactor) {
    if (await cacheHas(beat.clip_hash)) return playCached(beat.clip_hash);
    return note("not connected — no live generation and no cached clip");
  }

  const clipId = await enqueueClip(beat.clip_prompt, {
    continueFrom: chain ? lastPlayedClipId : null,
    hash: beat.clip_hash,
  });
  if (!clipId) return;

  // Speculative branches ride behind the main clip.
  await enqueueBranches(beat.branches || [], clipId);

  try {
    note("the world is forming…");
    await waitGenerated(clipId);
    if (token !== currentTurnToken) return; // player already moved on
    note("");
    await playClip(clipId);
  } catch (err) {
    log(`live clip lost (${err.message}) — trying cache`);
    if (await cacheHas(beat.clip_hash)) playCached(beat.clip_hash);
    else note("clip lost to the night — say something else");
  }
}

async function enqueueBranches(branches, afterClipId) {
  speculative = [];
  for (const b of branches) {
    const clipId = await enqueueClip(b.clip_prompt, { continueFrom: afterClipId, hash: b.clip_hash });
    if (clipId) speculative.push({ index: b.index, clip_id: clipId, clip_hash: b.clip_hash, trigger: b.trigger });
  }
  if (speculative.length) log(`speculating: ${speculative.map((s) => `"${s.trigger}"`).join(" | ")}`);
}

async function dropSpeculative(exceptClipId = null) {
  for (const s of speculative) if (s.clip_id !== exceptClipId) await popClip(s.clip_id);
  speculative = [];
}

// ---------- turns ----------
async function takeTurn(text) {
  if (!text.trim()) return;
  touchIdle();
  addTranscript("you", text);
  ui.typed.value = "";
  setBusy(true);
  try {
    const t0 = performance.now();
    const res = await fetch("/api/turn", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: text }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const beat = await res.json();
    log(`director replied in ${Math.round(performance.now() - t0)}ms (${beat.type})`);

    if (beat.type === "branch") {
      // The predicted future already exists in the queue — play it now.
      const s = speculative.find((x) => x.index === beat.index);
      showSubtitle(beat.npc_speaker, beat.npc_line);
      addTranscript(beat.npc_speaker, beat.npc_line);
      if (!config.dialogueInClip) speak(beat.npc_line);
      await dropSpeculative(s?.clip_id);
      if (s && reactor) {
        try {
          await waitGenerated(s.clip_id);
          await playClip(s.clip_id);
        } catch {
          if (await cacheHas(beat.clip_hash)) playCached(beat.clip_hash);
        }
      } else if (await cacheHas(beat.clip_hash)) {
        playCached(beat.clip_hash);
      }
    } else {
      await dropSpeculative();
      await runBeat(beat);
    }
    refreshState();
  } catch (err) {
    log(`turn failed: ${err.message}`);
    note(`turn failed: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

async function skipTo(time) {
  touchIdle();
  addTranscript("—", `skip to ${time}`);
  setBusy(true);
  try {
    await dropSpeculative();
    const res = await fetch("/api/skip", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ time }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const beat = await res.json();
    await runBeat(beat, { chain: false }); // hard cut across time
    refreshState();
  } catch (err) {
    log(`skip failed: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

async function startStory(character) {
  const res = await fetch("/api/reset", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player_character: character }),
  });
  const { opening } = await res.json();
  ui.picker.style.display = "none";
  if (!reactor && !config.demoMode) await connect().catch((e) => log(`connect failed: ${e.message}`));
  await runBeat({ ...opening, branches: [] }, { chain: false });
  refreshState();
}

// ---------- pre-generation (Phase 5 parachute) ----------
async function pregenForks() {
  if (!reactor) await connect();
  const story = await (await fetch("/api/story")).json();
  const prompts = [
    { label: "opening", prompt: story.entry.opening_clip_prompt },
    ...story.forks.map((f) => ({ label: `fork ${f.id}: ${f.title}`, prompt: f.dawn_clip_prompt })),
  ];
  for (const { label, prompt } of prompts) {
    const hash = await sha1(prompt);
    if (await cacheHas(hash)) { log(`pregen: ${label} already cached`); continue; }
    note(`pre-generating ${label}…`);
    const clipId = await enqueueClip(prompt, { hash });
    if (!clipId) continue;
    try {
      await waitGenerated(clipId, 90000);
      await playClip(clipId); // it must play to be recorded
      await waitClipEnd();
    } catch (e) { log(`pregen ${label} failed: ${e.message}`); }
  }
  note("pre-generation done");
}

function waitClipEnd() {
  return new Promise((resolve) => {
    const handler = (msg) => {
      if (msg?.type === "clip_finished" || msg?.type === "clip_stopped") {
        reactor.off("message", handler);
        setTimeout(resolve, 400); // let the recorder flush
      }
    };
    reactor.on("message", handler);
    setTimeout(() => { reactor?.off("message", handler); resolve(); }, 30000);
  });
}

async function sha1(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- voice ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
if (SR) {
  recognition = new SR();
  recognition.lang = "en-GB";
  recognition.interimResults = true;
  recognition.onresult = (e) => {
    const text = [...e.results].map((r) => r[0].transcript).join("");
    ui.typed.value = text;
    if (e.results[e.results.length - 1].isFinal) { stopMic(); takeTurn(text); }
  };
  recognition.onerror = (e) => { log(`speech error: ${e.error} — type instead`); stopMic(); };
  recognition.onend = stopMic;
}

function startMic() {
  if (!recognition) return note("no speech recognition in this browser — type instead");
  ui.mic.classList.add("listening");
  recognition.start();
}
function stopMic() {
  ui.mic.classList.remove("listening");
  try { recognition?.stop(); } catch {}
}

function speak(line) {
  try {
    const u = new SpeechSynthesisUtterance(line);
    u.rate = 0.95; u.pitch = 0.8;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}

// ---------- small UI ----------
function showSubtitle(speaker, line) {
  if (!line) { ui.subtitle.innerHTML = ""; return; }
  ui.subtitle.innerHTML = `<span class="speaker">${esc(displayName(speaker))}</span>“${esc(line)}”`;
  clearTimeout(showSubtitle.t);
  showSubtitle.t = setTimeout(() => { ui.subtitle.innerHTML = ""; }, 12000);
}

function addTranscript(speaker, line) {
  const div = document.createElement("div");
  div.innerHTML = `<span class="who">${esc(displayName(speaker))}:</span> ${esc(line)}`;
  ui.transcript.appendChild(div);
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

function displayName(id) {
  return { mina: "Mina", jonathan: "Jonathan", van_helsing: "Van Helsing", dracula: "The Count", lucy: "Lucy", seward: "Dr Seward", you: "You", narrator: "—", "—": "—" }[id] || id || "";
}

async function refreshState() {
  const state = await (await fetch("/api/state")).json();
  const { transcript, pending_branches, characters, ...rest } = state;
  ui.stateJson.textContent = JSON.stringify({ ...rest, characters }, null, 1);
}

function note(text) { ui.stageNote.textContent = text; }
function setBusy(busy) { ui.send.disabled = busy; ui.skip.disabled = busy; ui.mic.disabled = busy; }
function esc(s) { const d = document.createElement("span"); d.textContent = String(s); return d.innerHTML; }
function briefly(o) { const s = JSON.stringify(o) || ""; return s.length > 220 ? s.slice(0, 220) + "…" : s; }

// ---------- wiring ----------
ui.connect.onclick = () => connect().catch((e) => { log(`connect failed: ${e.message}`); setStatus("disconnected"); });
ui.disconnect.onclick = disconnect;
ui.send.onclick = () => takeTurn(ui.typed.value);
ui.typed.addEventListener("keydown", (e) => { if (e.key === "Enter") takeTurn(ui.typed.value); });
ui.skip.onclick = () => skipTo("dawn");
ui.mic.onclick = () => (ui.mic.classList.contains("listening") ? stopMic() : startMic());
ui.stateBtn.onclick = () => {
  ui.statePanel.style.display = ui.statePanel.style.display === "block" ? "none" : "block";
  refreshState();
};
ui.pregen.onclick = () => pregenForks().catch((e) => log(`pregen failed: ${e.message}`));
ui.liveVideo.onclick = () => ui.liveVideo.play().catch(() => {});
for (const card of document.querySelectorAll("#picker .card")) {
  card.onclick = () => startStory(card.dataset.character).catch((e) => log(`start failed: ${e.message}`));
}

// ---------- boot ----------
(async () => {
  config = await (await fetch("/api/config")).json();
  ui.demoBadge.hidden = !config.demoMode;
  log(`config: model=${config.model} dialogue_in_clip=${config.dialogueInClip} demo=${config.demoMode}`);
})();
