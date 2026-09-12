// The Director: one LLM call per player turn. Returns the NPC line, a FastH3
// clip prompt, a state patch, and up to 2 speculative branches.
//
// Structured outputs (client.messages.parse + zodOutputFormat) guarantee valid
// JSON — no fence-stripping needed. state_patch travels as a JSON *string*
// because structured-output schemas can't express open-ended objects.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const client = new Anthropic();
const MODEL = process.env.DIRECTOR_MODEL || "claude-haiku-4-5";

const BranchSchema = z.object({
  trigger: z.string(),
  npc_line: z.string(),
  npc_speaker: z.string(),
  clip_prompt: z.string(),
  state_patch_json: z.string(),
});

const TurnSchema = z.object({
  npc_line: z.string(),
  npc_speaker: z.string(),
  clip_prompt: z.string(),
  state_patch_json: z.string(),
  branches: z.array(BranchSchema),
});

const MatchSchema = z.object({
  match_index: z.number(),
});

// Plan §5, adapted for FastH3 (verified against docs.reactor.inc):
// - FastH3 takes no reference images, so the "Picture N" rule is replaced by
//   FastH3's own prompt contract: every prompt re-establishes the full scene.
// - state_patch is returned as a JSON string (structured-output constraint).
// - `deviations` in a patch means NEW deviations to append, not the full list.
const SYSTEM_PROMPT = `You are the Director of an interactive, first-person retelling of Bram Stoker's Dracula (1897).
The player IS one character and speaks as them. You control every other character and the world.

Rules:
1. Stay in the 1897 setting and the book's cast. Never break character or mention AI.
2. Characters remember. Use \`state.deviations\`, \`flags\`, and each character's \`knows\`. If the
   player refused something earlier, characters react to that later.
3. Honour the player's agency. If they break the plot, the plot breaks. Follow consequences
   plausibly; never quietly steer back to the book.
4. One NPC line per turn, under 25 words, in that character's voice.
5. Write \`clip_prompt\` for the FastH3 video model. The model has NO memory between clips, so
   every prompt must re-establish the complete scene from scratch: first-person POV of the
   player, the setting and lighting, one clear action, one camera direction, and end with what
   is heard (concrete sounds, not moods). 40-80 words, hard cap 700 characters. If
   dialogue_in_clip is true, include the NPC line as spoken dialogue in double quotes with a
   speaker tag (e.g. S1); otherwise describe ambient sound only and NO speech.
6. \`state_patch_json\` is a JSON object as a string, containing only the fields that changed.
   Any \`deviations\` array in it lists only NEW deviations to append. Update \`flags\` (e.g.
   door_opened, invited_dracula_in, told_van_helsing), \`time\`, \`location\`, and character
   fields (\`knows\`, \`disposition_to_player\`) as consequences demand.
7. Optionally predict the two most likely next player moves as \`branches\` (0-2). Each trigger
   is a short description of what the player would say or do.`;

function buildContext(state, storyPack, dialogueInClip) {
  const { pending_branches, ...visibleState } = state;
  return [
    `CANON BEATS (for context; the player may deviate):`,
    storyPack.canon_beats.map((b, i) => `${i + 1}. ${b}`).join("\n"),
    ``,
    `LOCATIONS: ${Object.keys(storyPack.locations).join(", ")}`,
    `LOCATION DESCRIPTIONS: ${JSON.stringify(storyPack.locations)}`,
    ``,
    `dialogue_in_clip: ${dialogueInClip}`,
    ``,
    `CURRENT STORY STATE:`,
    JSON.stringify(visibleState, null, 1),
  ].join("\n");
}

async function callDirector(userMessage) {
  const request = (extra) => client.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: extra ? `${userMessage}\n\n${extra}` : userMessage }],
    output_config: { format: zodOutputFormat(TurnSchema) },
  });

  let response;
  try {
    response = await request();
    if (!response.parsed_output) throw new Error("Director returned unparseable output");
  } catch (err) {
    // Plan §2: retry once on parse failure with the error appended.
    console.error(`[director] first attempt failed: ${err.message} — retrying once`);
    response = await request(`Your previous response failed with: ${err.message}. Respond again, valid JSON only.`);
    if (!response.parsed_output) throw new Error(`Director failed twice: ${err.message}`);
  }

  const out = response.parsed_output;
  return {
    npc_line: out.npc_line,
    npc_speaker: out.npc_speaker,
    clip_prompt: out.clip_prompt.slice(0, 790), // FastH3 rejects >800 chars outright
    state_patch: safeParse(out.state_patch_json),
    branches: (out.branches || []).slice(0, 2).map((b) => ({
      trigger: b.trigger,
      npc_line: b.npc_line,
      npc_speaker: b.npc_speaker,
      clip_prompt: b.clip_prompt.slice(0, 790),
      state_patch: safeParse(b.state_patch_json),
    })),
  };
}

function safeParse(json) {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? v : {};
  } catch {
    console.error(`[director] bad state_patch_json ignored: ${json?.slice(0, 120)}`);
    return {};
  }
}

export async function directorTurn(state, storyPack, playerLine, dialogueInClip) {
  const user = [
    buildContext(state, storyPack, dialogueInClip),
    ``,
    `The player (${state.player_character}) says: "${playerLine}"`,
    `Direct the next beat. Respond with the JSON.`,
  ].join("\n");
  return callDirector(user);
}

export async function directorSkip(state, storyPack, timeTarget, dialogueInClip) {
  const user = [
    buildContext(state, storyPack, dialogueInClip),
    ``,
    `The player says: "skip to ${timeTarget}". Write the consequence beat: what the world looks`,
    `like at ${timeTarget} given state.deviations and flags. No new player action. The clip shows`,
    `the consequence scene. Update \`time\` in the state patch. Return the same JSON (branches may be empty).`,
  ].join("\n");
  return callDirector(user);
}

// Fast, tiny call: does the player's line match one of the speculative branches?
export async function matchBranch(playerLine, branches) {
  const list = branches.map((b, i) => `${i}: ${b.trigger}`).join("\n");
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 100,
    messages: [{
      role: "user",
      content: `A player in an interactive Dracula story just said: "${playerLine}"\n\nPredicted moves:\n${list}\n\nReturn match_index: the index whose trigger this line clearly matches, or -1 if none match. Be strict: partial or ambiguous matches are -1.`,
    }],
    output_config: { format: zodOutputFormat(MatchSchema) },
  });
  const idx = response.parsed_output?.match_index;
  return Number.isInteger(idx) && idx >= 0 && idx < branches.length ? idx : -1;
}
