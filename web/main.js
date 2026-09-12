// UNDERSTUDY client: Reactor session, mic, Director turns, speculative branching,
// clip recording (the cache parachute), and the demo UI.
// Bundled with esbuild → /bundle.js. The Reactor API key never reaches this file.

import { Reactor } from "@reactor-team/js-sdk";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const ui = {
  picker: $("picker"),
  dot: $("status-dot"),
  statusText: $("status-text"),
  demoBadge: $("demo-badge"),
  connect: $("btn-connect"),
  disconnect: $("btn-disconnect"),
  stateBtn: $("btn-state"),
  pregen: $("btn-pregen"),
  liveVideo: $("live-video"),
  cachedVideo: $("cached-video"),
  subtitle: $("subtitle"),
  stageNote: $("stage-note"),
  transcript: $("transcript"),
  statePanel: $("state-panel"),
  stateJson: $("state-json"),
  mic: $("mic"),
  typed: $("typed"),
  send: $("send"),
  skip: $("skip"),
  log: $("log"),
};

// ---------- config / state ----------
let config = {
  model: "reactor/fast-h3",
  dialogueInClip: true,
  demoMode: false,
};
let reactor = null;
let mediaStream = new MediaStream();
let lastPlayedClipId = null; // for continue_from_clip_id visual continuity
let currentTurnToken = 0; // invalidates stale async work after a newer turn
let speculative = []; // [{index, clip_id, clip_hash, prompt}]
const generated = new Set(); // clip_ids whose clip_generated has fired
const generatedWaiters = new Map(); // clip_id -> resolve()
const clipHashById = new Map(); // clip_id -> cache hash (for recording)
const clipPromptById = new Map();
let recorder = null,
  recordingHash = null,
  recordingChunks = [];
let idleTimer = null;
let clipPlaying = false;

// The stage shows exactly one thing: a cached clip, a live clip, or the
// scene artwork. Never the live stream's black between-clips frames.
function updateStage() {
  const cachedShowing = ui.cachedVideo.style.display === "block";
  ui.liveVideo.style.visibility = clipPlaying && !cachedShowing ? "visible" : "hidden";
  $("still-label").hidden = clipPlaying || cachedShowing;
}
let busy = false;
let connectingPromise = null;
let selectedCharacter = new URLSearchParams(location.search).get("character");
if (!["mina", "jonathan"].includes(selectedCharacter)) selectedCharacter = null;

const log = (line) => {
  const ts = new Date().toISOString().slice(11, 23);
  ui.log.textContent += `[${ts}] ${line}\n`;
  ui.log.scrollTop = ui.log.scrollHeight;
  console.log(`[understudy ${ts}]`, line);
};

// ---------- session ----------
async function connect() {
  if (connectingPromise) return connectingPromise;
  connectingPromise = openSession()
    .catch(async (err) => {
      await disconnect();
      throw err;
    })
    .finally(() => {
      connectingPromise = null;
    });
  return connectingPromise;
}

async function openSession() {
  if (reactor) return;
  setStatus("connecting");
  const res = await fetch("/api/token", { method: "POST" });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(
      detail.error ||
        "Live connection is unavailable. Try again from Session controls.",
    );
  }
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
    // The live stream sends black frames BETWEEN clips — the stage artwork
    // stays up except while a clip is actually playing (see updateStage).
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
      clipPlaying = true;
      updateStage();
    }
    // Clips flowing = the demo is in active use; don't idle-close mid-scene.
    if (type === "clip_queued" || type === "clip_generated" || type === "clip_started") touchIdle();
    if (type === "clip_finished" || type === "clip_stopped") {
      stopRecording();
      clipPlaying = false;
      updateStage();
    }
    if (type === "clip_failed" && data?.clip?.clip_id) {
      log(`CLIP FAILED: ${data.clip.clip_id}`);
      generatedWaiters.get(data.clip.clip_id)?.("failed");
      generatedWaiters.delete(data.clip.clip_id);
    }
    if (type === "command_error")
      log(`COMMAND ERROR: ${data?.command}: ${data?.reason}`);
  });
  reactor.on("error", (err) =>
    log(
      `reactor error [${err?.code}] ${err?.message} (recoverable: ${err?.recoverable})`,
    ),
  );

  await reactor.connect(jwt);
  await reactor.sendCommand("set_canvas", { aspect: "16:9" });
  await reactor.sendCommand("set_clip_seconds", { seconds: 8 });
  await reactor.sendCommand("set_autoplay", { enabled: false });
  ui.connect.disabled = true;
  ui.disconnect.disabled = false;
  touchIdle();
}

