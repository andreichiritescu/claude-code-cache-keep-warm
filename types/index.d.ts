/**
 * What the mod remembers per session id in `$.store`, so a relaunch keeps it. `ttl` is the cache
 * length in effect when it was saved (absent in entries from before 1.0.3).
 */
export type KeepWarmSaved = { lastRequestAt: number; keepWarm: boolean; stopAt: number; ttl?: KeepWarmTtl }

/** One keep-warm ping: when it started, whether the cache still held the conversation, how much it read. */
export type KeepWarmPing = { at: number; isHit: boolean; read: number }

/**
 * How long the main conversation's cache lives, and why: from a setting, from the plan, or
 * corrected by what the cache actually did. Null until it can be told. The last one the plan
 * showed is also kept in `$.store` under `plan-ttl`, shared by every session.
 */
export type KeepWarmTtl = { ms: number; reason: 'subscription' | 'api' | 'overage' | 'setting' | 'observed' } | null

declare module 'claude-code' {
  interface PluginState {
    'cache-keep-warm': {
      /** When the main conversation's last model request started (ms since epoch); 0 = unknown. */
      lastRequestAt: number
      /** Whether this session keeps its cache warm. */
      keepWarm: boolean
      /** When keep-warm switches itself off (ms since epoch); 0 = after the ping limit. */
      stopAt: number
      /** The clock as the band last showed it. */
      now: number
      /** Pings since keep-warm was last switched on, oldest first. */
      pings: KeepWarmPing[]
      /** The cache lifetime as last worked out. */
      ttl: KeepWarmTtl
      /** Tokens the last request sent: what a cold cache would make the next message re-write. */
      contextTokens: number
      /** True while Claude waits on an answer to its question. */
      isWaiting: boolean
      /**
       * True once this process has seen a main-thread response: the ping can then be invisible (a
       * fork), and an empty plan list then means an API key. Reset by /clear.
       */
      sawResponse: boolean
      /** The idle gap after which the cache was found cold although it should have lasted; 0 = none seen. */
      shortAfterMs: number
      /** True when the invisible ping found nothing to repeat, so the visible one is used, until the next request. */
      waitsForMessage: boolean
      /** True once this process has restored the session's saved values from the store. */
      restored: boolean
      /** Why the last ping did not reach the model (Claude Code's words or the HTTP status); '' = none. */
      pingError: string
      /** True while the conversation fills too much of the context window for a visible ping. */
      nearlyFull: boolean
    }
  }
}
