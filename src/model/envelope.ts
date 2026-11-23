// The JSON envelope every `orca <command> --json` prints, and the small readers the
// model parsers share. Parsers are lenient: a row with a missing or wrong-typed field is
// dropped or given a safe default, so one odd row never breaks a whole view.
//
// All text from the CLI (titles, questions, bodies) is untrusted: views escape it and
// never render it as HTML.

/** What the CLI prints with --json. On failure it also exits 1. */
export type CliEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }

/** Parses stdout. Returns null when it is not a JSON envelope (the "malformed" case). */
export function parseEnvelope(stdout: string): CliEnvelope | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isRecord(raw) || typeof raw.ok !== 'boolean') return null
  if (raw.ok) return { ok: true, result: raw.result ?? null }
  const err = isRecord(raw.error) ? raw.error : {}
  return { ok: false, error: { code: str(err.code) ?? 'unknown_error', message: firstLine(str(err.message) ?? 'The Orca CLI reported an error.') } }
}

export type JsonRecord = Record<string, unknown>

export const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A string, or undefined. */
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
/** A string, or null. */
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
/** A finite number, or null. */
export const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback)
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** The first line of a message, for one-line banners. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0].trim()
}

/** A value from a fixed set, or the fallback. Keeps a newer Orca's new states from breaking types. */
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

/** Some fields arrive as a JSON-encoded string array (`deps`, gate `options`). */
export function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v !== 'string' || v === '') return []
  try {
    const parsed: unknown = JSON.parse(v)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Maps rows through a parser and drops the ones it rejects (null). */
export function rows<T>(v: unknown, parse: (row: JsonRecord) => T | null): T[] {
  const out: T[] = []
  for (const r of arr(v)) {
    if (!isRecord(r)) continue
    const parsed = parse(r)
    if (parsed !== null) out.push(parsed)
  }
  return out
}
