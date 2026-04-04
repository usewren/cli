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
  .description("Set a label on the current version")
  .action(async (collection, id, label) => {
    const { body } = await api(`/${collection}/${id}/labels`, {
      method: "POST",
      body: JSON.stringify({ label }),
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

program.parse();
