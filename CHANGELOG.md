# Changelog — @usewren/cli

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
