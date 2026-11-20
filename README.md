# @usewren/cli

Command-line tool for [WREN](https://wren.aemwip.com) — deploy static sites, manage versioned JSON documents, and control trees.

## Install

Requires [Bun](https://bun.sh) (v1.0+).

```bash
bun install -g @usewren/cli
```

## Quick start

```bash
# Point at your WREN instance and sign in
wren config --url https://wren.aemwip.com
wren auth login -e you@example.com -p yourpassword

# Deploy a static site
wren deploy ./dist --tree mysite --public

# Preview changes before going live
wren deploy ./dist --tree mysite --label preview

# Promote to published
wren promote mysite --from preview
```

## Commands

### Deploy & promote
```
wren deploy [dir] --tree <name>     Deploy a directory as a static site
  --public                          Auto-create public read permission
  --label <name>                    Label all uploaded versions
  --collection <name>               Binary collection name (default: <tree>-assets)
  --clean                           Remove tree paths for deleted local files
  --dry-run                         Show what would happen without doing it

wren promote <tree>                 Label every document in a tree
  --label <name>                    Label to set (default: published)
  --from <label>                    Only promote docs carrying this label
```

### Documents
```
wren collections                    List all collections
wren list <collection>              List documents (--filter, --limit, --offset, --label)
wren get <collection> <id>          Get a document
wren create <collection> <json>     Create a document
wren update <collection> <id> <json>  Update (creates new version)
  --if-version <n>                  Only if still at version n (412 otherwise)
  --force                           New version even if the content is unchanged
wren delete <collection> <id>       Soft delete (--if-version <n>)
wren undelete <collection> <id>     Bring a deleted document back
wren upsert <col> <key> <json>      Create-or-update by natural key (--if-version, --force)
wren delete-by-key <col> <key>      Delete by natural key (--if-version <n>)
```

A write whose content equals the current version creates no version: the JSON result
carries `"unchanged": true` and the CLI says so on stderr. `--force` writes one anyway.

`--if-version <n>` makes a write conditional, so two writers can't silently overwrite
each other: it applies only while the document is at version n (a read's `version`).
`0` means "only if it doesn't exist yet" (create-only, for `upsert` and `upload --key`),
`'*'` means "only if it exists". On a mismatch nothing is written and the CLI exits 1:

```
Error: Version mismatch: the document is at version 3 (currentVersion: 3). Nothing was written.
```

### Versions & labels
```
wren versions <collection> <id>     List version history
wren rollback <collection> <id> <v> Roll back to version v
wren label <collection> <id> <name> Pin a label (--version <n>)
wren label remove <col> <id> <name> Remove a label
wren diff <collection> <id> --v1 A --v2 B  Diff two versions (numbers or labels)
  --deep                            Report changes inside nested objects and arrays
wren restore <collection> --label <name>   Put every document back to the labeled version
  --delete-unlabeled                Also delete documents without the label
  --json                            Print the raw result
wren restore --tree <name> --label <name>  Same for every document in a tree
```

`restore` runs in one transaction: changed documents get a new version with the labeled
content, deleted ones come back, and it prints how many were restored, undeleted,
deleted and unchanged. Restoring a tree needs write access to every collection in it.
`label remove` is a subcommand of `label`, so a collection literally named `remove`
can't be labeled through the CLI.

### Schema
```
wren schema get <collection>        Show the schema definition
wren schema set <col> [json]        Replace it (--display-name, --list-columns, --natural-key, --type)
wren schema patch <col> [json]      Change only the given fields; everything else stays
  --display-name, --list-columns, --natural-key, --type, --indexes <json>
  --no-display-name, --no-list-columns, --no-natural-key, --no-indexes, --no-schema   clear one
wren schema validate <col> [json]   Dry-run the current or a proposed schema
wren schema delete <collection>     Remove the schema
```

Prefer `patch` in scripts: `set` replaces the whole definition and drops a natural key
or index someone added since.

### Trees
```
wren tree list                      List all trees
wren tree view <name>               Print full tree with documents
wren tree get <name> <path>         Get node + children
wren tree set <name> <path> [docId] Assign document to path
wren tree remove <name> <path>      Unassign
```

### Binary assets
```
wren upload <collection> <file>     Upload a binary asset
  --key [name]                      Create or replace the file of that name (default: the file's)
  --if-version <n>                  With --key: only if still at version n (0 = create-only)
wren upload-version <col> <id> <file>  New version of existing asset (--if-version <n>)
wren download <collection> <id>     Download raw binary (--out <path>, --version <n>)
  --key                             <id> is a file name
```

Files by name need a collection with `naturalKey: "filename"`:
`wren schema patch files --type binary --natural-key filename`, then
`wren upload files ./logo.svg --key` and `wren download files logo.svg --key`.

Uploading a file whose bytes, name and type equal the current version creates no new version: the server answers with `"unchanged": true`, and identical bytes are stored once.

### Retention
```
wren retention get                  Org default, collection policies, recent runs
wren retention set <col|'*'> …      --labeled-only --max-versions n --max-age-days n --after-label name, or --keep-all
wren retention preview <col|'*'>    What the saved policy (or the flags) would remove; changes nothing
wren retention remove <col|'*'>     Remove a policy ('*' = the org default)
wren retention apply [--yes]        Remove now (also runs hourly); asks first
```

A version is removed if any rule says so; a document's current version and every labeled version are always kept. Quote `'*'` so the shell doesn't expand it.

### Auth & config
```
wren config --url <url>             Set server URL (or WREN_URL)
wren auth login -e <email> -p <pw>  Sign in with a session cookie
wren auth key <wren_…>              Use an API key instead (or WREN_API_KEY); no arg = read from stdin
wren auth key --clear               Forget the stored API key
wren auth logout                    Sign out and forget the stored key
wren me                             Show principal, org, role, permissions
```

Use an API key for scripts and CI: sessions expire, keys don't. `WREN_API_KEY` beats a stored key, which beats the session cookie. The config file (`~/.wren/config.json`) is created readable only by you.

```bash
WREN_URL=https://wren.aemwip.com WREN_API_KEY=wren_… wren deploy ./dist --tree mysite --label preview
```

### Management
```
wren keys list|create|revoke        API key management
wren org current|switch             Org context
wren invites list|send|accept|revoke  Collaborator invites
```

## Running the tests

`tests/unit` covers the config file; `tests/integration` runs every command against a
real WREN server. The commands run in-process (see `tests/harness.ts`) so coverage
includes `index.ts`, and `tests/setup.ts` gives them a throwaway home directory, so your
own `~/.wren/config.json` is never touched. With Docker and the WREN sources checked out
next to this repo (`../sandbox`, `../db`, `../auth` …), one command builds the server
image, starts Postgres and the server on a private network, runs `bun test --coverage`
and cleans up:

```bash
sh tests/run-local.sh                    # all tests
sh tests/run-local.sh tests/integration/deploy.test.ts
```

Against a server you already run: `WREN_URL=http://localhost:4000 bun test --coverage`.
Use a disposable server only — the tests create users, keys, invites and webhooks.

## License

Apache-2.0
