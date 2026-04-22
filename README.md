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
wren list <collection>              List documents (--filter, --limit, --label)
wren get <collection> <id>          Get a document
wren create <collection> <json>     Create a document
wren update <collection> <id> <json>  Update (creates new version)
wren delete <collection> <id>       Soft delete
wren upsert <col> <key> <json>      Create-or-update by natural key
```

### Versions & labels
```
wren versions <collection> <id>     List version history
wren rollback <collection> <id> <v> Roll back to version v
wren label <collection> <id> <name> Pin a label (--version <n>)
wren diff <collection> <id> --v1 N --v2 M
```

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
wren upload-version <col> <id> <file>  New version of existing asset
wren download <collection> <id>     Download raw binary (--out <path>)
```

### Auth & config
```
wren config --url <url>             Set server URL
wren auth login -e <email> -p <pw>  Sign in
wren auth logout                    Sign out
wren me                             Show principal, org, role, permissions
```

### Management
```
wren keys list|create|revoke        API key management
wren org current|switch             Org context
wren invites list|send|accept|revoke  Collaborator invites
```

## License

Apache-2.0
