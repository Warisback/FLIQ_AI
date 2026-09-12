# UNDERSTUDY — Claude Code build plan

> You are Claude Code, acting as the lead engineer on a hackathon team. Read this whole file before writing any code. Working beats pretty. Every phase has a time box and an acceptance test; when the box expires, ship what passes and move on.

---

## 0. Mission

**Product:** you step into a public-domain story as one of its characters. First-person, live, by voice. The world plays around you (Reactor H3 clips with synchronised audio), the other characters talk back, and you can break the plot. At any point you can say "skip to dawn" and see what your choice did.

**Hackathon:** Worlds London, today, 12 Sept 2026. Submission deadline **17:30 hard** — we submit at **17:00**. Judges demo at the table at 17:45, ~2 minutes each. Target prizes: *Real-Time Interactive* (sponsored by Reactor) and *World Models — Overall*.

**Team:** 2 ML/backend devs (Dev A, Dev B), 1 non-technical (story, pitch, demo operator). Nobody here is a frontend specialist — keep the UI to one HTML page.

**Definition of done:** a judge picks a character, speaks, a character answers in context, the judge does something the original story didn't, says "skip to dawn", and sees the consequence. Live. Twice in a row without a restart.

**Story:** *Dracula* (Bram Stoker, 1897, public domain). Do **not** use any film or any work still under copyright, even if a teammate suggests it.

---

## 1. Ground truth about Reactor — read before coding

These facts come from Reactor's own docs at `docs.reactor.inc`. Verify anything you build on against the live pages; do not code from memory.

**Start here, in this order:**
1. `https://docs.reactor.inc/llms.txt` — full index of every docs page.
2. `https://docs.reactor.inc/model-api-reference/overview` — the model catalog: every model's slug, typed SDK package, and schema link. **Take slugs only from a model's own page. Never guess a slug or a command name.**
3. The chosen model's `schema` page (complete command and event schema) and `prompt-guide` page.
4. `https://docs.reactor.inc/authentication` and `/sdk-reference/reactor-class`.
5. Append `.md` to any docs URL to get clean Markdown. There is also an MCP server at `https://docs.reactor.inc/mcp` if the environment supports it.

**Platform shape (from the docs):**
- Reactor hosts multiple models, each with its own connect slug and its own command/event schema. Wire protocol is shared: open a session with the `Reactor` class, send named commands, receive events.
- Typed TypeScript SDKs: `@reactor-models/<model>`. Base JS SDK: `@reactor-team/js-sdk`. Python: `reactor-sdk`.
- Fastest scaffold: `npx create-reactor-app my-app --model=<template-name>` — gives a working app with auth wired up.
- Auth: the **server** exchanges the API key (`rk_...`) for a JWT via `POST https://api.reactor.inc/tokens`. The API key never goes to the browser.
- **Billing is per second of open session, not per second of generated video.** Close sessions when idle. Do not leave a dev session open over lunch.

**Candidate models — pick ONE in Phase 1:**

| Model | Slug | Input | Why it fits |
|---|---|---|---|
| **H3 Reference Turbo Realtime** (primary) | `reactor/h3-reference-to-video-turbo-realtime` | 1–9 reference images + prompt → 5–15s clip with **synchronised audio** | Reference images keep **characters consistent** across beats. Prompt describes action, camera, and "what the viewer hears". Clips are queued, then played on demand; autoplay optional. |
| **FastH3** (fallback) | `reactor/fast-h3` | text, or an uploaded `starting_frame` / `ending_frame` → clip | Chain beats by passing the last frame of clip N as `starting_frame` of clip N+1. No reference images. |

The organiser's rep recommended "H3 Max" as the model to start with. Check the catalog for the exact slug he meant; if a Reactor model named H3 Max exists with clip queueing and audio, evaluate it alongside the two above and pick whichever passes the Phase 1 test fastest.

**Clip lifecycle (H3 Reference):** connect (`disconnected → connecting → waiting → ready`; first `state_update` and `queue_update` describe the session) → upload reference images with the SDK's file-upload method → enqueue a clip (prompt + refs) and get a clip ID → `clip_generated` fires when it's ready → `play` with a clip ID, or no ID to play the front of the queue → `move` to reorder, `pop` to drop, `stop` to cut the playing clip, `reset` to clear. Resolutions include 1344×768 (16:9). Reference images are numbered in the order supplied; refer to them as "Picture 1", "Picture 2" in the prompt.

**Continuous WASD-walkable streams** (the walk-around-a-photo demo shown at kickoff) are a *different* Reactor model with a different command set. We are **not** using it. Do not try to bolt it on.

---

## 2. Architecture

