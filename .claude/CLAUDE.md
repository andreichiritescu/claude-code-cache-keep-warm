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
- `$.state` is per session and survives a reload; `$.store` is shared by every session (per plugin and load path); module variables reset on reload.

## Behaviour agreed with the owner

- Never ping a cold cache. Ping 5 min before expiry (55 min into the 1-hour cache), retry every 30 s on failure, stop after 20 pings in a row unless a stop time was given. Keep-warm only for a cache of 30 min or more.
- Keep it light: one local check every 15 s, the line redrawn at most once a minute, no model call except the ping.
- The line: circle `⚫ ◕ ◑ ◔ ○`, 10 blocks `▰ ▱`, "N min left (HH:MM)" in bold, dim details separated by `·`. Green only while keep-warm is on and able to ping; everything else default grey.
- The cache length is detected (settings, then plan) and corrected by what the cache actually does.

## Releasing

- Bump `version` in `.claude-plugin/plugin.json` for every release: marketplace installs stay on the old version until it changes.
- Repository: https://github.com/andreichiritescu/claude-code-cache-keep-warm (MIT).
- The owner commits and pushes. Do not commit or push unless asked.
