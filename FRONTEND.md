# Cinematic demo frontend

Built on `origin/main` at `f8c0712` on branch `codex/cinematic-demo`.

The user's attached images and parallax recording replace the build plan's visual direction and one-page constraint. The product flow and existing backend contracts remain the foundation. No server or story files were changed.

## Pages

- `/` — landing page with a scroll-driven film wall, hackathon partner wordmarks, Dracula feature, and explicitly labelled illustrative choice preview.
- `/casting.html` — Mina / Jonathan character selection.
- `/play.html?character=mina` — live scene, voice and typed input, subtitles, transcript, story-state inspector, skip to dawn, fullscreen, and collapsible operator controls.
- `/smoke.html` — existing Reactor smoke test remains available.

Use `npm install` and `npm run dev` as before. A pnpm lockfile is also included for reproducible installs with `pnpm install` and `pnpm dev`. No new application dependencies were added.

The browser does not open a Reactor session from the landing or casting page. Choosing a role starts the existing reset/connect flow. Closing, restarting, and leaving the scene clean up the browser session; the existing idle timeout remains.

## Integration notes for the backend owner

The frontend uses the existing `/api/config`, `/api/reset`, `/api/token`, `/api/turn`, `/api/skip`, `/api/state`, `/api/story`, and cache endpoints. It consumes the existing beat shape unchanged. Keep the element IDs in `web/play.html` aligned with `web/main.js`; the old app has moved from `/` to `/play.html`.

Mina is the recommended demo role. At the checked-out backend revision, `/api/reset` always returns Mina's opening beat even when `player_character` is Jonathan. Jonathan needs a character-specific opening and initial location from the backend before presenting that role as a complete demo.

Live generation cannot be verified without local `REACTOR_API_KEY` and `ANTHROPIC_API_KEY`. No credentials or cached videos were present in this checkout. The opening subtitle comes from the real `/api/reset` response; the labelled stage artwork is a still, not generated playback. API errors appear as readable status messages and detailed operator logs.

The partner strip uses text wordmarks and decorative symbols, with links supplied by the user. It describes them as hackathon partners, not customers or product endorsements.

## Visual assets

Original assets were made with the built-in image-generation tool and saved in `web/media/`. Prompts are recorded in `web/media/ASSETS.md`. The 3×2 image sheet is displayed using CSS background positions, avoiding duplicate image downloads. The favicon is an SVG companion to the generated film-ribbon U mark.

## Validation

- esbuild compiled the application and existing smoke-test bundles.
- Browser-tested landing → casting → Mina, illustrative choice switching, suggested text, missing-key errors, story-state toggle, and skip-error recovery.
- Responsive visual checks at desktop and 390px mobile widths.
- Live media generation and microphone capture still need the team's configured demo environment.
