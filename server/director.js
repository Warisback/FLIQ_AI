// The Director: one LLM call per player turn. Returns the NPC line, a FastH3
// clip prompt, a state patch, and up to 2 speculative branches.
//
// Two providers, first key found wins:
// - Anthropic: structured outputs (client.messages.parse + zodOutputFormat) —
//   valid JSON guaranteed. state_patch travels as a JSON string because
//   structured-output schemas can't express open-ended objects.
// - DeepSeek: OpenAI-compatible REST, JSON mode (response_format json_object),
//   fence-strip + zod validation + retry once (plan §2 as written).

import { z } from "zod";

// DIRECTOR_PROVIDER=mock gives canned beats — tests the clip pipeline with zero
// LLM credit. Never use it in front of a judge.
const PROVIDER = process.env.DIRECTOR_PROVIDER
  || (process.env.ANTHROPIC_API_KEY ? "anthropic"
    : process.env.DEEPSEEK_API_KEY ? "deepseek"
    : process.env.GEMINI_API_KEY ? "gemini"
    : "anthropic"); // last resort: the Anthropic SDK can still find an `ant auth` profile
const DEFAULT_MODELS = {
  anthropic: "claude-haiku-4-5",
  deepseek: "deepseek-chat",
  gemini: "gemini-3.5-flash", // pinned from the key's live ListModels, 12 Sept 2026
  mock: "mock",
};
const MODEL = process.env.DIRECTOR_MODEL || DEFAULT_MODELS[PROVIDER];
console.log(`[director] provider=${PROVIDER} model=${MODEL}`);

// ---------- shared schemas ----------
// DeepSeek returns state_patch as a plain object; Anthropic as a JSON string.
const patchField = z.union([z.string(), z.record(z.string(), z.any())]);
const BranchSchema = z.object({
  trigger: z.string(),
  npc_line: z.string(),
  npc_speaker: z.string(),
  clip_prompt: z.string(),
  state_patch: patchField.optional(),
  state_patch_json: z.string().optional(),
});
const TurnSchema = z.object({
  npc_line: z.string(),
  npc_speaker: z.string(),
  clip_prompt: z.string(),
  state_patch: patchField.optional(),
  state_patch_json: z.string().optional(),
  branches: z.array(BranchSchema).nullish(),
});

// Plan §5, adapted for FastH3 (verified against docs.reactor.inc):
// - FastH3 takes no reference images, so the "Picture N" rule is replaced by
//   FastH3's own prompt contract: every prompt re-establishes the full scene.
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
6. The state patch contains only the fields that changed. Any \`deviations\` array in it lists
   only NEW deviations to append. Update \`flags\` (e.g. door_opened, invited_dracula_in,
   told_van_helsing), \`time\`, \`location\`, and character fields (\`knows\`,
   \`disposition_to_player\`) as consequences demand.
7. Optionally predict the two most likely next player moves as \`branches\` (0-2). Each trigger
   is a short description of what the player would say or do.`;

// DeepSeek has no schema enforcement — the shape rides in the system prompt.
const DEEPSEEK_FORMAT = `

Respond with ONLY this JSON, no preamble, no code fences:
{
  "npc_line": string,
  "npc_speaker": string,
  "clip_prompt": string,
  "state_patch": object,
  "branches": [ { "trigger": string, "npc_line": string, "npc_speaker": string,
                  "clip_prompt": string, "state_patch": object } ]  // 0-2, may be []
}`;

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

// ---------- Anthropic path ----------
let anthropicClient = null;
async function anthropicParse(schemaShape, userMessage, maxTokens) {
  if (!anthropicClient) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropicClient = new Anthropic();
  }
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const response = await anthropicClient.messages.parse({
    model: MODEL,
    max_tokens: maxTokens,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userMessage }],
    output_config: { format: zodOutputFormat(schemaShape) },
  });
  if (!response.parsed_output) throw new Error("unparseable structured output");
  return response.parsed_output;
}

