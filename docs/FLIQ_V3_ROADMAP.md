# FLIQ v3 — Counterfactual Reality Engine (ROADMAP — not built at the hackathon)

> Status: team spec drafted at Worlds London, 12 Sept 2026, ~16:30 — 30 minutes before
> submission. Deliberately **not** implemented on the day (plan freeze was 16:00; the
> working Dracula build is what we submitted). This is the post-hackathon direction and
> the answer to the judge question "where does this go?".
>
> The short version: today's build makes the Director LLM decide much of the consequence
> and FastH3 renders it. v3 inverts that — **we specify causes, the world model supplies
> consequences**: interventions (not authored outcomes) → Reactor rollout → observe what
> actually happened → commit as an immutable branch → fork, revisit, and carry character
> memory across realities.
>
> What today's build already provides for v3, verified live: the FastH3 session layer,
> `continue_from_clip_id` visual continuity, the MediaRecorder clip cache, the
> multi-provider Director plumbing (Anthropic/Gemini/DeepSeek/mock with retry + quota
> handling), and generation-during-playback (Reactor's generation and playout queues are
> independent — our speculative branches already generate futures while the current clip
> plays). What v3 adds: the intervention planner, prompt compiler with the open-reaction
> rule, post-generation observer, state reconciler, project/branch store, and
> cross-reality memory.

Original spec follows, as written by the team.

---

## Comprehensive build specification for the existing `Warisback/FLIQ_AI` repository

### Worlds London — 12 September 2026

> **This document is a build-on-top specification, not a greenfield rewrite.**
>
> Preserve the current working FastH3 + browser WebRTC + cache + frontend pipeline. Add a new world-model orchestration layer around it.
>
> **Core product statement**
>
> **FLIQ turns generated video into state.**
>
> A user starts from any image or video, applies an intervention, lets the world model determine what happens, stores that result as a persistent reality, and can then fork, revisit, or move characters/memories between realities.

---

# 0. The conceptual pivot

The existing repository is already a working interactive video narrative system.

Its current core loop is approximately:

```
player line → Director LLM → NPC response + exact video prompt + state patch → FastH3 → video clip
```

That is a good interactive storytelling architecture, but it risks making FastH3 primarily a **renderer of a consequence already decided by the LLM**.

FLIQ v3 changes the loop to:

```
CURRENT REALITY → USER/AGENT INTERVENTION → INTERVENTION PLANNER
(what is being changed, NOT what happens because of it)
→ PROMPT COMPILER → REACTOR WORLD-MODEL ROLLOUT → POST-GENERATION OBSERVER
(what actually happened?) → OBSERVED NEW WORLD STATE → COMMIT AS A BRANCH → NEXT INTERVENTION
```

The principle is:

> **We specify causes. Reactor supplies consequences.**

Do not ask the Director to decide that Joker laughs. Ask it to represent: `Batman tells Joker a joke.` Then FastH3 determines the visible reaction. The resulting reaction becomes state only **after observing the rollout**.

---

# 1. What already works in the repository — preserve it

- **FastH3 session** (`reactor/fast-h3`): browser owns the WebRTC session; 16:9 canvas; 8s clips; autoplay off; enqueue → `clip_generated` → play; failure handling; `lastPlayedClipId` tracking.
- **Visual continuity**: `enqueue(prompt, { continue_from_clip_id: lastPlayedClipId })` for consecutive beats. Do not replace with independent generations.
- **Clip recording/cache**: MediaRecorder → `cache/<sha1(prompt)>.webm`. Becomes the basis of persistent branch media; extend the metadata around it.
- **Director provider stack**: Anthropic structured output, Gemini JSON, DeepSeek JSON, mock. Preserve wrappers and retry/quota handling; change the schema and role, not the plumbing.
- **Frontend**: keep `/`, `/casting.html`, `/play.html` (Dracula — DO NOT BREAK), `/smoke.html`. Add `/lab.html` (new FLIQ reality playground) + `lab.bundle.js` esbuild target. Do not convert `/play.html` in place until `/lab.html` works twice end to end.

