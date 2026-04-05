#!/usr/bin/env bun
import { program } from "commander";
import { readConfig, writeConfig, type Config } from "./config";

const BASE_URL = () => readConfig().url ?? "http://localhost:4000";

async function api(path: string, options: RequestInit = {}) {
  const config = readConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Origin": BASE_URL(),
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (config.cookie) headers["Cookie"] = config.cookie;

  const res = await fetch(`${BASE_URL()}${path}`, { ...options, headers });
  const body = await res.json();

  if (!res.ok) {
    console.error(`Error: ${body.message ?? body.error ?? res.statusText}`);
    process.exit(1);
  }
  return { body, res };
}

// For multipart uploads — does NOT set Content-Type (let the browser set boundary)
async function apiMultipart(path: string, formData: FormData, method = "POST") {
  const config = readConfig();
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Origin": BASE_URL(),
  };
  if (config.cookie) headers["Cookie"] = config.cookie;

  const res = await fetch(`${BASE_URL()}${path}`, { method, headers, body: formData });
  const body = await res.json();

  if (!res.ok) {
    console.error(`Error: ${(body as { error?: string; message?: string }).message ?? (body as { error?: string }).error ?? res.statusText}`);
    process.exit(1);
  }
  return { body, res };
}

function print(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

program
  .name("wren")
  .description("CLI for the Wren versioned JSON storage service")
  .version("0.1.0");

// --- Config ---
program
  .command("config")
  .description("Set the Wren server URL")
  .requiredOption("--url <url>", "Server URL")
  .action((opts) => {
    writeConfig({ ...readConfig(), url: opts.url });
    console.log(`URL set to ${opts.url}`);
  });

// --- Auth ---
const auth = program.command("auth").description("Authentication");

auth
  .command("login")
  .description("Sign in with email and password")
  .requiredOption("-e, --email <email>")
  .requiredOption("-p, --password <password>")
  .action(async (opts) => {
    const { body, res } = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: opts.email, password: opts.password }),
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    const cookie = decodeURIComponent(setCookie.split(";")[0]); // e.g. better-auth.session_token=xxx.yyy
    writeConfig({ ...readConfig(), cookie });
    console.log(`Signed in as ${body.user.email}`);
  });

auth
  .command("logout")
  .description("Sign out")
  .action(async () => {
    await api("/api/auth/sign-out", { method: "POST" });
    const config = readConfig();
    delete config.cookie;
    writeConfig(config);
    console.log("Signed out");
  });

auth
  .command("whoami")
  .description("Show current session")
  .action(async () => {
    const { body } = await api("/api/auth/get-session");
    print(body.user);
  });

// --- Collections ---
program
  .command("collections")
  .description("List all collections")
  .action(async () => {
    const { body } = await api("/collections");
    print(body);
  });

// --- Documents ---
program
  .command("list <collection>")
  .description("List documents in a collection")
  .option("--filter <filter>", "Filter expression")
  .option("--limit <n>", "Page size", "20")
  .option("--cursor <cursor>", "Pagination cursor")
  .option("--label <label>", "Return state at this label")
  .action(async (collection, opts) => {
    const params = new URLSearchParams();
    if (opts.filter) params.set("filter", opts.filter);
    if (opts.limit) params.set("limit", opts.limit);
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.label) params.set("label", opts.label);
    const { body } = await api(`/${collection}?${params}`);
    print(body);
  });

program
  .command("get <collection> <id>")
  .description("Get a document")
  .option("--label <label>", "Return state at this label")
  .action(async (collection, id, opts) => {
    const params = opts.label ? `?label=${opts.label}` : "";
    const { body } = await api(`/${collection}/${id}${params}`);
    print(body);
  });

program
  .command("create <collection> <json>")
  .description("Create a document")
  .action(async (collection, json) => {
    const { body } = await api(`/${collection}`, {
      method: "POST",
      body: json,
    });
    print(body);
  });

program
  .command("update <collection> <id> <json>")
  .description("Update a document (creates a new version)")
  .action(async (collection, id, json) => {
    const { body } = await api(`/${collection}/${id}`, {
      method: "PUT",
      body: json,
    });
    print(body);
  });

program
  .command("delete <collection> <id>")
  .description("Delete a document")
  .action(async (collection, id) => {
    const { body } = await api(`/${collection}/${id}`, { method: "DELETE" });
    print(body);
  });

// --- Versions ---
program
  .command("paths <collection> <id>")
  .description("List all tree paths a document is assigned to")
  .action(async (collection, id) => {
    const { body } = await api(`/${collection}/${id}/paths`);
    print(body);
  });

program
  .command("versions <collection> <id>")
  .description("List version history of a document")
  .action(async (collection, id) => {
    const { body } = await api(`/${collection}/${id}/versions`);
    print(body);
  });

program
  .command("rollback <collection> <id> <version>")
  .description("Rollback a document to a previous version")
  .action(async (collection, id, version) => {
    const { body } = await api(`/${collection}/${id}/rollback/${version}`, { method: "POST" });
    print(body);
  });