```
Browser (one page)                      Server (Node/TS, from create-reactor-app)
─────────────────────                   ─────────────────────────────────────────
<video> ← Reactor session tracks         POST /api/token     → Reactor JWT exchange
mic → Web Speech API → transcript        POST /api/turn      → Director LLM → { npc_line, clip_prompt, state_patch, branches[] }
"Skip ahead" button                      POST /api/skip      → Director LLM → consequence beat
Transcript + NPC lines panel             GET  /api/state     → current story state (for the judge-facing debug panel)
Story-state panel (toggle)               in-memory story state + clip cache on disk
```

**Per turn:**
1. Player speaks → browser transcribes (Web Speech API, Chrome). Fallback: record audio, POST to a Whisper-compatible endpoint.
2. `POST /api/turn` with transcript. Director returns the NPC's reply line, a Reactor clip prompt (scene + action + camera + audio/dialogue), a state patch, and optionally 2 speculative branches.
3. Browser enqueues the clip via the Reactor SDK with the story's reference images, waits for `clip_generated`, `play`s it.
4. NPC line is shown as a subtitle. If in-clip speech isn't intelligible (see 4.3), a TTS line plays over the clip.

**Speculative branching (the Real-Time trick — Phase 4):** while the player is still talking, the Director predicts the two most likely player moves and the browser enqueues *both* next clips. When the player commits, `play` the matching one and `pop` the other. Reactor's queue/play/pop commands exist for exactly this. It halves perceived latency and it's the thing to show Davide (Reactor's VP Eng) at the table.

**Reference images:** generate once at setup with Runware (credits available): one per character (Mina, Jonathan, Van Helsing, Dracula, Lucy), one per location (the Harker bedroom, the castle hall, the asylum, the graveyard). Store in `/assets/refs/`. Each clip supplies the 2–4 relevant refs.

**Clip cache:** every generated clip and its prompt is saved to `/cache/<hash>.mp4` + `.json`. Demo mode (Phase 5) replays from cache if the live call fails or is slow.

---

## 3. Repo layout

```
understudy/
  PLAN.md                 ← this file
  README.md               ← how to run + demo checklist
  server/
    index.ts              ← token exchange, /api/turn, /api/skip, /api/state
    director.ts           ← LLM prompt + state machine
    state.ts              ← StoryState type + patch/apply
    cache.ts              ← clip cache read/write
  web/
    index.html            ← the one page
    main.ts               ← Reactor session, mic, UI wiring
  story/
    dracula.json          ← canon beats, characters, refs, forks
  assets/refs/            ← reference images
  cache/                  ← generated clips (gitignored)
  scripts/
    smoke.ts              ← Phase 1 test: connect, upload, one clip, play, exit
    gen_refs.ts           ← Runware calls to make reference images
  .env.example            ← REACTOR_API_KEY, LLM_API_KEY, RUNWARE_API_KEY, TTS_API_KEY
```

Start from `npx create-reactor-app understudy --model=<chosen template>` and reshape it into this. Don't fight the scaffold's build setup.

---

## 4. Phases, time boxes, acceptance tests

All times are today. If a phase runs over, ship what passes and move on. Do not start a new phase's work early at the expense of the current one's test.

### Phase 0 — Scaffold + auth (13:30 → 13:50) — Dev A
- Scaffold with `create-reactor-app`. Put `REACTOR_API_KEY` in `.env`. Confirm the server exchanges it for a JWT and the browser connects.
- **Test:** open the page, see the session reach `ready` in the console, close the session cleanly. Commit.

### Phase 1 — One clip plays (13:50 → 14:30) — Dev A
- Write `scripts/smoke.ts`: connect → upload one placeholder reference image → enqueue one clip with a Dracula prompt including a spoken line → wait for `clip_generated` → `play` → record whether **video plays, audio plays, and the spoken line is intelligible**. Log every event received.
- Run the same smoke test against FastH3 with a `starting_frame`.
- **Decision at 14:30:** pick the model. Write the choice and the slug at the top of `README.md`. If neither produces a clip by 14:30, stop and get the Reactor rep (the person in the hat) — that's what he's there for.
- **Test:** a clip generated from our prompt plays in the browser.

### Phase 2 — Director loop, typed input (13:30 → 14:45, in parallel) — Dev B
- Implement `StoryState`, `director.ts`, `/api/turn`. Text box input for now — no voice yet.
- Director must return **strict JSON** (see §5). Strip any code fences before parsing. Retry once on parse failure with the error appended.
- Turn cadence target: **< 4s** from transcript to clip enqueued. Use the fastest capable LLM you have a key for; short outputs; no chain-of-thought in the JSON.
- **Test:** type "I won't open the door", get a Van Helsing reply that acknowledges the refusal, a clip prompt mentioning the closed door, and a state patch marking `door_opened: false`. Three turns in a row keep continuity (Van Helsing remembers he was refused).

### Phase 3 — Wire it together + voice (14:45 → 15:30) — both
- Browser: mic button → Web Speech API → `/api/turn` → enqueue clip with the beat's refs → play on `clip_generated`. Subtitle the NPC line.
- Generate the real reference images (Runware) — Dev B, 20 min, while Dev A wires playback.
- **Character speech decision (4.3):** if Phase 1 showed the model's in-clip speech is intelligible, put the NPC line in the clip prompt as dialogue. If not, prompt the clip for **ambient audio only** and play the NPC line via a TTS API over the top. Decide once; don't hedge.
- **Test:** speak a line, hear/see a character answer in context, see a new clip. End to end, no typing.

### Phase 4 — Skip-ahead + speculative branching (15:30 → 16:00) — Dev B branching, Dev A skip
- `/api/skip`: Director writes the consequence beat for "one hour later / at dawn" given the state, returns a clip prompt. Big **Skip to dawn** button.
- Speculative branching: Director returns `branches: [{trigger, npc_line, clip_prompt, state_patch}, ...]` (2 max). Browser enqueues both, then on the next transcript asks the Director which branch matched (or none) — `play` the match, `pop` the rest, fall back to a normal turn on none.
- **Test:** refuse the door → skip to dawn → a clip showing the consequence of the door having stayed shut. Branching: response feels near-instant when the player does the predicted thing.

### Phase 5 — FREEZE + demo mode (16:00 → 16:40) — everyone
**Nothing new after 16:00.** Only: bug fixes, the clip cache replay path, and README.
- Demo mode flag: pre-generate the **opening clip** and the **three scripted forks** (§6) into the cache before 16:30. Live generation stays on for anything unscripted; cache is the parachute.
- Pre-warm: open the session 60 seconds before each judge arrives; close it after.
- Non-technical records the backup video (VEED) from a full run.
- **Test:** full demo run, twice, from a cold page load. Then submit at **17:00**.

---

## 5. Director: state schema + prompt

### StoryState (server/state.ts)

```ts
type StoryState = {
  story: "dracula";
  player_character: "mina" | "jonathan";
  time: string;                      // "night, 3am" | "dawn" ...
  location: string;                  // must match a key in story/dracula.json locations
  beat_index: number;                // position in canon beats
  deviations: string[];              // what the player did that the book didn't
  characters: Record<string, {
    alive: boolean;
    location: string;
    knows: string[];                 // facts this character knows
    disposition_to_player: number;   // -2 .. +2
  }>;
  flags: Record<string, boolean>;    // door_opened, invited_dracula_in, told_van_helsing, ...
  transcript: { speaker: string; line: string }[];  // last 12 lines only
};
```

### Director system prompt (server/director.ts) — use as written, tune only if tests fail

```
You are the Director of an interactive, first-person retelling of Bram Stoker's Dracula (1897).
The player IS one character and speaks as them. You control every other character and the world.

Rules:
1. Stay in the 1897 setting and the book's cast. Never break character or mention AI.
2. Characters remember. Use `state.deviations`, `flags`, and each character's `knows`. If the
   player refused something earlier, characters react to that later.
3. Honour the player's agency. If they break the plot, the plot breaks. Follow consequences
   plausibly; never quietly steer back to the book.
4. One NPC line per turn, under 25 words, in that character's voice.
5. Write `clip_prompt` for a video model: first-person POV of the player, the scene, one clear
   action, camera movement, and what is heard. 40–80 words. Refer to reference images as
   "Picture 1", "Picture 2"... using the mapping given. If `dialogue_in_clip` is true, include
   the NPC line as spoken dialogue in the prompt; otherwise describe ambient sound only.
6. `state_patch` contains only the fields that changed.
7. Optionally predict the two most likely next player moves as `branches`.

Respond with ONLY this JSON, no preamble, no code fences:
{
  "npc_line": string,
  "npc_speaker": string,
  "clip_prompt": string,
  "refs": string[],                  // ref image ids, ordered, 1-4
  "state_patch": object,
  "branches": [ { "trigger": string, "npc_line": string, "npc_speaker": string,
                  "clip_prompt": string, "refs": string[], "state_patch": object } ]  // 0-2
}
```

Send with each turn: current `StoryState`, the canon beats for context, the `dialogue_in_clip` flag, the ref-id → "Picture N" mapping, and the player's transcript.

### Skip prompt
Same system prompt, user message: `The player says: "skip to <time>". Write the consequence beat: what the world looks like at <time> given `state.deviations` and `flags`. No new player action. Return the same JSON.`

---

## 6. Story pack — `story/dracula.json`

Non-technical owns this file. Dev B gives them the schema; they fill it. Summarised canon, in our own words:

**Player character options (offer two):** Mina Harker; Jonathan Harker.

**Canon beats (6):**
1. Jonathan arrives at Castle Dracula and is received by the Count.
2. Jonathan realises he is a prisoner; escapes.
3. Lucy sickens in Whitby; Van Helsing is called in.
4. Lucy dies and returns; the men destroy the vampire she has become.
5. Dracula turns his attention to Mina; she is bitten and bound to him.
6. The hunters pursue Dracula back to Transylvania and destroy him at sunset.

**Entry point for the demo:** night, the Harkers' room. Van Helsing knocks and asks Mina to let him in to place garlic and a crucifix. Player is Mina.

**The three scripted forks (pre-generate these clips in Phase 5):**
- **Fork A — refuse the door.** Mina tells Van Helsing no. Skip to dawn → she is pale, the window open, two marks on her neck; Van Helsing outside, grim.
- **Fork B — invite him in.** Mina invites the *Count*, not Van Helsing. Skip to dawn → the room is empty, the bed unslept in, a bat's shadow on the wall; Jonathan waking alone.
- **Fork C — tell the truth early.** Mina tells Van Helsing about the dreams before he asks. Skip to dawn → she wakes safe, the room fortified, Van Helsing asleep in a chair.

Characters: mina, jonathan, van_helsing, dracula, lucy, seward. Locations: harker_room, castle_hall, whitby_cliff, asylum, graveyard.

---

## 7. Demo — 2 minutes, run by the non-technical operator

1. Page already open, session pre-warmed. "Pick who you want to be." Judge picks Mina.
2. Opening clip plays (from cache — instant). Van Helsing knocks and asks to come in.
3. Judge speaks. Character answers in context. New clip.
4. Operator nudges: "You don't have to let him in." Judge refuses (Fork A), or does something unscripted (live generation).
5. **"Skip to dawn."** Consequence clip. This is the money shot.
6. Toggle the state panel for 5 seconds: show `deviations` and `flags` — "the story remembers".
7. Closing line: *"Every video generator can show you a different ending. This is the only place you can be there when it changes."*

Judge questions to have answers for:
- *"How is this different from prompting a video model?"* → You don't write the ending; you're inside the scene when it changes, characters remember what you did, and consequences compound.
- *"Latency?"* → Speculative branching: we generate the two likeliest futures while you're still talking, then play the one you chose.
- *"Why Dracula?"* → Public domain, and everyone knows the canon — so deviation is felt.

---

## 8. Fallbacks (decide fast, don't debate)

| If… | Then… |
|---|---|
| H3 Reference clips fail by 14:30 | FastH3 with `starting_frame` chaining; drop reference images |
| In-clip speech unintelligible | Ambient-only clip audio + TTS for NPC lines |
| Web Speech API flaky on the demo machine | Typed input box stays visible; operator types the judge's words |
| Clip generation > 30s | Show the NPC line + a still of the last frame immediately; clip plays when ready |
| Live generation fails during demo | Cache replay for the scripted forks; say "live regen is queued" and move on |
| Branching not working by 16:00 | Cut it. Single-path turns. Mention it as roadmap |

---

## 9. Ownership

**Dev A (world):** Phase 0, Phase 1, playback wiring in Phase 3, skip-ahead in Phase 4, cache + demo mode in Phase 5.
**Dev B (director):** Phase 2, ref-image generation, TTS decision in Phase 3, branching in Phase 4.
**Non-technical:** `story/dracula.json`; ref-image art direction (one line per character/location for Runware); pitch script; three forks rehearsed; backup video at 16:30; runs the demo.

---

## 10. Rules for Claude Code on this repo

- `REACTOR_API_KEY` lives in `.env` on the server only. Never in `web/`. Never committed.
- Read the model's schema page before writing any command. Log every Reactor event to the console with a timestamp during dev.
- Close the Reactor session on page unload and on server shutdown. Session time is billed.
- No refactors after 15:30. No new dependencies after 16:00. No new features after 16:00.
- Commit at the end of every phase with the phase name. Push to the shared remote.
- When a test fails, report the exact event/error text, not a paraphrase.
- If two approaches are both plausible and the docs don't settle it, build the simpler one and note the alternative in README — don't ask, there isn't time.
- Ask a human only for: API keys, model choice at 14:30 if the smoke tests are ambiguous, and the go/no-go on branching at 16:00.
