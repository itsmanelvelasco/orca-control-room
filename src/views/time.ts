// Relative times in English. Orca's `RelativeTime` (and a table's `relative` cell) follow Orca's
// UI locale, so a Spanish system showed "hace 24 s"; the PRD asks for an English UI. These
// formatters take no locale at all, and `clock` keeps them current: a panel reads it while
// rendering and the Control Room ticks it once a second while visible.
import { atom, read, set, type PanelContext } from 'orca'

/** The one locale the UI uses, for any future Intl or toLocale* call. */
export const LOCALE = 'en'

/** Now, in ms since the epoch; ticked by `startClock`. */
export const clock = atom<number>(Date.now())
export const CLOCK_MS = 1_000

/** Ticks `clock` once a second while the panel is visible. */
export function startClock(ctx: PanelContext): void {
  const timer = setInterval(() => {
    if (read(ctx.visible)) set(clock, Date.now())
  }, CLOCK_MS)
  // Where timers are Node's (tests, `plugin check`), the timer alone must not keep the process up.
  ;(timer as { unref?: () => void }).unref?.()
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
}

const S = 1_000
const M = 60 * S
const H = 60 * M
const D = 24 * H

/** "24s", "3m", "2h", "5d": a span, never negative. */
export function duration(ms: number): string {
  const t = Math.max(0, ms)
  if (t < M) return `${Math.floor(t / S)}s`
  if (t < H) return `${Math.floor(t / M)}m`
  if (t < D) return `${Math.floor(t / H)}h`
  return `${Math.floor(t / D)}d`
}

const UNIT: Record<string, string> = { s: 'second', m: 'minute', h: 'hour', d: 'day' }

/** "24s ago" (short) or "24 seconds ago" (long); "just now" under 5 s, and for a time ahead of now. */
export function ago(at: number, now: number, format: 'short' | 'long' = 'short'): string {
  const ms = now - at
  if (ms < 5 * S) return 'just now'
  const d = duration(ms)
  if (format === 'short') return `${d} ago`
  const n = Number(d.slice(0, -1))
  return `${n} ${UNIT[d.slice(-1)]}${n === 1 ? '' : 's'} ago`
}

/** Reads `clock` while rendering, so the text re-renders on each tick. */
export const agoNow = (at: number, format: 'short' | 'long' = 'short'): string => ago(at, read(clock), format)
export const durationNow = (since: number): string => duration(read(clock) - since)