---

# 2. Product definition

## 2.1 User promise

1. upload an image or video; 2. use it as the root reality; 3. intervene in it; 4. let Reactor generate the consequence; 5. store the result as a new reality; 6. return to any stored reality; 7. create another intervention from the same state; 8. optionally generate multiple possible futures for one intervention; 9. move a character/object identity between realities; 10. let a character retain memories from a reality they have left.

## 2.2 The product is NOT

An alternate-ending generator; choose-your-own-adventure; an AI screenplay writer; an authored node-canvas like Multic; a 3D reconstruction engine.

Frame it as: **an interactive counterfactual engine built on video world models** — a playground where every generated video becomes another state you can act on.

---

# 3. The four ideas that define FLIQ

1. **Interventions, not authored outcomes.** "Batman tells Joker a terrible joke." — not "…and Joker laughs." Preserve initial state and action; deliberately leave reactions open.
2. **Branches are persistent worlds.** A branch stores: visual media, semantic state, parent reality, the intervention that created it, observed consequences, character memory, continuity anchors, generation provenance.
3. **Generated output feeds back into state.** Do not assume the model did what the prompt asked. Observe the clip; the observed result becomes the next state.
4. **State can cross realities intentionally.** Visual identity, imported objects, and character memory can cross; physical state does not unless explicitly transferred.

---

# 4. World-model depth ladder

- **Level 1 — Renderer — avoid**: LLM writes entire scene, FastH3 illustrates.
- **Level 2 — Reactive world — minimum target**: state → intervention → rollout → observe → new state.
- **Level 3 — Counterfactual sampler — strong**: same state + same intervention → multiple rollouts → compare/choose.
- **Level 4 — Cross-reality state — signature**: character memory / visual identity carried between realities, then rolled out.

Ship Level 2 first. Level 4 is the money shot if time allows.

---

# 5. Parallel modes

Keep the existing pages as the emergency fallback; add `/lab.html` + its own esbuild target (`build:lab`) so the Dracula build never breaks.

---

# 6. New core server model

Keep the old global `state` for `/play.html`. Add a separate `projectStore` (process memory + optional disk mirror `data/projects/<id>.json`; no database).

- **Project**: `{ id, title, source_asset_id, active_branch_id, branches:{}, entities:{}, memories:[], created_at }`
- **BranchNode**: `{ id, parent_branch_id, label, source_asset_id, intervention, rollout:{model,prompt,clip_hash,reactor_clip_id,status,created_at}, media:{cached_path,first_frame_path,last_frame_path}, world_state, observation, imported_entity_ids:[], created_at }` — **immutable after commit**; any change creates a child.
- **WorldState** (semantic, compact): `scene{summary,location,time,visual_anchors,camera_summary,audio_summary}`, `characters{...present,appearance,pose,visible_emotion,location_description,goals,relationships,knowledge}`, `objects{...}`, `facts[]`, `recent_events[]`.

---

# 7. Intervention schema

`{ id, actor_id, type: say|move|interact|insert_entity|remove_object|change_environment|freeform, target_id, instruction, preserve:[], position }`

Deliberately **no** `desired_outcome`, `npc_reaction`, or `future_state` — those belong to the world-model rollout.

---

# 8. Director becomes an intervention planner (FLIQ mode)

Keep provider plumbing and the Dracula exports (`directorTurn`, `directorSkip`, `matchBranch`) untouched. Add `planIntervention({worldState, userInstruction, entityContext})` and `summariseMemory(...)`. Planner output: `{ intervention:{...}, dialogue:[{speaker_id,line}] }` — dialogue only where the user explicitly scripted it. It must not add "Joker laughs."

---

# 9. FLIQ planner system prompt

