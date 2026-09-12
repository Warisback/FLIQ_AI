# UNDERSTUDY

> **Model decision (Phase 1): `reactor/fast-h3` (FastH3).**
> The plan's primary model, "H3 Reference Turbo Realtime", does not exist in Reactor's live
> catalog (checked `docs.reactor.inc/model-api-reference/overview` on 12 Sept 2026 — no model
> named H3, H3 Max, or H3 Reference either). FastH3 is the only hosted model with all three
> things we need: **synchronized audio incl. spoken dialogue**, **queue/play/pop clip
> scheduling** (→ speculative branching), and **`continue_from_clip_id` / `starting_frame`
> chaining** for continuity. Helios and LongLive-2.0 have no audio; the streaming models have
> no clip queue. Slug taken from FastH3's own overview page, per the plan.

Step into *Dracula* (1897, public domain) as Mina or Jonathan. Speak; the cast answers in
context; the world plays around you as FastH3 clips with synchronized audio. Break the plot,
then say **"skip to dawn"** and see what your choice did.

## Run it

```bash
npm install
cp .env.example .env    # fill in REACTOR_API_KEY and ANTHROPIC_API_KEY
npm run dev             # bundles the web client, then serves http://localhost:3000
```

Use Chrome (Web Speech API for the mic; typed input always works as fallback).

- **`/`** — cinematic landing page with the parallax movie wall and hackathon partners.
- **`/casting.html`** — choose Mina or Jonathan.
- **`/play.html?character=mina`** — the live demo. The opening beat plays; talk with the mic
  or the box. Operator tools are under **Session controls**. See [FRONTEND.md](FRONTEND.md)
  for integration details and the current Jonathan-opening limitation.
- **`/smoke.html`** — Phase 1 smoke test: connect → enqueue one Dracula clip with a spoken
  line → play. Logs every Reactor event with timestamps. Human verdict checkboxes on the page
  decide `DIALOGUE_IN_CLIP` (if the spoken line is unintelligible, set it to `false` in `.env`
  → clips go ambient-only and the browser speaks NPC lines via speechSynthesis. Decided once.)
- **`node scripts/gen_refs.js`** — Runware → `assets/refs/<location>.jpg` starting frames.

## Architecture (what differs from PLAN.md and why)

Everything in `PLAN.md` §2 stands, with these forced adaptations — all from the live Reactor
docs, per §1 "verify against the live pages":

| Plan said | Built | Why |
|---|---|---|
| H3 Reference + reference images ("Picture 1…") | FastH3; per-location `starting_frame` images; Director re-establishes the full scene in every prompt | H3 Reference doesn't exist; FastH3 takes no reference images and has **no memory between clips** (its prompt guide) |
| `scripts/smoke.ts` run from Node | `/smoke.html` in the browser (source `scripts/smoke.js`) | Reactor sessions are WebRTC — Node would need native deps |
| Strip code fences, retry JSON parse | Anthropic **structured outputs** (`messages.parse` + zod) — parse failure is near-impossible; retry-once kept as belt-and-braces | Strictly better than fence-stripping; `state_patch` travels as a JSON string because structured-output schemas can't express open objects |
| TS + create-reactor-app scaffold | Plain JS, zero-framework Node server | No build step to fight; scaffold template names aren't in the docs index. Alternative noted: `@reactor-models/fast-h3` typed SDK |
| TTS API | Browser `speechSynthesis` | Zero keys, zero latency budget; only used if `DIALOGUE_IN_CLIP=false` |
| Cache `<hash>.mp4` from generation | Browser records each played clip (MediaRecorder on the WebRTC stream) → `cache/<sha1(prompt)>.webm` | Clips arrive as live tracks, not files; recording playback is the simplest capture point. Alternative if MediaRecorder disappoints: the SDK's `requestRecording()` + `downloadClipAsFile()` (server-side HLS recorder → MP4 blob), which needs the model's recorder enabled |

Director LLM: **`claude-haiku-4-5`** (plan §4 Phase 2: "fastest capable LLM"; turn target <4s).
Override with `DIRECTOR_MODEL=claude-sonnet-5` in `.env` if turns need more brain and latency allows.
System prompt is cached (`cache_control`) so repeat turns are fast and cheap.

**Speculative branching** (Phase 4): every Director turn returns ≤2 predicted branches; the
browser enqueues their clips behind the main clip (`continue_from_clip_id`). The next player
line goes through a tiny branch-match LLM call; on match the pre-generated clip plays
immediately and the others are `pop`ped — on miss, all are popped and a normal turn runs.

**Sessions are billed per second open**: the client disconnects on page unload and after
3 idle minutes. Close the session between judges (Close session button).

## Demo checklist (operator)

1. Before the judge: `DEMO_MODE=false` in `.env`, server running, **Pre-generate forks**
   clicked at least once that hour (caches opening + 3 fork-dawn clips). Click **Connect**
   ~60s before the judge sits down.
2. Judge picks **Mina** → opening knock plays (cached = instant).
3. Judge speaks (or you type their words). Nudge: *"You don't have to let him in."*
4. **Skip to dawn** → consequence clip. The money shot.
5. **Story state** toggle for 5 seconds: deviations + flags — "the story remembers".
6. Close: *"Every video generator can show you a different ending. This is the only place
   you can be there when it changes."*
7. **Close session** after each judge.
8. If live generation dies mid-demo: the client auto-falls back to the cached clip for that
   prompt when one exists; say "live regen is queued" and keep moving. Full parachute:
   set `DEMO_MODE=true` and restart the server — cached clips then play with no session at all.

## Judge Q&A

- **"How is this different from prompting a video model?"** You don't write the ending;
  you're inside the scene when it changes, characters remember what you did, and consequences
  compound (state panel proves it).
- **"Latency?"** Speculative branching — we generate the two likeliest futures while you're
  still talking, then play the one you chose and drop the other.
- **"Why Dracula?"** Public domain, and everyone knows the canon — so deviation is *felt*.

## Fallback status (§8)

| Risk | Status |
|---|---|
| H3 Reference fails | Moot — it doesn't exist; FastH3 **is** the build |
| In-clip speech unintelligible | `DIALOGUE_IN_CLIP=false` → ambient clips + speechSynthesis (wired) |
| Web Speech flaky | Typed input is always visible; Enter sends |
| Clip generation > 30s | NPC subtitle shows instantly; clip plays when ready; cache fallback at 45s |
| Live generation fails in demo | Auto cache replay per prompt; `DEMO_MODE=true` for full offline |
| Branching broken by 16:00 | Kill switch: it degrades to single-path automatically when the match call fails |
