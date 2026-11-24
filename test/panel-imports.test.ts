// A panel runs in Orca's browser frame, which loads each source file as an ES module without a
// bundler: it serves "orca", "orca/…" and relative files, and leaves any other specifier to the
// browser. The browser cannot fetch `node:child_process`, so one such import anywhere below a
// panel entry fails the whole panel with "Failed to fetch dynamically imported module".
// `orca plugin check` renders panels in Node, where `node:` loads, so it does not catch this.
// This test walks every panel entry's import graph and fails on any import a frame cannot load.
import { existsSync, readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'

const ROOT = new URL('../', import.meta.url)

/** The specifiers one source text loads at run time: `import type` and `export type` are erased. */
export function runtimeImports(text: string): string[] {
  const found: string[] = []
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?([\w*{}\s,$]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (!m[2]) found.push(m[4])
  }
  for (const m of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) found.push(m[1])
  return found
}

/** Why a frame cannot load `spec` from file `from` (a path from the repo root), or null. */
export function frameRefusal(from: string, spec: string, exists: (path: string) => boolean): string | null {
  if (spec === 'orca' || spec.startsWith('orca/')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return `"${spec}" is not a file: a panel frame cannot fetch it`
  if (!spec.startsWith('./') && !spec.startsWith('../')) return `"${spec}" is a package: plugins load without a bundler`
  const path = new URL(spec, new URL(from, 'file:///r/')).pathname.slice('/r/'.length)
  return exists(path) ? null : `"${spec}" is not in the plugin`
}

/** Every refused import below `entry`, as "file: reason". Follows relative imports only. */
export function panelGraphRefusals(entry: string, read: (path: string) => string, exists: (path: string) => boolean): string[] {
  const bad: string[] = []
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of runtimeImports(read(file))) {
      const why = frameRefusal(file, spec, exists)
      if (why) bad.push(`${file}: ${why}`)
      else if (spec.startsWith('.')) queue.push(new URL(spec, new URL(file, 'file:///r/')).pathname.slice('/r/'.length))
    }
  }
  return bad
}

const readRepo = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8')
const inRepo = (path: string): boolean => existsSync(new URL(path, ROOT))

test('every panel entry loads in a frame: no node:, package or missing import below it', () => {
  const manifest = JSON.parse(readRepo('orca-plugin.json')) as { contributes: { panels: { entry: string }[] } }
  const entries = manifest.contributes.panels.map((p) => p.entry)
  assert.ok(entries.length > 0, 'the manifest has no panels')
  assert.deepEqual(entries.flatMap((e) => panelGraphRefusals(e, readRepo, inRepo)), [])
})

test('the panel import walk catches each refused import (so a pass means something)', () => {
  const files: Record<string, string> = {
    'src/panel.tsx': "import { atom } from 'orca'\nimport { a } from './a.ts'\nimport type { T } from './types-only.ts'\n",
    'src/a.ts': "import {\n  isId,\n  type Req\n} from './cli/index.ts'\nexport { b } from './b.ts'\n",
    'src/cli/index.ts': "import { execFile } from 'node:child_process'\nimport '../side.ts'\n",
    'src/b.ts': "import lodash from 'lodash'\n// import { x } from 'node:fs'\n",
    'src/side.ts': "import { gone } from './gone.ts'\n"
  }
  const bad = panelGraphRefusals('src/panel.tsx', (p) => files[p] ?? '', (p) => p in files)
  assert.deepEqual(bad, [
    'src/cli/index.ts: "node:child_process" is not a file: a panel frame cannot fetch it',
    'src/b.ts: "lodash" is a package: plugins load without a bundler',
    'src/side.ts: "./gone.ts" is not in the plugin'
  ])
  // A type-only import is erased, so a type from a Node-only file is fine.
  assert.deepEqual(runtimeImports("import type { CliResult } from '../../cli/index.ts'"), [])
  assert.deepEqual(runtimeImports("export type { Wait } from './collect.ts'"), [])
})
