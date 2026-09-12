// StoryState + patch/apply. One in-memory state per server process (hackathon scope).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STORY_PATH = path.join(here, "..", "story", "dracula.json");

export function loadStoryPack() {
  return JSON.parse(fs.readFileSync(STORY_PATH, "utf8"));
}

// Per-character entry points (GPT frontend handoff: Jonathan needs his own
// opening); falls back to the shared entry for unknown characters.
export function entryFor(storyPack, playerCharacter) {
  return storyPack.entries?.[playerCharacter] || storyPack.entry;
}

export function initialState(storyPack, playerCharacter) {
  const entry = entryFor(storyPack, playerCharacter);
  const characters = {};
  for (const [id, c] of Object.entries(storyPack.characters)) {
    characters[id] = {
      alive: c.alive,
      location: c.location,
      knows: [...c.knows],
      disposition_to_player: c.disposition_to_player,
    };
  }
  for (const [id, override] of Object.entries(entry.character_overrides || {})) {
    if (characters[id]) Object.assign(characters[id], override);
  }
  return {
    story: "dracula",
    player_character: entry.player_character,
    time: entry.time,
    location: entry.location,
    beat_index: entry.beat_index,
    deviations: [],
    characters,
    flags: {},
    transcript: [],
    // not part of the plan's schema, but the server needs it for branching:
    pending_branches: [],
  };
}

// Deep-merge patch into state. Objects merge recursively; scalars replace.
// `deviations` is append-unique (the Director sends only NEW deviations).
// Arrays elsewhere replace wholesale.
export function applyPatch(state, patch) {
  if (!patch || typeof patch !== "object") return state;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "deviations" && Array.isArray(value)) {
      for (const d of value) {
        if (typeof d === "string" && !state.deviations.includes(d)) {
          state.deviations.push(d);
        }
      }
    } else if (key === "transcript" || key === "pending_branches") {
      // server-owned fields; the Director may not overwrite them
    } else if (
      value && typeof value === "object" && !Array.isArray(value) &&
      state[key] && typeof state[key] === "object" && !Array.isArray(state[key])
    ) {
      deepMerge(state[key], value);
    } else {
      state[key] = value;
    }
  }
  return state;
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
    ) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

export function pushTranscript(state, speaker, line) {
  state.transcript.push({ speaker, line });
  if (state.transcript.length > 12) {
    state.transcript = state.transcript.slice(-12);
  }
}
