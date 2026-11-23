// R9: one desktop notification per new wait, never repeated, and the status bar count.
//
// A wait is "new" when its `notifyId` was never notified: a new question on an item, a new
// gate, an agent that enters a wait again. Notified ids live in the plugin's storage, so a
// restart does not notify again. The first run ever records what already waits, silently.
// The `notifyNewWaits` setting turns notifications off; ids are still recorded, so turning it
// back on does not flood.

import type { Wait } from './views/waits/collect.ts'
import { clean, MAX } from './views/waits/text.ts'

export const NOTIFY_SETTING = 'notifyNewWaits'
export const NOTIFIED_KEY = 'waits.notified'
export const STATUS_ITEM = 'waits'
/** Ids kept; older ones drop off. */
export const MAX_NOTIFIED = 500
/** At most this many notifications per refresh; the rest go in one summary. */
export const MAX_PER_UPDATE = 3

export type NotifierDeps = {
  show(title: string, body: string): Promise<unknown>
  load(): Promise<unknown>
  save(ids: string[]): Promise<unknown>
  enabled(): boolean
}

export type Notifier = {
  /** Notifies the waits not notified before; resolves with how many notifications it showed. */
  update(waits: readonly Wait[]): Promise<number>
}

export function notificationOf(w: Wait): { title: string; body: string } {
  const opts = w.options.length ? ` (${w.options.join(' / ')})` : ''
  return { title: clean(`Waits on you: ${w.who}`, MAX.who + 14), body: clean(`${w.label === 'Gate' || w.label === 'Needs you' ? '' : `${w.label}: `}${w.what}${opts}`, MAX.what) }
}

export function createNotifier(deps: NotifierDeps): Notifier {
  let ids: string[] | null = null
  let firstRun = false
  let chain: Promise<unknown> = Promise.resolve()

  const ready = async (): Promise<string[]> => {
    if (ids) return ids
    let stored: unknown = null
    try {
      stored = await deps.load()
    } catch {
      stored = null
    }
    firstRun = !Array.isArray(stored)
    ids = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
    return ids
  }

  const run = async (waits: readonly Wait[]): Promise<number> => {
    const seen = await ready()
    const fresh = waits.filter((w) => !seen.includes(w.notifyId))
    const silent = firstRun
    firstRun = false
    if (fresh.length === 0 && !silent) return 0
    seen.push(...fresh.map((w) => w.notifyId))
    if (seen.length > MAX_NOTIFIED) seen.splice(0, seen.length - MAX_NOTIFIED)
    try {
      await deps.save([...seen])
    } catch {
      // Storage failed: notifications still go out once in this run.
    }
    if (silent || !deps.enabled()) return 0
    let shown = 0
    const show = async (title: string, body: string): Promise<void> => {
      try {
        await deps.show(title, body)
        shown++
      } catch {
        // A refused or failed notification is not retried: never repeated.
      }
    }
    const direct = fresh.length > MAX_PER_UPDATE ? fresh.slice(0, MAX_PER_UPDATE - 1) : fresh
    for (const w of direct) {
      const n = notificationOf(w)
      await show(n.title, n.body)
    }
    if (direct.length < fresh.length) {
      const more = fresh.length - direct.length
      await show('Waits on you', `${more} more new wait${more === 1 ? '' : 's'}. Open Control Room to see them.`)
    }
    return shown
  }

  return {
    update(waits) {
      // One update at a time, so two quick refreshes never notify the same wait twice.
      const p = chain.then(() => run(waits))
      chain = p.catch(() => undefined)
      return p
    }
  }
}

/** What the status bar item shows for `count` waits. */
export function statusBarOf(count: number): { text: string; tooltip: string; tone: 'warning' | 'neutral' } {
  return {
    text: count === 0 ? 'No waits' : `${count} waiting`,
    tooltip: count === 0 ? 'Control Room: nothing waits on you' : `Control Room: ${count} thing${count === 1 ? '' : 's'} wait${count === 1 ? 's' : ''} on you`,
    tone: count === 0 ? 'neutral' : 'warning'
  }
}
