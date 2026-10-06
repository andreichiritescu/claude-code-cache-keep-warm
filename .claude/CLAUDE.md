# Cache Keep-Warm: notes for working on this mod

A Claude Code mod (a plugin of function hooks). The code is `hooks/register.tsx`, its state contract `types/index.d.ts`, the manifests `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (this repo is its own marketplace, plugin source `./`).

These notes live in `.claude/` on purpose: a `CLAUDE.md` at the plugin root makes `claude plugin validate` warn.

## How it runs on the owner's machine

- `~/.claude/settings.json` → `env.CLAUDE_CODE_PLUGIN_DIRS` points at this folder, so every session loads the mod from here.
- `env.CLAUDE_CODE_PLUGIN_DIR_WATCH=1` makes open desktop sessions reload the mod after an edit, once the folder has been quiet for a moment. Without it, an edit needs an app restart.
- Do not also install it from the marketplace on this machine: it would load twice (two lines, double pings).

## Checking a change

- `claude plugin validate --strict .` checks the marketplace; `claude plugin validate --strict ./.claude-plugin/plugin.json` checks the plugin and the hooks module. The `hooks:` and `calls:` lines list everything the module does.
- The mod API is declared in `.claude-plugin/types/claude-code/index.d.ts`, which Claude Code writes when it loads the mod (gitignored). Grep it for an event or a `$` method. The built-in `plugin-authoring` skill explains the API.
- To test the public install from scratch, point `CLAUDE_CONFIG_DIR` at a fresh, SHORT temp folder (a long path fails with "Filename too long"), unset `CLAUDE_CODE_PLUGIN_DIRS`, then run the README's terminal commands. Install instructions use the full HTTPS address: the `owner/repo` form makes Claude Code try SSH first.
- Glyphs and spacing render differently in the desktop app than in a browser preview: test them in the real line (a temporary test row), never only in a mock.

## Mod API lessons (Claude Code 2.1.286)

- `claude plugin validate` rejects passing `$` to the `atom` / `read` / `update` helpers from `'claude-code'`, even the shipped examples: use `$.state.get` / `$.state.set` with literal `{ plugin, key } as const` refs.
- `$` may only be passed into functions declared in this file; `$.env.get` takes string literals.
- The desktop app collapses runs of spaces inside one `Text`, non-breaking spaces included: space details with separate elements and a `Box` `columnGap`.
- In the desktop font the plain `●` is smaller than `◔ ◑ ◕`: the full circle is `⚫` + U+FE0E (text style); `○` for cold.
- A `Button` without `plain` gets the app's normal button look.
- Per-request cache figures: the `turn.step` result's `usage` (cache read vs write). `turn.complete`'s usage is the whole turn.
- The keep-warm ping is `$.model.fork`: it re-sends the main thread's last request outside the conversation, reads the cache and restarts its hour (verified: 1 h 43 min idle stayed warm with two pings), and it works while an AskUserQuestion waits. `$.prompt.submit` did not: a queued prompt waits until the session is idle.
- Subscription vs API key: `$.session.usage().rateLimits` holds `five_hour` / `seven_day` windows only on a subscription (empty before the first response). Any window at 100% or more means over the plan limit, which drops Claude Code to the 5-minute cache.
- The session-title mark uses the desktop app's own tools through `$.tool.call`: `mcp__ccd_session_mgmt__get_session` (`session_id: "self"`) and `mcp__ccd_session_mgmt__set_session_title`. They are permission-"allow"; the app itself asks before renaming a title the user typed. In a terminal these tools do not exist and the call rejects (caught).
- `$.state` is per session and survives a reload; `$.store` is shared by every session (per plugin and load path); module variables reset on reload. An app relaunch empties `$.state`: the mod restores per-session values from the store. Moving the plugin folder changes the load path, so the stored sessions are lost.
- After a relaunch `rateLimits` stays empty until the session's first answer, so the mod keeps the last plan-based cache length in `$.store` (`plan-ttl`) and uses it until then.
- Mods can hook classic events: `classic.SessionStart` on a resume or fork carries `seconds_since_last_response` and `context_tokens`, which the mod uses to carry the countdown on in a reopened session (counting from 3 minutes before that answer, so the ping is early rather than late). `source: 'clear'` resets it.
- `$.model.fork` answers `nothing-to-fork` until the conversation has answered in this process: after an app relaunch (verified 2026-10-06) and right after `/clear`. The mod knows this in advance from `sawResponse` (empty after a relaunch, reset by `/clear`), shows "next ping HH:MM (shows in chat)", and sends that ping as a real message with `$.prompt.submit` (Claude answers "ok"); later pings are invisible again.
- A turn that dies before an answer (`turn.complete` `reason: 'error'`, no `usage`; for example Claude Code's own "Prompt is too long") reaches no cache. Only a turn with `usage` counts as an answer (`sawResponse`); counting the failed one made the mod read the empty plan list as "5-minute cache (API key)". A `turn.step` with zero usage puts `lastRequestAt` back. A failed visible ping shows "ping failed: <Claude Code's words>".
- After a restart Claude Code attaches the project's instruction files to the first prompt (957 KB in the RealEstate project, 2026-10-06), so the visible ping can overflow a nearly full conversation or trigger a compaction. The mod sends it only below 75% of the context window; above that the line says "conversation nearly full: keep-warm waits for you".
- `classic.SessionStart` with `source: 'compact'` (after `/compact`) starts the countdown over like `/clear`.
- The weekly store clean-up ages entries by `savedAt` (since 1.0.4), not by `lastRequestAt`: a session `/compact` had reset to 0 looked ancient, every other session's start deleted its entry, and after a restart it came back with keep-warm off (2026-10-06). The classic.SessionStart hook never saves before `session.start` has restored (it could write the defaults over the saved switch).
- The line never wraps: the outer and detail Boxes are `flexWrap="nowrap"`, the circle, bar, time and button `flexShrink={0}`, and the details Box `minWidth={0}` + `overflow="hidden"`, so a narrow window cuts the details instead of breaking "5 min / left" and dropping the button to a new row.
- Never copy the mod into `~/.claude/dev-mods/<session>/`: next to the folder in `CLAUDE_CODE_PLUGIN_DIRS` it loads twice. Old copies there broke the line after a restart (2026-10-06).

## Behaviour agreed with the owner

- Never ping a cold cache, visible or not. Ping 5 min before expiry (55 min into the 1-hour cache), retry every 30 s on failure, stop after 20 pings in a row unless a stop time was given. Keep-warm only for a cache of 30 min or more.
- Keep it light: one local check every 15 s, the line redrawn at most once a minute, no model call except the ping.
- The line: circle `⚫ ◕ ◑ ◔ ○`, 10 blocks `▰ ▱`, "N min left (HH:MM)" in bold, dim details separated by `·`. Green only while keep-warm is on and able to ping; everything else default grey.
- The cache length is detected (settings, then plan) and corrected by what the cache actually does.
- After a restart the line must be honest from the start: if the next ping has to be the visible one, it says so ("(shows in chat)") before the ping, not when it fails (owner's ruling 2026-10-06, chosen over waiting for the user's next message).

## Releasing

- Bump `version` in `.claude-plugin/plugin.json` for every release: marketplace installs stay on the old version until it changes.
- Repository: https://github.com/andreichiritescu/claude-code-cache-keep-warm (MIT).
- Anthropic plugin directory: submitted 2026-10-06, https://claude.ai/directory/manage/plugins/69d31aba-5641-4f5e-ae46-f640957be779. It re-reads `main` about every 6 hours and auto-publishes versions that pass their checks.
- The README section "What it runs, reads and sends" is the plugin's privacy policy (`privacyPolicyUrl`) and what the directory's reviewer checks the mod against. Update it in the same change whenever the mod calls a new tool, reads or stores something new, or sends anything new.
- The owner commits and pushes. Do not commit or push unless asked.