// Anthropic structured outputs can't do open objects → JSON-string patch fields.
const AnthropicBranchSchema = z.object({
  trigger: z.string(), npc_line: z.string(), npc_speaker: z.string(),
  clip_prompt: z.string(), state_patch_json: z.string(),
});
const AnthropicTurnSchema = z.object({
  npc_line: z.string(), npc_speaker: z.string(), clip_prompt: z.string(),
  state_patch_json: z.string(), branches: z.array(AnthropicBranchSchema),
});

// ---------- DeepSeek path ----------
async function deepseekJson(userMessage, maxTokens, extraSystem = "") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        temperature: 1.0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT + DEEPSEEK_FORMAT + extraSystem },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    let text = body.choices?.[0]?.message?.content ?? "";
    text = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""); // plan §2: strip fences
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- normalization ----------
function normalizePatch(obj) {
  const raw = obj?.state_patch_json ?? obj?.state_patch;
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    console.error(`[director] bad state patch ignored: ${String(raw).slice(0, 120)}`);
    return {};
  }
}

function normalizeTurn(out) {
  return {
    npc_line: out.npc_line ?? "",
    npc_speaker: out.npc_speaker ?? "",
    clip_prompt: (out.clip_prompt ?? "").slice(0, 790), // FastH3 rejects >800 chars outright
    state_patch: normalizePatch(out),
    branches: (out.branches ?? []).slice(0, 2).map((b) => ({
      trigger: b.trigger,
      npc_line: b.npc_line,
      npc_speaker: b.npc_speaker,
      clip_prompt: (b.clip_prompt ?? "").slice(0, 790),
      state_patch: normalizePatch(b),
    })),
  };
}

