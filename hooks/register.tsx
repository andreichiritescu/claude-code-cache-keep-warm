import type { EngineInterface, ModelUsage, Register, SessionUsage } from 'claude-code'

import type { KeepWarmPing, KeepWarmSaved, KeepWarmTtl } from '../types'

const HOUR_MS = 60 * 60_000
const FIVE_MIN_MS = 5 * 60_000
// The cache lengths Claude Code offers today; a value seen elsewhere is still accepted.
const KNOWN_TTLS_MS = [FIVE_MIN_MS, HOUR_MS]
// Keep-warm only for a cache this long or longer: on a short cache, pinging every few
// minutes costs more than the single re-write it saves after any real break.
const KEEP_WARM_MIN_TTL_MS = 30 * 60_000
// A ping goes out this long before the cache would expire (55 min into a 1-hour cache), and
// never in its last minute: a cold cache is never pinged. A later ping means fewer of them
// (one per ~55 min instead of one per 45), and the lead still leaves four minutes of retries
// if the API is busy. The cache's life runs from when a request reaches the server, a moment
// after the time recorded here, so the real deadline is slightly later than computed.
const PING_LEAD_MS = 5 * 60_000
const PING_MARGIN_MS = 60_000
// After a failed ping, wait this long before trying again inside the window.
const PING_RETRY_MS = 30_000
// Without an explicit stop time, keep-warm stops itself after this many pings in a row
// (~15 h): past ~30 h idle, re-writing the cache once is cheaper than pinging.
const MAX_PINGS = 20
// One check every 15 s: local reads only (clock, session figures, settings), no model call.
// The line is redrawn only when its text changes, at most once a minute.
const TICK_MS = 15_000
const PING_PENDING_MS = 5 * 60_000
// A request reading at least this share of the conversation from cache found it still warm.
const HIT_SHARE = 0.5
// A re-write after a shorter gap is a change to the prompt (compaction, a model switch),
// not an expiry, so it says nothing about the cache's length.
const EVIDENCE_GAP_MS = FIVE_MIN_MS + 30_000
// With keep-warm off, the band names what is at stake once this little time is left.
const EXPIRING_MS = 10 * 60_000
// Blocks that empty over the cache's life: filled blocks green while keep-warm is on (grey
// otherwise), outlined blocks for the time already gone.
const BAR_CELLS = 10
const BAR_FULL = '▰'
const BAR_EMPTY = '▱'
// Space between the details, in the surface's own units (columns on the terminal).
const DETAIL_GAP = 2
// The circle in front empties with the cache's life, a quarter at a time; hollow once cold.
// The full one is the "medium black circle" in text style: the plain ● is drawn smaller than
// the quarter circles in the desktop app's font (picked by the user from a test row).
const CIRCLE_BY_QUARTER = ['◔', '◑', '◕', '⚫︎']
const CIRCLE_COLD = '○'
// While keep-warm is on, the session's title in the app's list starts with this mark. The app
// asks before changing a title you typed yourself; titles it generated change without asking.
const TITLE_MARK = '🟢 '
// The userConfig key in plugin.json that switches the title mark off.
const TITLE_MARK_OPTION = 'title_mark'
const TITLE_SYNC_MS = 5 * 60_000
const GET_SESSION_TOOL = 'mcp__ccd_session_mgmt__get_session'
const SET_TITLE_TOOL = 'mcp__ccd_session_mgmt__set_session_title'
const TITLE_FIELD = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/
const HISTORY_SHOWN = 5
const PING_TEXT = 'Keep-warm ping. Reply with just "ok".'
const COMMAND = 'keepwarm'
const STORE_PREFIX = 'session:'
const STORE_MAX_AGE_MS = 7 * 24 * HOUR_MS
// Rate-limit windows that only a Claude subscription reports; an API key or a cloud provider reports none.
const PLAN_WINDOWS = ['five_hour', 'seven_day']
const PLAN_LIMIT_PERCENT = 100
const TTL_VALUE = /^(\d+)\s*(s|m|h)$/
const DURATION = /^(\d+(?:\.\d+)?)\s*(h|m|min)$/
const UNTIL = /^until\s+(\d{1,2}):(\d{2})$/