async function disconnect() {
  clearTimeout(idleTimer);
  ++currentTurnToken;
  stopMic();
  stopRecording();
  try {
    await reactor?.disconnect(false);
  } catch {}
  reactor = null;
  mediaStream.getTracks().forEach((track) => track.stop());
  mediaStream = new MediaStream();
  ui.liveVideo.srcObject = null;
  lastPlayedClipId = null;
  speculative = [];
  generated.clear();
  for (const resolve of generatedWaiters.values()) resolve("disconnected");
  generatedWaiters.clear();
  clipHashById.clear();
  clipPromptById.clear();
  clipPlaying = false;
  updateStage();
  setStatus("disconnected");
  ui.connect.disabled = false;
  ui.disconnect.disabled = true;
  log("session closed");
}

function setStatus(status) {
  ui.dot.className = `dot ${status}`;
  ui.statusText.textContent = status;
}

// Billing is per second of open session: auto-close after 10 idle minutes.
// (Was 3 — it kept cutting the demo off mid-conversation. Reconnection is
// automatic on the next line, see runBeat.)
function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(
    () => {
      if (reactor) {
        log("idle 10 min — closing session to stop the meter");
        disconnect();
        note("Session rested while you were away — it reconnects on your next line.");
      }
    },
    10 * 60 * 1000,
  );
}

window.addEventListener("beforeunload", () => {
  try {
    reactor?.disconnect(false);
  } catch {}
});

// ---------- clips ----------
async function enqueueClip(prompt, { continueFrom = null, hash = null } = {}) {
  const params = { prompt };
  if (continueFrom) params.continue_from_clip_id = continueFrom;
  const reply = await reactor.sendCommand("enqueue", params);
  const clip = reply?.clip || reply?.data?.clip;
  if (!clip?.clip_id) {
    log(`enqueue reply had no clip_id: ${briefly(reply)}`);
    return null;
  }
  if (hash) clipHashById.set(clip.clip_id, hash);
  clipPromptById.set(clip.clip_id, prompt);
  log(`enqueued ${clip.clip_id.slice(0, 8)}… "${prompt.slice(0, 60)}…"`);
  return clip.clip_id;
}

function waitGenerated(clipId, timeoutMs = 45000) {
  if (generated.has(clipId)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      generatedWaiters.delete(clipId);
      reject(new Error("generation timeout"));
    }, timeoutMs);
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
  try {
    await reactor.sendCommand("pop", { clip_id: clipId });
  } catch {}
}

// ---------- cache parachute ----------
async function cacheHas(hash) {
  try {
    return (await fetch(`/api/cache/${hash}`, { method: "HEAD" })).ok;
  } catch {
    return false;
  }
}

function playCached(hash, npcLine) {
  ui.cachedVideo.src = `/api/cache/${hash}`;
  ui.cachedVideo.style.display = "block";
  ui.cachedVideo.onended = hideCached;
  ui.cachedVideo.play().catch(() => note("click the video to play"));
  updateStage();
  note("replaying from cache");
  log(`cache replay ${hash.slice(0, 8)}…`);
}

function hideCached() {
  ui.cachedVideo.style.display = "none";
  ui.cachedVideo.pause();
  updateStage();
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
    recorder.ondataavailable = (e) => {
      if (e.data.size) recordingChunks.push(e.data);
    };
    recorder.onstop = () =>
      uploadRecording(recordingHash, clipPromptById.get(clipId) || "");
    recorder.start();
  } catch (e) {
    log(`recorder unavailable: ${e.message}`);
    recorder = null;
  }
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
  recorder = null;
}