> You are the Intervention Planner for FLIQ... Your job is ONLY to identify the intervention applied to the current world. You do NOT decide the consequence, reaction, ending, or resulting world state. The Reactor world model will produce the consequence. [Rules 1–10: preserve the user's action exactly; don't invent reactions; no screenplay; no ending; identify actor/target/intervention; short continuity constraints; preserve explicit dialogue; imports = insertion + placement only; never mention implementation; strict JSON only.]

This is the most important prompt-level change.

---

# 10. Prompt Compiler (`server/promptCompiler.js`)

Translates WorldState + Intervention + relevant memory + visual anchors into a Reactor prompt. Not allowed to add a consequence. Respect FastH3 constraints (no memory between prompts; full scene re-establishment; ~800-char cap). Structure: `[scene anchor][positions][intervention][explicit dialogue][continuity constraints][camera/audio][open-ended reaction instruction]`. Key sentence: **"Let [others/the environment] react naturally without forcing a specific response."**

Compression order when over budget: old narrative history → low-salience memories → decorative adjectives → secondary objects → camera prose. Never remove: scene anchor, identities, intervention, explicit dialogue, preservation constraints.

---

# 11. Open-reaction rule

`validateOpenReaction(prompt, intervention)` — reject/flag prompts containing unintended reaction language after the intervention ("Joker bursts into laughter" bad; "Joker responds naturally" good). Simple rule initially; the purpose is architectural discipline.

---

# 12. Post-generation observer (`server/observer.js`) — second critical change

Update state from what **appeared**, not what was requested. Browser captures frames at ~25%/60%/final via `<video>` + canvas (JPEG ~0.7), POSTs to `/api/lab/observe`; a multimodal provider (Gemini path exists) returns `{scene_changes, characters{present,pose,visible_emotion,location_description,actions_observed}, objects, events_observed, continuity_notes, confidence}`. Observer prompt: describe ONLY visible evidence; no hidden motives; no invented dialogue; don't assume the intervention succeeded unless visible.

**Fallback observer**: an `ACCEPT REALITY` button — commit intervention as known event + visuals, without invented reaction semantics.

---

# 13. State Reconciler (`server/stateReconciler.js`)

previous WorldState + Intervention + Observer result → next WorldState. Known user action = attempted/performed event; visible consequences from Observer; unobserved consequences not invented; high-confidence observations override expectations; episodic memory recorded after commit. The closed loop: state → action → world model → observation → state.

---

# 14. Reality branches (`server/projectStore.js`)

Root = uploaded still/video (no generation). Child branch committed only after generation succeeds + recording/cache exists (or accepted) + observer completes (or fallback). Immutable sibling worlds: R1's physical state never leaks into R2.

---

# 15. Multiple rollouts — `EXPLORE POSSIBILITIES`

Same parent state + same intervention → 2 independent rollouts → "Possible future A / B". Do **not** invent probability percentages.

---

# 16. Continuity Packet

Per committed branch: `{semantic_state, last_frame, representative_frames, reactor_clip_id, cached_clip_hash, visual_anchors, relevant_memories, generation_prompt}`. Within a live chain: `continue_from_clip_id` (already implemented). Forking older branches: reuse session clip id if still valid, else cached last frame → `starting_frame`. Cross-session: last frame + WorldState + memory persist — Reactor session state is not long-term memory; FLIQ is.

---

# 17. Visual memory — three distinct types

1. **Visual memory**: what an entity looks like (`{frame_path, description, branch_id}`).
2. **World state**: what is physically true in this branch.
3. **Episodic memory**: what a character remembers experiencing — can survive into a reality where the event never happened.

---

# 18. Persistent cross-reality memory (`server/memory.js`)

`MemoryEvent: {id, character_id, source_branch_id, summary, type: branch|cross_reality, salience 1–3, created_at}`. Branch-local memory = normal chronology. Cross-reality memory = explicit mechanic: an imported character retains selected origin events. **Memory does not transfer physical truth** — Reality B's Batman never told the joke; imported Joker remembers it anyway.