const LAST = { plugin: 'cache-keep-warm', key: 'lastRequestAt' } as const
const KEEP_WARM = { plugin: 'cache-keep-warm', key: 'keepWarm' } as const
const STOP_AT = { plugin: 'cache-keep-warm', key: 'stopAt' } as const
const NOW = { plugin: 'cache-keep-warm', key: 'now' } as const
const PINGS = { plugin: 'cache-keep-warm', key: 'pings' } as const
const TTL = { plugin: 'cache-keep-warm', key: 'ttl' } as const
const CONTEXT = { plugin: 'cache-keep-warm', key: 'contextTokens' } as const
const WAITING = { plugin: 'cache-keep-warm', key: 'isWaiting' } as const
const SAW_RESPONSE = { plugin: 'cache-keep-warm', key: 'sawResponse' } as const
const SHORT_AFTER = { plugin: 'cache-keep-warm', key: 'shortAfterMs' } as const

// The module's own variables start over on a reload; what must survive one is in $.state.
// `titleMark` is the user's "Mark the session title" setting; changing it in /config reloads
// the module, so it is read once in register().
const live = { storeKey: '', pingPendingUntil: 0, shownKey: '', titleMark: true }

function minutes(ms: number) {
  return Math.max(0, Math.floor(ms / 60_000))
}

