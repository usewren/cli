import { beforeAll, describe, it, expect } from "bun:test";
import { $ } from "bun";
import { join } from "path";
import { readConfig, writeConfig } from "../../config.ts";
import { wren as run } from "../harness.ts";
import { createUser, json, WREN_URL, type TestUser } from "../helpers.ts";

const CLI_DIR = join(import.meta.dir, "..", "..");

// Spawns the real CLI (bun ./index.ts) — used where in-process runs can't go:
// help/version output and reading an API key from stdin.
async function wrenProcess(args: string[], stdin?: string) {
  const env = { ...process.env, WREN_URL };
  const cmd = stdin === undefined
    ? $`bun ./index.ts ${args}`
    : $`bun ./index.ts ${args} < ${new Response(stdin)}`;
  const result = await cmd.cwd(CLI_DIR).env(env).nothrow().quiet();
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** Run without WREN_API_KEY so the stored config decides how the CLI authenticates. */
function wrenStored(...args: string[]) {
  return run(args, { WREN_API_KEY: undefined });
}

describe("wren cli", () => {
  it("shows help", async () => {
    const { stdout } = await wrenProcess(["--help"]);
    expect(stdout).toContain("Usage: wren");
    expect(stdout).toContain("auth");
    expect(stdout).toContain("list");
    expect(stdout).toContain("create");
    expect(stdout).toContain("deploy");
  });

  it("shows auth subcommand help", async () => {
    const { stdout } = await wrenProcess(["auth", "--help"]);
    expect(stdout).toContain("login");
    expect(stdout).toContain("logout");
    expect(stdout).toContain("whoami");
    expect(stdout).toContain("key");
  });

  it("shows version", async () => {
    const { stdout } = await wrenProcess(["--version"]);
    expect(stdout.trim()).toBe("0.9.0");
  });

  it("help and version also work in-process", async () => {
    expect((await run(["--version"])).stdout.trim()).toBe("0.9.0");
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: wren");
  });

  it("fails on an unknown command and on a missing required option", async () => {
    expect((await run(["no-such-command"])).code).toBe(1);
    const r = await run(["deploy", "."]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--tree");
  });
});

describe("config", () => {
  it("config --url stores the server URL", async () => {
    const before = readConfig();
    const r = await run(["config", "--url", "http://example.invalid:1234"]);
    expect(r.stdout).toContain("URL set to http://example.invalid:1234");
    expect(readConfig().url).toBe("http://example.invalid:1234");
    writeConfig(before);
  });

  it("the stored URL is used when WREN_URL is not set (trailing slash stripped)", async () => {
    const before = readConfig();
    writeConfig({ ...before, url: `${WREN_URL}/` });
    const r = await run(["me"], { WREN_URL: undefined, WREN_API_KEY: undefined });
    // Reached the stored server: unauthenticated, but not a connection error
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unauthorized");
    writeConfig(before);
  });
});

describe("auth", () => {
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    alice = await createUser("alice");
    bob = await createUser("bob");
    writeConfig({});
  });

  it("login stores a session cookie; whoami and me use it", async () => {
    const login = await wrenStored("auth", "login", "--email", alice.email, "--password", alice.password);
    expect(login.code).toBe(0);
    expect(login.stdout).toContain(`Signed in as ${alice.email}`);
    expect(readConfig().cookie).toContain("session_token=");

    const whoami = json(await wrenStored("auth", "whoami"));
    expect(whoami.user.email).toBe(alice.email);
    expect(whoami.authMethod).toBe("session");

    const me = json(await wrenStored("me"));
    expect(me.org.slug).toBe(alice.slug);
  });

  it("login with a wrong password exits 1", async () => {
    const r = await wrenStored("auth", "login", "-e", alice.email, "-p", "wrong-password");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error:");
  });

  it("auth key validates and stores a key, which beats the cookie", async () => {
    const r = await wrenStored("auth", "key", bob.apiKey);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`(${bob.slug})`);
    expect(readConfig().apiKey).toBe(bob.apiKey);
    const me = json(await wrenStored("me"));
    expect(me.authMethod).toBe("api_key");
    expect(me.user.email).toBe(bob.email);
  });

  it("WREN_API_KEY beats the stored key", async () => {
    const me = json(await alice.run("me"));
    expect(me.user.email).toBe(alice.email);
    expect(me.authMethod).toBe("api_key");
  });

  it("auth key rejects values that aren't keys and keys the server rejects", async () => {
    const notKey = await wrenStored("auth", "key", "hunter2");
    expect(notKey.code).toBe(1);
    expect(notKey.stderr).toContain("API keys start with wren_");

    const bogus = await wrenStored("auth", "key", "wren_0000000000000000");
    expect(bogus.code).toBe(1);
    expect(bogus.stderr).toContain("key rejected");
    expect(readConfig().apiKey).toBe(bob.apiKey); // unchanged
  });

  it("auth key --clear forgets the key and falls back to the cookie", async () => {
    const r = await wrenStored("auth", "key", "--clear");
    expect(r.stdout).toContain("API key removed");
    expect(readConfig().apiKey).toBeUndefined();
    expect(json(await wrenStored("me")).user.email).toBe(alice.email);
  });

  it("auth key reads the key from stdin", async () => {
    const r = await wrenProcess(["auth", "key"], `${bob.apiKey}\n`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("API key stored");
    expect(readConfig().apiKey).toBe(bob.apiKey);
  });

  it("logout signs out and forgets the cookie and the key", async () => {
    const r = await wrenStored("auth", "logout");
    expect(r.stdout).toContain("Signed out");
    const cfg = readConfig();
    expect(cfg.cookie).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
    const me = await wrenStored("me");
    expect(me.code).toBe(1);
    expect(me.stderr).toContain("Unauthorized");
  });

  it("logout without a session just clears local state", async () => {
    writeConfig({ apiKey: bob.apiKey });
    expect((await wrenStored("auth", "logout")).stdout).toContain("Signed out");
    expect(readConfig()).toEqual({});
  });
});
