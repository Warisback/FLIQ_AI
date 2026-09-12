# UNDERSTUDY — story & demo operator guide

One page: how the story goes, what to say, and how to change it. The app is at
**http://localhost:3001** (NOT 3000 — that's an old copy).

## The story you're inside

Bram Stoker's *Dracula* (1897). The book, in six beats:

1. Jonathan arrives at Castle Dracula and is received by the Count.
2. Jonathan realises he is a prisoner; escapes.
3. Lucy sickens in Whitby; Van Helsing is called in.
4. Lucy dies and returns as a vampire; the men destroy her.
5. **← THE DEMO STARTS HERE.** Dracula turns his attention to Mina. In the book she is
   bitten and bound to him.
6. The hunters chase Dracula home to Transylvania and destroy him at sunset.

**Opening scene (Mina — the demo role):** night, just past midnight, your bedroom at
Dr Seward's asylum. Van Helsing knocks: *"Madam Mina, it is Van Helsing. Will you let me
in? I bring garlic and a crucifix for your protection."* In the book, she lets him in —
and Dracula gets to her anyway, later. Here, what happens next is the player's.

**Opening scene (Jonathan):** same night, the asylum study. Van Helsing asks Jonathan to
recount everything he saw in the castle. (Second-choice role; Mina is the rehearsed one.)

## The three rehearsed forks (Mina)

| Fork | What the player says | What dawn shows |
|---|---|---|
| **A — Refuse the door** | "I won't open the door." | She's pale, window open, two marks on her neck; Van Helsing grim. **The money shot.** |
| **B — Invite the Count** | "Come in… my Count." (invite Dracula, not Van Helsing) | Empty room, unslept bed, a bat's shadow; Jonathan waking alone. |
| **C — Tell the truth early** | "I need to tell you about my dreams." | She wakes safe; garlic at the window, Van Helsing asleep in the chair. |

There's no script beyond that — the player can say ANYTHING ("the plot breaks" is the
product). The Director invents in-period consequences and characters remember: refuse Van
Helsing on turn 1 and he'll still be pleading, hurt, or suspicious on turn 5.

**Skip:** the **Skip to dawn** button (or literally saying "skip to dawn") jumps time and
shows the consequence of whatever the player did. This is the climax of the demo — do it
after a fork, not before.

**The story remembers:** the sidebar toggle shows `deviations` (what the player changed)
and `flags` — open it for ~5 seconds after the dawn clip. It proves the story is stateful,
not a slideshow.

## The 2-minute demo script

1. Page already open on `/`, session pre-warmed (pick the character ~1 min before).
2. "Pick who you want to be." → judge picks **Mina**. Opening knock plays.
3. Judge speaks (mic) — or you type their words if the room is loud.
4. Nudge: *"You don't have to let him in."* → Fork A, or let them go off-script.
5. **"Skip to dawn."** Consequence clip.
6. Toggle **The story remembers** — point at `deviations`.
7. Close: *"Every video generator can show you a different ending. This is the only place
   you can be there when it changes."*

Judge answers: different from prompting a video model? → *you're inside the scene,
characters remember, consequences compound.* Latency? → *we pre-generate the two likeliest
futures while you talk (a predicted line responds in under a second).* Why Dracula? →
*public domain, and everyone knows the canon — so deviation is felt.*

## How to change the story — `story/dracula.json`

Edit the file, **restart the server** (`Ctrl+C`, `npm start`), and if you changed any
clip prompt, click **Pre-generate forks** again (the cache is keyed on the prompt text).

| To change… | Edit… |
|---|---|
| The opening scene / first line | `entries.mina` (or `.jonathan`): `opening_npc_line` is the spoken line, `opening_clip_prompt` is what the video model films, `location`, `time` |
| What dawn shows for a fork | `forks[].dawn_clip_prompt` (self-contained scene, 40–80 words, end with what is heard) + `dawn_description` |
| What characters know / feel at the start | `characters.<name>.knows` (facts), `disposition_to_player` (-2 hostile … +2 devoted) |
| The canon the Director steers by | `canon_beats` (six short sentences) |
| Places the story can visit | `locations` (id → one-line description) |

Rules of thumb for clip prompts: the video model has **no memory between clips**, so every
prompt must re-describe the whole scene (who, where, light, one action, one camera move,
then the sounds). Dialogue goes in double quotes with an S1 tag.

## When it misbehaves

| Symptom | What's happening | Do |
|---|---|---|
| "Rate-limited — give it a minute" | Gemini free tier, per-minute quota | Wait ~30–60s; pace turns conversationally. Long-term: enable billing on the Google key |
| Video never appears, page pretty but dead | You're on **:3000** (old copy) | Use **http://localhost:3001** |
| Session says disconnected | Idle close (10 min) or hotel wifi | Just speak — it reconnects on the next line. Or Session controls → Connect live |
| Clip slow / fails | Generation hiccup | The subtitle already showed; cached clip auto-plays if one exists for that prompt |
| Everything on fire mid-judging | — | Set `DEMO_MODE=true` in `.env`, restart server: cached clips play with no live calls at all |

Close the session (Session controls → Close session) between judges — Reactor bills per
second the session is open.