function clockTime(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function tokens(n: number) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`
}

function timeLeft(ms: number) {
  return ms < 60_000 ? 'under a minute left' : `${minutes(ms)} min left`
}

function cacheLength(ms: number) {
  return ms >= HOUR_MS && ms % HOUR_MS === 0 ? `${ms / HOUR_MS}-hour` : `${minutes(ms)}-minute`
}

// "5m", "1h", "30m", "90s": any length, so a cache length Claude Code adds later still reads.
function parseTtl(value: unknown) {
  if (typeof value !== 'string') return 0
  const m = TTL_VALUE.exec(value.trim())
  if (!m) return 0
  return Number(m[1]) * (m[2] === 'h' ? HOUR_MS : m[2] === 'm' ? 60_000 : 1000)
}

// The same precedence Claude Code itself applies, then the plan: a subscription within its
// limits gets the hour, one over its limit (paying usage credits) and an API key get 5 minutes.
async function detectTtl($: EngineInterface, usage: SessionUsage): Promise<KeepWarmTtl> {
  if ((await $.env.get('FORCE_PROMPT_CACHING_5M')) === '1') return { ms: FIVE_MIN_MS, reason: 'setting' }
  const fromEnv = parseTtl(await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))
  if (fromEnv) return { ms: fromEnv, reason: 'setting' }
  const settings = await $.settings.read()
  const fromSettings = parseTtl(settings['promptCacheTtl'])
  if (fromSettings) return { ms: fromSettings, reason: 'setting' }
  if ((await $.env.get('ENABLE_PROMPT_CACHING_1H')) === '1') return { ms: HOUR_MS, reason: 'setting' }

  const plan = usage.rateLimits.filter(w => PLAN_WINDOWS.includes(w.kind))
  if (plan.length === 0) {
    // The windows arrive with the first response, so before one an empty list proves nothing.
    const { value: sawResponse = false } = await $.state.get(SAW_RESPONSE)
    return sawResponse ? { ms: FIVE_MIN_MS, reason: 'api' } : null
  }
  return plan.some(w => w.percentUsed >= PLAN_LIMIT_PERCENT)
    ? { ms: FIVE_MIN_MS, reason: 'overage' }
    : { ms: HOUR_MS, reason: 'subscription' }
}

// What the cache actually did beats what the settings say: if it went cold after a gap it
// should have survived, use the longest known length shorter than that gap.
function correctTtl(base: KeepWarmTtl, shortAfterMs: number): KeepWarmTtl {
  if (!base || shortAfterMs <= 0 || shortAfterMs >= base.ms - PING_MARGIN_MS) return base
  const shorter = KNOWN_TTLS_MS.filter(ms => ms < shortAfterMs)
  return { ms: shorter.length ? Math.max(...shorter) : FIVE_MIN_MS, reason: 'observed' }
}

// Each request after an idle gap shows whether the cache outlived that gap: a read clears an
// earlier "went cold too soon"; a re-write after a gap the cache should have survived records one.
async function observe($: EngineInterface, gapMs: number, usage: ModelUsage) {
  const total = usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  if (total === 0 || gapMs < EVIDENCE_GAP_MS) return
  if (usage.cache_read_input_tokens >= HIT_SHARE * total) {
    await $.state.set(SHORT_AFTER, 0)
    return
  }
  const { value: ttl = null } = await $.state.get(TTL)
  const { value: shortAfter = 0 } = await $.state.get(SHORT_AFTER)
  const expected = ttl?.reason === 'observed' ? HOUR_MS : (ttl?.ms ?? HOUR_MS)
  if (gapMs < expected - PING_MARGIN_MS) await $.state.set(SHORT_AFTER, shortAfter > 0 ? Math.min(shortAfter, gapMs) : gapMs)
}

async function save($: EngineInterface) {
  if (!live.storeKey) return
  const { value: lastRequestAt = 0 } = await $.state.get(LAST)
  const { value: keepWarm = false } = await $.state.get(KEEP_WARM)
  const { value: stopAt = 0 } = await $.state.get(STOP_AT)
  const saved: KeepWarmSaved = { lastRequestAt, keepWarm, stopAt }
  await $.store.set(live.storeKey, saved)
}

async function setKeepWarm($: EngineInterface, isOn: boolean, stopAt: number) {
  await $.state.set(KEEP_WARM, isOn)
  await $.state.set(STOP_AT, isOn ? stopAt : 0)
  await $.state.set(PINGS, [])
  await save($)
  await syncTitle($)
}

// Puts the mark on this session's title in the app's list while keep-warm is on, and takes it
// off otherwise (or always, with the setting off). Runs on every switch, at start (which also
// clears a mark a crash left behind) and every few minutes (a title the app regenerated loses
// the mark). Outside the desktop app there are no session tools and nothing is marked.
async function syncTitle($: EngineInterface) {
  const { value: isOn = false } = await $.state.get(KEEP_WARM)
  const { value: ttl = null } = await $.state.get(TTL)
  const wantsMark = live.titleMark && isOn && !(ttl && ttl.ms < KEEP_WARM_MIN_TTL_MS)
  try {
    const found = await $.tool.call({ tool: GET_SESSION_TOOL, session_id: 'self' })
    if ('deny' in found && found.deny) return
    const match = TITLE_FIELD.exec(found.text ?? '')
    if (!match) return
    const title: string = JSON.parse(`"${match[1]}"`)
    const hasMark = title.startsWith(TITLE_MARK)
    if (wantsMark === hasMark) return
    const base = hasMark ? title.slice(TITLE_MARK.length) : title
    await $.tool.call({ tool: SET_TITLE_TOOL, session_id: 'self', title: wantsMark ? TITLE_MARK + base : base })
  } catch {
    // No session tools here (a terminal session), or the app declined the rename: leave the title.
  }
}

// The ping re-sends the main thread's last request outside the conversation with one short
// question after it: it reads the conversation from cache (restarting its life), adds no
// message, and runs even while the session waits on a question or a permission prompt.
async function ping($: EngineInterface, startedAt: number, lastRequestAt: number) {
  const r = await $.model.fork({ prompt: PING_TEXT })
  if (!r.isAnswered && r.reason === 'nothing-to-fork') return
  if (!r.isAnswered && r.reason === 'api-error') {
    $.ui.toast(`Keep-warm ping failed (HTTP ${r.status ?? '?'}); retrying in ${PING_RETRY_MS / 1000} s.`)
    live.pingPendingUntil = startedAt + PING_RETRY_MS
    return
  }
  const { cache_read_input_tokens: read, cache_creation_input_tokens: written } = r.usage
  const isHit = read > 0 && read >= HIT_SHARE * (read + written)
  const done: KeepWarmPing = { at: startedAt, isHit, read }
  const { value: pings = [] } = await $.state.get(PINGS)
  await $.state.set(PINGS, [...pings, done].slice(-MAX_PINGS))
  // A ping that found the cache cold proves the cache is shorter than assumed, which pauses
  // keep-warm (another cold ping would only pay for a full re-write again).
  await observe($, startedAt - lastRequestAt, r.usage)
  await $.state.set(LAST, startedAt)
  await save($)
}

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  const usage = await $.session.usage()
  const { value: shortAfter = 0 } = await $.state.get(SHORT_AFTER)
  const ttl = correctTtl(await detectTtl($, usage), shortAfter)
  const { value: last = 0 } = await $.state.get(LAST)

  // Redraw only when what the band shows would change: each minute, and whenever the cache
  // length or the context size moves.
  const contextTokens = usage.context.tokens ?? 0
  const shownKey = `${Math.floor(t / 60_000)}|${ttl?.ms ?? 0}|${ttl?.reason ?? ''}|${contextTokens}|${last}|${shortAfter}`
  if (shownKey !== live.shownKey) {
    live.shownKey = shownKey
    await $.state.set(TTL, ttl)
    await $.state.set(CONTEXT, contextTokens)
    await $.state.set(NOW, t)
  }

  const { value: isOn = false } = await $.state.get(KEEP_WARM)
  if (!isOn) return
  const { value: stopAt = 0 } = await $.state.get(STOP_AT)
  if (stopAt > 0 && t >= stopAt) {
    await setKeepWarm($, false, 0)
    $.ui.toast(`Keep-warm stopped at ${clockTime(stopAt)} as asked; the cache will expire normally.`)
    return
  }

  const idle = t - last
  const isPingWindow =
    ttl !== null &&
    ttl.ms >= KEEP_WARM_MIN_TTL_MS &&
    last > 0 &&
    idle >= ttl.ms - PING_LEAD_MS &&
    idle < ttl.ms - PING_MARGIN_MS
  if (!isPingWindow || t < live.pingPendingUntil) return

  const { value: pings = [] } = await $.state.get(PINGS)
  if (stopAt === 0 && pings.length >= MAX_PINGS) {
    await setKeepWarm($, false, 0)
    $.ui.toast(`Keep-warm stopped itself after ${MAX_PINGS} pings; the cache will expire.`)
    return
  }
  live.pingPendingUntil = t + PING_PENDING_MS
  await ping($, t, last)
}

// "3h", "90m", "until 18:00" -> when keep-warm stops; 0 = no stop time; -1 = not understood.
function parseStop(text: string, now: number) {
  if (text === '') return 0
  const duration = DURATION.exec(text)
  if (duration) return now + Number(duration[1]) * (duration[2] === 'h' ? HOUR_MS : 60_000)
  const until = UNTIL.exec(text)
  if (!until) return -1
  const at = new Date(now)
  at.setHours(Number(until[1]), Number(until[2]), 0, 0)
  return at.getTime() > now ? at.getTime() : at.getTime() + 24 * HOUR_MS
}

export const register: Register = (on, options) => {
  live.titleMark = options[TITLE_MARK_OPTION] !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Keep this session\'s prompt cache warm: on [3h | until 18:00], off, or status',
      argumentHint: '[on [3h|until 18:00] | off]',
      immediate: true,
    })

    live.storeKey = STORE_PREFIX + (await $.session.id())
    // After an app relaunch the session's values are gone; the store keeps them per session id.
    const { value: known = 0 } = await $.state.get(LAST)
    if (known === 0) {
      const saved = (await $.store.get(live.storeKey)) as KeepWarmSaved | undefined
      if (saved) {
        await $.state.set(LAST, saved.lastRequestAt)
        await $.state.set(KEEP_WARM, saved.keepWarm)
        await $.state.set(STOP_AT, saved.stopAt ?? 0)
      }
    }

    // Forget sessions untouched for a week so the store stays small.
    const t = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX) || key === live.storeKey) continue
      const old = (await $.store.get(key)) as KeepWarmSaved | undefined
      if (!old || t - old.lastRequestAt > STORE_MAX_AGE_MS) await $.store.delete(key)
    }

    await tick($)
    $.clock.every(TICK_MS, () => void tick($))
    void syncTitle($)
    $.clock.every(TITLE_SYNC_MS, () => void syncTitle($))

    return next(e)
  })

  // Each model request of the main conversation (not a subagent's: its cache is its own):
  // it restarts the cache's life, and its usage shows whether the cache outlived the gap.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const t = await $.clock.now()
    const { value: previous = 0 } = await $.state.get(LAST)
    live.pingPendingUntil = 0
    await $.state.set(LAST, t)
    await $.state.set(NOW, t)
    await save($)
    const result = yield* next(e)
    if (result?.usage && previous > 0) await observe($, t - previous, result.usage)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await $.state.set(SAW_RESPONSE, true)
    return next(e)
  })

  // While Claude's question waits for an answer the turn stays open; the band says so.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    await $.state.set(WAITING, true)
    try {
      return await next(e)
    } finally {
      await $.state.set(WAITING, false)
    }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const t = await $.clock.now()
    const words = e.args.trim().toLowerCase()
    const [first = ''] = words.split(/\s+/)
    if (first === 'off') {
      await setKeepWarm($, false, 0)
    } else if (words !== '' && words !== 'status') {
      const stopAt = parseStop(first === 'on' ? words.slice(2).trim() : words, t)
      if (stopAt < 0) return { text: 'Not understood. Try: /keepwarm on, /keepwarm 3h, /keepwarm until 18:00, /keepwarm off' }
      await setKeepWarm($, true, stopAt)
    }

    const { value: isOn = false } = await $.state.get(KEEP_WARM)
    const { value: stopAt = 0 } = await $.state.get(STOP_AT)
    const { value: ttl = null } = await $.state.get(TTL)
    const { value: pings = [] } = await $.state.get(PINGS)
    const lines = [
      isOn
        ? `Keep-warm on${stopAt ? ` until ${clockTime(stopAt)}` : ` (stops itself after ${MAX_PINGS} pings)`}: about ${minutes(PING_LEAD_MS)} min before the cache would expire, it re-reads the conversation from cache in the background. A cold cache is never pinged.`
        : 'Keep-warm off: the cache expires normally.',
    ]
    if (ttl) lines.push(`This session's cache lasts ${cacheLength(ttl.ms)} (${ttl.reason === 'observed' ? 'seen expiring sooner than expected' : ttl.reason}).`)
    if (ttl && ttl.ms < KEEP_WARM_MIN_TTL_MS) lines.push(`Keep-warm only pings a cache of ${minutes(KEEP_WARM_MIN_TTL_MS)} min or longer.`)
    for (const p of pings.slice(-HISTORY_SHOWN)) {
      lines.push(`${clockTime(p.at)} · ${p.isHit ? `read ${tokens(p.read)} from cache` : 'found the cache cold'}`)
    }
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const { value: last = 0 } = await $.state.get(LAST)
    const { value: now = 0 } = await $.state.get(NOW)
    const { value: isOn = false } = await $.state.get(KEEP_WARM)
    const { value: stopAt = 0 } = await $.state.get(STOP_AT)
    const { value: pings = [] } = await $.state.get(PINGS)
    const { value: ttl = null } = await $.state.get(TTL)
    const { value: contextTokens = 0 } = await $.state.get(CONTEXT)
    const { value: isWaiting = false } = await $.state.get(WAITING)
    const { value: shortAfter = 0 } = await $.state.get(SHORT_AFTER)

    const t = Math.max(now, last)
    const ttlMs = ttl?.ms ?? HOUR_MS
    const canKeepWarm = ttl !== null && ttl.ms >= KEEP_WARM_MIN_TTL_MS
    // Green only while keep-warm is on and able to ping; everything else stays default grey.
    const isGreen = isOn && canKeepWarm
    const expiresAt = last + ttlMs
    const remaining = expiresAt - t
    const isWarm = last > 0 && remaining > 0
    const filled = isWarm ? Math.max(1, Math.ceil((remaining / ttlMs) * BAR_CELLS)) : 0
    const quarters = CIRCLE_BY_QUARTER.length
    const circle = isWarm
      ? CIRCLE_BY_QUARTER[Math.min(quarters, Math.max(1, Math.ceil((remaining / ttlMs) * quarters))) - 1]
      : CIRCLE_COLD

    // The first part (time left) is drawn bold; the dot and the button already say whether
    // keep-warm is on, so the text no longer repeats it.
    const main = last === 0 ? 'no request seen yet' : isWarm ? timeLeft(remaining) : `cold since ${clockTime(expiresAt)}`
    // "58 min left (14:12)": the clock time the cache expires, right after the time left.
    const expiresText = isWarm ? ` (${clockTime(expiresAt)})` : ''
    const parts: string[] = []
    if (isWaiting && isWarm) parts.push('waiting for your answer')

    if (ttl && !canKeepWarm) {
      if (ttl.reason === 'observed') parts.push(`cache expired after ${minutes(shortAfter)} min, sooner than expected`, 'keep-warm paused')
      else if (ttl.reason === 'overage') parts.push(`${cacheLength(ttl.ms)} cache while over your plan limit`, 'keep-warm paused')
      else parts.push(`${cacheLength(ttl.ms)} cache (${ttl.reason === 'api' ? 'API key' : 'your settings'})`, 'keep-warm needs the 1-hour cache')
    } else if (isOn) {
      const lastPing = pings[pings.length - 1]
      if (stopAt) parts.push(`keep-warm stops ${clockTime(stopAt)}`)
      if (isWarm) parts.push(`next ping ${clockTime(last + ttlMs - PING_LEAD_MS)}`)
      if (lastPing) parts.push(`${pings.length} ping${pings.length === 1 ? '' : 's'} ${lastPing.isHit ? '✓' : '✗'}`)
    }

    if (contextTokens > 0 && last > 0) {
      if (!isWarm) parts.push(`your next message re-writes ${tokens(contextTokens)}`, ...(isGreen ? ['keep-warm restarts after it'] : []))
      else if (!isGreen && remaining < EXPIRING_MS) parts.push(`after ${clockTime(expiresAt)} your next message re-writes ${tokens(contextTokens)}`)
      else parts.push(`${tokens(contextTokens)} cached`)
    }

    // No toggle where keep-warm can never ping (an API key, or a short cache set on purpose).
    const canToggle = isOn || !ttl || canKeepWarm || ttl.reason === 'overage' || ttl.reason === 'observed'

    // Each detail is its own element and the spacing comes from the layout (column gaps), which
    // no surface squeezes the way it squeezes runs of spaces inside one text.
    return (
      <Box alignItems="center">
        <Box flexGrow={1} alignItems="center" columnGap={DETAIL_GAP}>
          {isGreen ? <Text color="green" bold>{circle}</Text> : <Text dimColor>{circle}</Text>}
          <Box>
            {isGreen ? <Text color="green">{BAR_FULL.repeat(filled)}</Text> : <Text dimColor>{BAR_FULL.repeat(filled)}</Text>}
            <Text dimColor>{BAR_EMPTY.repeat(BAR_CELLS - filled)}</Text>
          </Box>
          <Box>
            <Text bold>{main}</Text>
            <Text dimColor>{expiresText}</Text>
          </Box>
          {parts.flatMap(p => [<Text dimColor>·</Text>, <Text dimColor>{p}</Text>])}
        </Box>
        {canToggle && (
          <Button
            key="toggle"
            label={isOn ? 'Stop' : 'Keep warm'}
            onPress={() => setKeepWarm($, !isOn, 0)}
          />
        )}
      </Box>
    )
  })
}