program
  .command("label <collection> <id> <label>")
  .description("Set a label on the current version (or a specific version with --version)")
  .option("-v, --version <n>", "Version number to label", parseInt)
  .action(async (collection, id, label, opts) => {
    const payload: Record<string, unknown> = { label };
    if (opts.version !== undefined) payload.version = opts.version;
    const { body } = await api(`/${collection}/${id}/labels`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    print(body);
  });

program
  .command("diff <collection> <id>")
  .description("Diff between two versions or labels")
  .requiredOption("--v1 <v1>", "First version or label")
  .requiredOption("--v2 <v2>", "Second version or label")
  .action(async (collection, id, opts) => {
    const { body } = await api(`/${collection}/${id}/diff?v1=${opts.v1}&v2=${opts.v2}`);
    print(body);
  });

// --- Schema ---
const schema = program.command("schema").description("Collection JSON Schema management");

schema
  .command("get <collection>")
  .description("Get the JSON Schema for a collection")
  .action(async (collection) => {
    const { body } = await api(`/${collection}/_schema`);
    print(body);
  });

schema
  .command("set <collection> [json]")
  .description("Set (or replace) the JSON Schema for a collection")
  .option("--display-name <template>", "Display name template, e.g. \"{title}\" or \"{first} {last}\"")
  .option("--type <type>", "Collection type: json (default) or binary")
  .action(async (collection, json, opts) => {
    const collectionType: string | undefined = opts.type;
    let parsed: unknown = undefined;

    if (json) {
      try { parsed = JSON.parse(json); } catch { console.error("Error: invalid JSON"); process.exit(1); }
    }

    const payload: Record<string, unknown> = {};
    if (parsed !== undefined) payload.schema = parsed;
    if (opts.displayName) payload.displayName = opts.displayName;
    if (collectionType) payload.collectionType = collectionType;

    const { body } = await api(`/${collection}/_schema`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    print(body);
  });

schema
  .command("delete <collection>")
  .description("Remove the JSON Schema from a collection")
  .action(async (collection) => {
    const { body } = await api(`/${collection}/_schema`, { method: "DELETE" });
    print(body);
  });

// --- Tree ---
const tree = program.command("tree").description("Tree path management");

tree
  .command("list")
  .description("List all trees for this tenant")
  .action(async () => {
    const { body } = await api("/tree");
    print(body);
  });

tree
  .command("get <treeName> <path>")
  .description("Get document at path and list children in a named tree")
  .action(async (treeName, path) => {
    const p = path.startsWith("/") ? path : "/" + path;
    const { body } = await api(`/tree/${treeName}${p}`);
    print(body);
  });

tree
  .command("set <treeName> <path> <documentId>")
  .description("Assign a document to a tree path")
  .action(async (treeName, path, documentId) => {
    const p = path.startsWith("/") ? path : "/" + path;
    const { body } = await api(`/tree/${treeName}${p}`, {
      method: "PUT",
      body: JSON.stringify({ documentId }),
    });
    print(body);
  });

tree
  .command("remove <treeName> <path>")
  .description("Remove a document from a tree path")
  .action(async (treeName, path) => {
    const p = path.startsWith("/") ? path : "/" + path;
    const { body } = await api(`/tree/${treeName}${p}`, {
      method: "DELETE",
    });
    print(body);
  });

tree
  .command("view <treeName>")
  .description("Print the full tree with all paths and document summaries")
  .action(async (treeName) => {
    const { body } = await api(`/tree/${treeName}?full=true`);
    const nodes = (body as { tree: string; nodes: { path: string; documentId: string; document: { collection: string; version: number; data: Record<string, unknown> } }[] }).nodes;
    if (nodes.length === 0) {
      console.log(`Tree "${treeName}" is empty.`);
      return;
    }
    for (const node of nodes) {
      const firstKey = Object.keys(node.document.data)[0];
      const preview = firstKey ? `${firstKey}: ${JSON.stringify(node.document.data[firstKey])}` : "(empty)";
      console.log(`  ${node.path}  [${node.document.collection} v${node.document.version}]  ${preview}`);
    }
  });

// --- Binary assets ---
program
  .command("upload <collection> <file>")
  .description("Upload a binary asset to a collection (creates a new document)")
  .action(async (collection, filePath) => {
    const fileHandle = Bun.file(filePath);
    const exists = await fileHandle.exists();
    if (!exists) { console.error(`Error: file not found: ${filePath}`); process.exit(1); }
    const blob = await fileHandle.arrayBuffer();
    const filename = filePath.split("/").pop()!;
    const form = new FormData();
    form.append("file", new File([blob], filename, { type: fileHandle.type || "application/octet-stream" }));
    const { body } = await apiMultipart(`/${collection}`, form, "POST");
    print(body);
  });

program
  .command("upload-version <collection> <id> <file>")
  .description("Upload a new version of an existing binary asset")
  .action(async (collection, id, filePath) => {
    const fileHandle = Bun.file(filePath);
    const exists = await fileHandle.exists();
    if (!exists) { console.error(`Error: file not found: ${filePath}`); process.exit(1); }
    const blob = await fileHandle.arrayBuffer();
    const filename = filePath.split("/").pop()!;
    const form = new FormData();
    form.append("file", new File([blob], filename, { type: fileHandle.type || "application/octet-stream" }));
    const { body } = await apiMultipart(`/${collection}/${id}`, form, "PUT");
    print(body);
  });

program
  .command("download <collection> <id>")
  .description("Download the raw binary for an asset document")
  .option("--version <n>", "Download a specific version")
  .option("--out <path>", "Write to file instead of stdout")
  .action(async (collection, id, opts) => {
    const config = readConfig();
    const headers: Record<string, string> = { "Origin": BASE_URL() };
    if (config.cookie) headers["Cookie"] = config.cookie;
    const qs = opts.version ? `?version=${opts.version}` : "";
    const res = await fetch(`${BASE_URL()}/${collection}/${id}/raw${qs}`, { headers });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      console.error(`Error: ${body.error ?? res.statusText}`);
      process.exit(1);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (opts.out) {
      await Bun.write(opts.out, buffer);
      console.log(`Saved to ${opts.out}`);
    } else {
      process.stdout.write(buffer);
    }
  });

// --- API Keys ---
const keys = program.command("keys").description("API key management");

keys
  .command("list")
  .description("List all API keys for your account")
  .action(async () => {
    const { body } = await api("/api/keys");
    const { keys: list } = body as { keys: { id: string; name: string; keyPrefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }[] };
    if (list.length === 0) { console.log("No API keys."); return; }
    for (const k of list) {
      const status = k.revokedAt ? "revoked" : "active";
      const used = k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : "never used";
      console.log(`  ${k.id}  ${k.keyPrefix}…  "${k.name}"  ${status}  ${used}`);
    }
  });

keys
  .command("create <name>")
  .description("Create a new API key (the full key is shown once)")
  .action(async (name) => {
    const { body } = await api("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    const k = body as { id: string; name: string; key: string; keyPrefix: string; createdAt: string };
    console.log(`Created API key "${k.name}" (${k.id})`);
    console.log(`\n  Key: ${k.key}\n`);
    console.log("Store this key now — it will not be shown again.");
  });

keys
  .command("revoke <id>")
  .description("Revoke an API key by ID")
  .action(async (id) => {
    const { body } = await api(`/api/keys/${id}`, { method: "DELETE" });
    console.log(`Revoked key ${(body as { id: string }).id}`);
  });

// --- Invites ---
const invites = program.command("invites").description("Collaborator invite management");

invites
  .command("list")
  .description("List invites sent from your org")
  .action(async () => {
    const { body } = await api("/api/invites");
    const { invites: list } = body as { invites: { id: string; email: string; role: string; createdAt: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null }[] };
    if (list.length === 0) { console.log("No invites."); return; }
    for (const i of list) {
      const status = i.revokedAt ? "revoked" : i.acceptedAt ? "accepted" : new Date(i.expiresAt) < new Date() ? "expired" : "pending";
      console.log(`  ${i.id}  ${i.email}  ${i.role}  ${status}`);
    }
  });

invites
  .command("send <email>")
  .description("Send an invite to a collaborator (prints the invite link)")
  .option("-r, --role <role>", "Role to assign (member)", "member")
  .action(async (email, opts) => {
    const { body } = await api("/api/invites", {
      method: "POST",
      body: JSON.stringify({ email, role: opts.role }),
    });
    const i = body as { id: string; email: string; token: string; expiresAt: string };
    console.log(`Invite created for ${i.email} (expires ${new Date(i.expiresAt).toLocaleDateString()})`);
    const base = BASE_URL();
    console.log(`\n  Invite link: ${base}/admin#/invites/accept?token=${i.token}\n`);
    console.log("Share this link — the token is not stored in plaintext.");
  });

invites
  .command("revoke <id>")
  .description("Revoke a pending invite by ID")
  .action(async (id) => {
    const { body } = await api(`/api/invites/${id}`, { method: "DELETE" });
    console.log(`Revoked invite ${(body as { id: string }).id}`);
  });

invites
  .command("accept <token>")
  .description("Accept an invite using the raw token")
  .action(async (token) => {
    const { body } = await api("/api/invites/accept", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    console.log(`Accepted invite. You are now a member of org ${(body as { orgId: string }).orgId}.`);
  });

// --- Members ---
const members = program.command("members").description("Org member management");

members
  .command("list")
  .description("List members of your org")
  .action(async () => {
    const { body } = await api("/api/members");
    const { members: list } = body as { members: { userId: string; name: string; email: string; role: string; joinedAt: string }[] };
    if (list.length === 0) { console.log("No members."); return; }
    for (const m of list) {
      console.log(`  ${m.userId}  ${m.email}  "${m.name}"  ${m.role}  joined ${new Date(m.joinedAt).toLocaleDateString()}`);
    }
  });

members
  .command("remove <userId>")
  .description("Remove a member from your org")
  .action(async (userId) => {
    const { body } = await api(`/api/members/${userId}`, { method: "DELETE" });
    console.log(`Removed member ${(body as { userId: string }).userId}`);
  });

program.parse();