// ---------- Gemini path ----------
// generateContent with responseMimeType json; shape enforced via the same
// prompt block as DeepSeek, validated with zod, retried once by callDirector.
// Gemini flash models think by default (~10s/turn measured) — a zero thinking
// budget brings turns under the plan's 4s target. If the model rejects the
// field, we drop it for the rest of the process and eat the latency.
let geminiThinkingOff = true;
async function geminiJson(userMessage, maxTokens, systemText, model = MODEL) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const request = () => fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": process.env.GEMINI_API_KEY,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemText }] },
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          generationConfig: {
            responseMimeType: "application/json",
            // On thinking models this cap includes thinking tokens — keep it roomy
            // or the visible JSON gets starved.
            maxOutputTokens: maxTokens,
            temperature: 1.0,
            ...(geminiThinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        }),
      },
    );
    let res = await request();
    if (res.status === 400 && geminiThinkingOff) {
      const text = await res.text();
      if (/thinking/i.test(text)) {
        console.error("[director] gemini rejected thinkingBudget:0 — retrying with thinking on");
        geminiThinkingOff = false;
        res = await request();
      } else {
        throw new Error(`Gemini 400: ${text.slice(0, 300)}`);
      }
    }
    if (res.status === 429) {
      // Free tier is per-minute limited. If Google says the window clears
      // soon, wait it out once instead of surfacing an error mid-demo.
      const text = await res.text();
      const delay = Number(text.match(/retryDelay[^\d]*(\d+)/)?.[1] ?? NaN);
      if (delay > 0 && delay <= 15) {
        console.error(`[director] gemini 429 — retrying in ${delay + 1}s`);
        await new Promise((r) => setTimeout(r, (delay + 1) * 1000));
        res = await request();
      }
      if (!res.ok) {
        throw new Error("The Director is rate-limited — give it a minute, then try again. (Gemini free-tier per-minute quota)");
      }
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    const cand = body.candidates?.[0];
    if (!cand?.content?.parts?.length) {
      throw new Error(`Gemini returned no content (finishReason: ${cand?.finishReason ?? body.promptFeedback?.blockReason ?? "?"})`);
    }
    let text = cand.content.parts.map((p) => p.text ?? "").join("");
    text = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- mock path (pipeline testing only) ----------
let mockTurn = 0;
const MOCK_BEATS = [
  {
    npc_line: "Then I shall wait, Madam Mina. But the night is not your friend.",
    npc_speaker: "van_helsing",
    clip_prompt: "First-person POV of a young woman standing before a heavy closed oak door in a candlelit Victorian bedroom, 1897: dark panelling, moonlight through lace curtains, her hand resting against the bolt, refusing to draw it. Slow push-in on the door. A muffled older man's voice through the wood, S1: \"Then I shall wait, Madam Mina. But the night is not your friend.\" Retreating footsteps on floorboards, wind rattling the casement, the candle flame sputtering.",
    state_patch: { flags: { door_opened: false }, deviations: ["Mina refused to let Van Helsing in"] },
    branches: [],
  },
  {
    npc_line: "You heard something at the window? Bolt it. Do not look at what looks back.",
    npc_speaker: "van_helsing",
    clip_prompt: "First-person POV of a young woman in a candlelit Victorian bedroom at night, 1897, turning from a heavy closed door toward a casement window where lace curtains stir though the window seems shut. Handheld slow turn. A muffled older man's voice through the door, S1: \"You heard something at the window? Bolt it. Do not look at what looks back.\" A soft scratching on glass, wind, a floorboard creak.",
    state_patch: { flags: { noise_at_window: true } },
    branches: [],
  },
];
function mockDirector() {
  const beat = MOCK_BEATS[Math.min(mockTurn++, MOCK_BEATS.length - 1)];
  return structuredClone(beat);
}

async function callDirector(userMessage) {
  if (PROVIDER === "mock") return mockDirector();
  const attempt = async (extra) => {
    const msg = extra ? `${userMessage}\n\n${extra}` : userMessage;
    const raw = PROVIDER === "deepseek"
      ? await deepseekJson(msg, 1400)
      : PROVIDER === "gemini"
        ? await geminiJson(msg, 4000, SYSTEM_PROMPT + DEEPSEEK_FORMAT)
        : await anthropicParse(AnthropicTurnSchema, msg, 2000);
    const checked = TurnSchema.safeParse(raw);
    if (!checked.success) throw new Error(`bad shape: ${checked.error.issues[0]?.message} at ${checked.error.issues[0]?.path?.join(".")}`);
    return normalizeTurn(checked.data);
  };
  try {
    return await attempt();
  } catch (err) {
    // Quota/billing errors won't fix themselves on retry — fail fast so the
    // client can fall back to cache instead of doubling the burn.
    if (/\b(402|429)\b|Insufficient Balance|quota/i.test(err.message)) throw err;
    // Plan §2: retry once on parse failure with the error appended.
    console.error(`[director] first attempt failed: ${err.message} — retrying once`);
    return attempt(`Your previous response failed with: ${err.message}. Respond again, valid JSON only, exactly the specified shape.`);
  }
}

// ---------- public API ----------
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
const MatchSchema = z.object({ match_index: z.number() });

export async function matchBranch(playerLine, branches) {
  if (PROVIDER === "mock") return -1;
  const list = branches.map((b, i) => `${i}: ${b.trigger}`).join("\n");
  const prompt = `A player in an interactive Dracula story just said: "${playerLine}"\n\nPredicted moves:\n${list}\n\nReturn JSON {"match_index": n} — the index whose trigger this line clearly matches, or -1 if none match. Be strict: partial or ambiguous matches are -1.`;

  let idx;
  if (PROVIDER === "gemini") {
    try {
      // flash-lite: faster than the main model and bills a separate per-minute
      // quota bucket, so branch matching never starves story turns.
      const out = await geminiJson(prompt, 1500, "You match player lines to predicted moves. Answer with JSON only.", "gemini-3.5-flash-lite");
      idx = out.match_index;
    } catch (err) {
      console.error(`[branch-match] gemini failed: ${err.message}`);
      idx = -1;
    }
  } else if (PROVIDER === "deepseek") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: MODEL, max_tokens: 50, temperature: 0,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
      const body = await res.json();
      idx = JSON.parse(body.choices?.[0]?.message?.content ?? "{}").match_index;
    } finally { clearTimeout(timer); }
  } else {
    if (!anthropicClient) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      anthropicClient = new Anthropic();
    }
    const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
    const response = await anthropicClient.messages.parse({
      model: MODEL, max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: zodOutputFormat(MatchSchema) },
    });
    idx = response.parsed_output?.match_index;
  }
  return Number.isInteger(idx) && idx >= 0 && idx < branches.length ? idx : -1;
}
