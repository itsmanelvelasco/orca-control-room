# Control Room (Orca plugin)

One Orca panel for what waits on you and where each piece of work stands. Runs on: Windows, macOS, Linux. Stack: TypeScript that Orca transpiles on load; no dependencies, no build step, no network. English code and UI.
PRD: https://claude.ai/artifact/NwJN9uGm36gCJxwtCGCiQN
The user-level standard applies: branch, gate, picture, PR, no merge unasked.

## Commands
- Run from source: `orca plugin dev load .` (prints an approval fingerprint the first time), then `orca plugin dev request . cli.status` and `orca plugin logs local.control-room`.
- Gate: `bash scripts/ci-local.sh` (full: manifest, tests, panels, fixtures clean, changelog untouched). While you iterate: `--changed`.
- Picture: `orca plugin shot . --panel <id> --theme light|dark --out docs/screenshots/<branch-slug>/<name>.png`. No panel yet: a Mermaid diagram.
- Types for the editor: `orca plugin types .` writes `.orca/types/` (git-ignored).

## Layout
- `src/cli/`: the only code that runs the Orca CLI. `commands.ts` is the allow-list (R3), `resolve.ts` finds the CLI (R1), `env.ts` builds its env (R2), `run.ts` runs it. Only `src/cli/index.ts` imports `node:child_process`; a test enforces it.
- `src/model/`: typed models and lenient parsers. Start at `src/model/index.ts`.
- `src/views/<view>/`: one folder per view (slices 2-4).
- `test/fixtures/cli/`: recorded `--json` of the 12 commands, names swapped. `test/fixtures/cases/`: hand-made cases. `test/fixtures/env/`: worker env per OS.

## Rules
- Read only. New CLI calls go through `cli.run({ command })`; never add a write command, `terminal.send`, or a free-text argument.
- CLI text (titles, questions, mail) is untrusted: escape it, cut it, never render HTML.
- Fixtures are public: invented names only, no real ids, e-mails, paths or secrets. The gate checks paths, e-mails and GitHub owners.

## PRs
- One slice per PR. Each PR adds `changelog.d/<YYYY-MM-DD>-pr<N>.md` after it has a number; never edit `CHANGELOG.md` on a branch.
- Bump `version` in `orca-plugin.json` only in the release slice.
- Visible change: a screenshot of each changed panel, light and dark. Not visible: a Mermaid diagram.

## Deploy
- Install: `orca plugin install itsmanelvelasco/orca-control-room` (pins the newest `vX.Y.Z` tag, else the default branch). Update: `orca plugin update`.
- A change to the manifest's access needs a new approval: say so in the PR.

## Do not
- Run a bare `orca`, or any path relative to Orca's cwd.
- Add dependencies, a build step, telemetry, or network calls.
- Answer permission or trust prompts for the user.
