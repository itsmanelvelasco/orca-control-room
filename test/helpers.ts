// Test helpers: fixture loading and a fake execFile that records every call.
import { readFileSync } from 'node:fs'
import type { ExecCallback, ExecFileLike, ExecOptions } from '../src/cli/run.ts'

const FIXTURES = new URL('./fixtures/', import.meta.url)

export function fixtureText(path: string): string {
  return readFileSync(new URL(path, FIXTURES), 'utf8')
}

export function fixture<T = any>(path: string): T {
  return JSON.parse(fixtureText(path)) as T
}

/** The `result` of a recorded envelope. */
export function resultOf(path: string): unknown {
  return fixture<{ result: unknown }>(path).result
}

export type ExecCall = { file: string; args: string[]; options: ExecOptions }

/** A fake execFile. `answer` decides what each call returns; every call is kept in `calls`. */
export function fakeExec(answer: (call: ExecCall) => { error?: any; stdout?: string; stderr?: string } = () => ({ stdout: '{"ok":true,"result":{}}' })): { exec: ExecFileLike; calls: ExecCall[] } {
  const calls: ExecCall[] = []
  const exec: ExecFileLike = (file, args, options, callback: ExecCallback) => {
    const call = { file, args: [...args], options }
    calls.push(call)
    const a = answer(call)
    queueMicrotask(() => callback(a.error ?? null, a.stdout ?? '', a.stderr ?? ''))
    return undefined
  }
  return { exec, calls }
}

/** A resolver that always finds `path`. */
export const foundAt = (path: string) => () => ({ ok: true as const, path, source: 'app' as const, tried: [{ path, source: 'app' as const }] })
