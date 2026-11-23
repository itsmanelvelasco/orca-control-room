// Untrusted text (bot questions, gate questions, agent titles) on its way to the panel or a
// notification: first non-empty line only, control and bidi characters out, whitespace folded,
// cut to a fixed length. Orca components draw strings as text, never HTML, so `<b>` stays `<b>`.

/** Longest text per field. */
export const MAX = { who: 60, what: 160, option: 40, options: 6 } as const

// C0/C1 controls and the bidi overrides that can make text read differently than it is.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** The first non-empty line of `text`, made safe and cut to `max` characters (with "…"). */
export function clean(text: string | null | undefined, max: number): string {
  if (typeof text !== 'string') return ''
  const line = text.split(/\r\n|\r|\n|\u2028|\u2029/).map((l) => l.replace(UNSAFE, '').replace(/\s+/g, ' ').trim()).find((l) => l !== '') ?? ''
  const chars = Array.from(line)
  return chars.length <= max ? line : `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`
}

/** Answer options: each cleaned, empties dropped, at most MAX.options. */
export function cleanOptions(options: readonly string[]): string[] {
  return options.map((o) => clean(o, MAX.option)).filter((o) => o !== '').slice(0, MAX.options)
}
