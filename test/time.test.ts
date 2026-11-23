// PRD goal: an English UI. Relative times are formatted here, in English, never by Orca's
// locale-following `RelativeTime` or a table's `relative` cell (they showed "hace 24 s").
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { ago, duration, LOCALE } from '../src/views/time.ts'

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0)

test('ago: English, short and long', () => {
  assert.equal(ago(NOW - 2_000, NOW), 'just now')
  assert.equal(ago(NOW + 3_000, NOW), 'just now', 'a time ahead of now')
  assert.equal(ago(NOW - 24_000, NOW), '24s ago')
  assert.equal(ago(NOW - 31_000, NOW), '31s ago')
  assert.equal(ago(NOW - 3 * 60_000 - 5_000, NOW), '3m ago')
  assert.equal(ago(NOW - 2 * 3_600_000, NOW), '2h ago')
  assert.equal(ago(NOW - 5 * 86_400_000, NOW), '5d ago')
  assert.equal(ago(NOW - 24_000, NOW, 'long'), '24 seconds ago')
  assert.equal(ago(NOW - 60_000, NOW, 'long'), '1 minute ago')
  assert.equal(ago(NOW - 2 * 3_600_000, NOW, 'long'), '2 hours ago')
})

test('duration: a span, never negative', () => {
  assert.equal(duration(-5), '0s')
  assert.equal(duration(59_999), '59s')
  assert.equal(duration(60_000), '1m')
  assert.equal(duration(90 * 60_000), '1h')
  assert.equal(duration(49 * 3_600_000), '2d')
})

test('the same text under any process locale', () => {
  assert.equal(LOCALE, 'en')
  const saved = Intl.DateTimeFormat.prototype.resolvedOptions
  // Even with a Spanish default, nothing here asks Intl.
  assert.equal(ago(NOW - 24_000, NOW), '24s ago')
  assert.equal(Intl.DateTimeFormat.prototype.resolvedOptions, saved)
})

/** Every source file under src, as [path, text]. */
function sources(): [string, string][] {
  const root = new URL('../', import.meta.url)
  const out: [string, string][] = []
  const walk = (rel: string): void => {
    for (const name of readdirSync(new URL(rel, root))) {
      const path = `${rel}/${name}`
      if (statSync(new URL(path, root)).isDirectory()) walk(path)
      else if (/\.(tsx?|[cm]?js)$/.test(name)) out.push([path, readFileSync(new URL(path, root), 'utf8')])
    }
  }
  walk('src')
  return out
}

test('no locale-following time in src: no RelativeTime, no relative cell, Intl and toLocale* only with "en"', () => {
  const bad: string[] = []
  for (const [path, text] of sources()) {
    const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    if (/<RelativeTime\b|\bRelativeTime\s*[,}]/.test(code)) bad.push(`${path}: RelativeTime`)
    if (/type:\s*['"]relative['"]/.test(code)) bad.push(`${path}: relative table cell`)
    for (const m of code.matchAll(/(?:\bIntl\.\w+|\.toLocale\w*String)\s*\(([^)]*)\)?/g)) {
      if (!/^\s*(?:['"]en['"]|LOCALE)\b/.test(m[1])) bad.push(`${path}: ${m[0].slice(0, 50)} without 'en'`)
    }
  }
  assert.deepEqual(bad, [])
})
