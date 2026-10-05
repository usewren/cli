# Changelog — @usewren/cli

## 0.9.0 — Unreleased

### Added
- `wren retention get|set|preview|remove|apply` manages version retention policies (org owners and admins): `set <collection|'*'>` with `--labeled-only`, `--max-versions <n>`, `--max-age-days <n>`, `--after-label <name>` or `--keep-all` (exempts a collection from the org default); `preview` shows what the saved policy, or the one given by the flags, would remove without changing anything; `apply` removes it now and asks first unless `--yes`. Sizes are shown in MB. Current and labeled versions are always kept. Needs a server with retention support.
- `wren list --offset <n>` pages through results together with `--limit`.
- `wren permissions update --no-label-filter` clears a rule's label filter (the help already promised it).

### Changed
- Version is now 0.9.0 (`wren --version`, package.json), matching the server release whose features (such as retention) it calls; it said 0.5.0.
- `wren list --cursor` is gone: the list endpoint never supported cursors and ignored it. Use `--offset`.
- Program options such as `--version` now have to come before the subcommand (`wren --version`).

### Fixed
- `wren label … --version <n>` and `wren download … --version <n>` printed the CLI version and exited 0. They now label/download that version.
- `wren list --filter` was ignored by the server. It is now sent as `where`, so it filters (e.g. `--filter kind:odd`).
- `wren diff --v1/--v2` with a label failed with a 400. Labels are now resolved to their version first.
- A non-JSON response (an HTML error page, a plain-text 500) crashed the CLI with a `SyntaxError`. It now exits 1 with the status and the start of the body.
- `wren deploy` and `wren promote` could exit 1 after a successful run when looking up the org for the public URL failed. That lookup is now best-effort.

## 0.5.0 — 2026-10-04

### Added
- **API-key auth:** `WREN_API_KEY`, or `wren auth key <wren_…>` (validated before storing; no argument reads stdin). Precedence: env key, stored key, session cookie. `WREN_URL` overrides the server URL. `~/.wren/config.json` is written with mode 600.
- `wren promote` uses the server's atomic `POST /api/v1/tree/{name}/_promote`, so a whole tree goes live in one transaction. It falls back to per-document labelling on older servers.

### Fixed
- `wren deploy` detects changes by SHA-256 instead of file size, so same-size edits are uploaded. Needs server 0.5.0 for stored hashes; against older servers, files are re-uploaded.
- `wren deploy --label preview --public` created the public rule with `labelFilter: "preview"`, which published the preview. It now uses `"published"`.
- `deploy` and `promote` no longer print public URLs with `?label=`, which public routes ignore.

## 0.4.2

Previous release.