function pickMime() {
  for (const m of [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

async function uploadRecording(hash, prompt) {
  const blob = new Blob(recordingChunks, { type: "video/webm" });
  recordingChunks = [];
  if (blob.size < 20000) return; // too short to be a real clip
  try {
    await fetch(
      `/api/cache/${hash}?prompt=${encodeURIComponent(prompt.slice(0, 200))}`,
      { method: "POST", body: blob },
    );
    log(
      `cached clip ${hash.slice(0, 8)}… (${Math.round(blob.size / 1024)} KB)`,
    );
  } catch (e) {
    log(`cache upload failed: ${e.message}`);
  }
}

// ---------- the beat pipeline ----------
// Show the line immediately, then get the clip on screen by the fastest route.
async function runBeat(beat, { chain = true } = {}) {
  const token = ++currentTurnToken;
  showSubtitle(beat.npc_speaker, beat.npc_line);
  if (beat.npc_line) addTranscript(beat.npc_speaker, beat.npc_line);
  if (!config.dialogueInClip && beat.npc_line) speak(beat.npc_line);

  // Demo mode: cached clip wins outright, no session cost.
  if (config.demoMode && (await cacheHas(beat.clip_hash)))
    return playCached(beat.clip_hash);

  // Dropped or idle-closed session? Reconnect in place — the show goes on.
  if (!reactor && !config.demoMode) {
    log("no session — reconnecting");
    await connect().catch((e) => log(`reconnect failed: ${e.message}`));
  }
  if (!reactor) {
    if (await cacheHas(beat.clip_hash)) return playCached(beat.clip_hash);
    return note("not connected — no live generation and no cached clip");
  }

  let clipId = await enqueueClip(beat.clip_prompt, {
    continueFrom: chain ? lastPlayedClipId : null,
    hash: beat.clip_hash,
  });
  if (!clipId) return;

  // Speculative branches ride behind the main clip. They multiply generation
  // load — the server can turn them off (SPECULATE=false) when the venue is slow.
  if (config.speculate !== false) await enqueueBranches(beat.branches || [], clipId);

  // Under event load generation can take a minute-plus. The subtitle is already
  // up and the artwork holds the stage, so wait long and retry a failed clip once.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      note("the world is forming…");
      await waitGenerated(clipId, 120000);
      if (token !== currentTurnToken) return; // player already moved on
      note("");
      await playClip(clipId);
      return;
    } catch (err) {
      if (token !== currentTurnToken) return;
      if (err.message === "clip_failed" && attempt === 1) {
        log("clip failed — re-enqueueing once");
        clipId = await enqueueClip(beat.clip_prompt, {
          continueFrom: chain ? lastPlayedClipId : null,
          hash: beat.clip_hash,
        });
        if (clipId) continue;
      }
      log(`live clip lost (${err.message}) — trying cache`);
      if (await cacheHas(beat.clip_hash)) playCached(beat.clip_hash);
      else note("the vision escaped us — say something else");
      return;
    }
  }
}

async function enqueueBranches(branches, afterClipId) {
  speculative = [];
  for (const b of branches) {
    const clipId = await enqueueClip(b.clip_prompt, {
      continueFrom: afterClipId,
      hash: b.clip_hash,
    });
    if (clipId)
      speculative.push({
        index: b.index,
        clip_id: clipId,
        clip_hash: b.clip_hash,
        trigger: b.trigger,
      });
  }
  if (speculative.length)
    log(`speculating: ${speculative.map((s) => `"${s.trigger}"`).join(" | ")}`);
}

async function dropSpeculative(exceptClipId = null) {
  for (const s of speculative)
    if (s.clip_id !== exceptClipId) await popClip(s.clip_id);
  speculative = [];
}

// ---------- turns ----------
async function takeTurn(text) {
  if (busy || !text.trim()) return;
  if (/^skip (?:to |ahead to )?(?:dawn|morning)[.!]?$/i.test(text.trim())) {
    ui.typed.value = "";
    return skipTo("dawn");
  }
  touchIdle();
  addTranscript("you", text);
  ui.typed.value = "";
  setBusy(true);
  try {
    const t0 = performance.now();
    const res = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: text }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const beat = await res.json();
    log(
      `director replied in ${Math.round(performance.now() - t0)}ms (${beat.type})`,
    );

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
  if (busy) return;
  touchIdle();
  addTranscript("—", `skip to ${time}`);
  setBusy(true);
  try {
    await dropSpeculative();
    const res = await fetch("/api/skip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ time }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const beat = await res.json();
    await runBeat(beat, { chain: false }); // hard cut across time
    refreshState();
  } catch (err) {
    log(`skip failed: ${err.message}`);
    note(`Could not skip ahead: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

async function startStory(character) {
  if (busy) return;
  setBusy(true);
  try {
    $("player-name").textContent =
      character === "jonathan" ? "Jonathan Harker" : "Mina Harker";
    const res = await fetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player_character: character }),
    });
    if (!res.ok)
      throw new Error("The story could not start. Please try again.");
    const { opening } = await res.json();
    ui.transcript.replaceChildren();
    ui.picker.style.display = "none";
    let connectionError = "";
    if (!reactor && !config.demoMode)
      await connect().catch((e) => {
        connectionError = e.message;
        log(`connect failed: ${e.message}`);
      });
    await runBeat({ ...opening, branches: [] }, { chain: false });
    if (connectionError) note(`Live video unavailable: ${connectionError}`);
    await refreshState();
  } catch (err) {
    note(err.message);
    log(`start failed: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

// ---------- pre-generation (Phase 5 parachute) ----------
async function pregenForks() {
  if (busy) return;
  setBusy(true);
  try {
    if (!reactor) await connect();
    const story = await (await fetch("/api/story")).json();
    const prompts = [
      { label: "opening", prompt: story.entry.opening_clip_prompt },
      ...story.forks.map((f) => ({
        label: `fork ${f.id}: ${f.title}`,
        prompt: f.dawn_clip_prompt,
      })),
    ];
    for (const { label, prompt } of prompts) {
      const hash = await sha1(prompt);
      if (await cacheHas(hash)) {
        log(`pregen: ${label} already cached`);
        continue;
      }
      note(`pre-generating ${label}…`);
      const clipId = await enqueueClip(prompt, { hash });
      if (!clipId) continue;
      try {
        await waitGenerated(clipId, 90000);
        await playClip(clipId); // it must play to be recorded
        await waitClipEnd();
      } catch (e) {
        log(`pregen ${label} failed: ${e.message}`);
      }
    }
    note("pre-generation done");
  } finally {
    setBusy(false);
  }
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
    setTimeout(() => {
      reactor?.off("message", handler);
      resolve();
    }, 30000);
  });
}

async function sha1(text) {
  const buf = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    if (e.results[e.results.length - 1].isFinal) {
      stopMic();
      takeTurn(text);
    }
  };
  recognition.onerror = (e) => {
    log(`speech error: ${e.error} — type instead`);
    note("Microphone unavailable. You can type your next line below.");
    stopMic();
  };
  recognition.onend = stopMic;
}

function startMic() {
  if (!recognition)
    return note("no speech recognition in this browser — type instead");
  ui.mic.classList.add("listening");
  ui.mic.setAttribute("aria-label", "Stop microphone");
  ui.mic.setAttribute("aria-pressed", "true");
  try {
    recognition.start();
  } catch (err) {
    stopMic();
    note(`Microphone unavailable: ${err.message}`);
  }
}
function stopMic() {
  ui.mic.classList.remove("listening");
  ui.mic.setAttribute("aria-label", "Start microphone");
  ui.mic.setAttribute("aria-pressed", "false");
  try {
    recognition?.stop();
  } catch {}
}

function speak(line) {
  try {
    const u = new SpeechSynthesisUtterance(line);
    u.rate = 0.95;
    u.pitch = 0.8;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}

// ---------- small UI ----------
function showSubtitle(speaker, line) {
  if (!line) {
    ui.subtitle.innerHTML = "";
    return;
  }
  ui.subtitle.innerHTML = `<span class="speaker">${esc(displayName(speaker))}</span>“${esc(line)}”`;
  clearTimeout(showSubtitle.t);
  showSubtitle.t = setTimeout(() => {
    ui.subtitle.innerHTML = "";
  }, 12000);
}

function addTranscript(speaker, line) {
  ui.transcript.querySelector(".transcript-empty")?.remove();
  const div = document.createElement("div");
  div.innerHTML = `<span class="who">${esc(displayName(speaker))}:</span> ${esc(line)}`;
  ui.transcript.appendChild(div);
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

function displayName(id) {
  return (
    {
      mina: "Mina",
      jonathan: "Jonathan",
      van_helsing: "Van Helsing",
      dracula: "The Count",
      lucy: "Lucy",
      seward: "Dr Seward",
      you: "You",
      narrator: "—",
      "—": "—",
    }[id] ||
    id ||
    ""
  );
}

async function refreshState() {
  try {
    const state = await (await fetch("/api/state")).json();
    const { transcript, pending_branches, characters, ...rest } = state;
    ui.stateJson.textContent = JSON.stringify({ ...rest, characters }, null, 1);
    $("scene-time").textContent =
      `${(state.location || "London").replaceAll("_", " ")} · ${state.time || "After midnight"}`;
    $("impact-summary").textContent = state.deviations?.length
      ? state.deviations.join(" · ")
      : "The original story is still intact. Your next choice can change it.";
  } catch (err) {
    log(`state refresh failed: ${err.message}`);
  }
}

function note(text) {
  if (/REACTOR_API_KEY/.test(text))
    text =
      "Live video isn’t configured yet. Ask the demo operator to enable it, then connect from Session controls.";
  else if (/ANTHROPIC_API_KEY|authentication|401/i.test(text))
    text =
      "The story service isn’t configured yet. Ask the demo operator to connect it and try again.";
  else if (
    /EPERM|ENOENT|operation not permitted|Failed to fetch|fetch failed/i.test(
      text,
    )
  )
    text =
      "The story service is unavailable. Please try again, or ask the demo operator to check the server.";
  ui.stageNote.textContent = text;
}
function setBusy(value) {
  busy = value;
  for (const button of [
    ui.send,
    ui.skip,
    ui.mic,
    ui.pregen,
    $("restart-scene"),
    ...document.querySelectorAll("[data-line]"),
  ])
    button.disabled = value;
  ui.typed.disabled = value;
  ui.send.innerHTML = value ? "One moment…" : "Say it <span>↗</span>";
  $("controls").setAttribute("aria-busy", String(value));
}
function esc(s) {
  const d = document.createElement("span");
  d.textContent = String(s);
  return d.innerHTML;
}
function briefly(o) {
  const s = JSON.stringify(o) || "";
  return s.length > 220 ? s.slice(0, 220) + "…" : s;
}

// ---------- wiring ----------
ui.connect.onclick = () =>
  connect()
    .then(() => note("Connected. Speak or type your next line."))
    .catch((e) => {
      log(`connect failed: ${e.message}`);
      note(`Live video unavailable: ${e.message}`);
      setStatus("disconnected");
    });
ui.disconnect.onclick = () =>
  disconnect().then(() => note("Session closed. Connect live to continue."));
ui.send.onclick = () => takeTurn(ui.typed.value);
ui.typed.addEventListener("keydown", (e) => {
  if (e.key === "Enter") takeTurn(ui.typed.value);
});
ui.skip.onclick = () => skipTo("dawn");
ui.mic.onclick = () =>
  ui.mic.classList.contains("listening") ? stopMic() : startMic();
ui.stateBtn.onclick = () => {
  ui.statePanel.style.display =
    ui.statePanel.style.display === "block" ? "none" : "block";
  ui.stateBtn.setAttribute(
    "aria-expanded",
    String(ui.statePanel.style.display === "block"),
  );
  refreshState();
};
ui.pregen.onclick = () =>
  pregenForks().catch((e) => {
    log(`pregen failed: ${e.message}`);
    note(`Pre-generation unavailable: ${e.message}`);
  });
ui.liveVideo.onclick = () => ui.liveVideo.play().catch(() => {});
for (const card of document.querySelectorAll("#picker .card")) {
  card.onclick = () =>
    startStory(card.dataset.character).catch((e) =>
      log(`start failed: ${e.message}`),
    );
}
for (const button of document.querySelectorAll("[data-line]")) {
  button.onclick = () => {
    ui.typed.value = button.dataset.line;
    ui.typed.focus();
  };
}
$("fullscreen").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $("stage").requestFullscreen();
  } catch {
    note("Fullscreen is unavailable in this browser.");
  }
};
$("restart-scene").onclick = async () => {
  if (busy || !selectedCharacter) return;
  await disconnect();
  hideCached();
  await startStory(selectedCharacter);
};

// ---------- boot ----------
(async () => {
  try {
    config = await (await fetch("/api/config")).json();
    ui.demoBadge.hidden = !config.demoMode;
    log(
      `config: model=${config.model} dialogue_in_clip=${config.dialogueInClip} demo=${config.demoMode}`,
    );
    if (selectedCharacter) await startStory(selectedCharacter);
    else {
      ui.picker.hidden = false;
      note("Choose a character to begin.");
      setBusy(true);
    }
  } catch (err) {
    note("The story server is unavailable. Reload the page to try again.");
    log(`boot failed: ${err.message}`);
    setBusy(true);
  }
})();
