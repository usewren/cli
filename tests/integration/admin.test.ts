import { beforeAll, describe, expect, it } from "bun:test";
import { writeConfig } from "../../config.ts";
import { wren } from "../harness.ts";
import { createUser, uid, WREN_URL, type TestUser } from "../helpers.ts";

let owner: TestUser;
let member: TestUser;

beforeAll(async () => {
  owner = await createUser("owner");
  member = await createUser("member");
});

/** A user signed in with a session cookie only (no API key yet). */
async function sessionUser(): Promise<{ email: string; cookie: string; run: (...args: string[]) => ReturnType<typeof wren> }> {
  const email = `session-${uid()}@cli-tests.example`;
  const headers = { "Content-Type": "application/json", Accept: "application/json", Origin: WREN_URL };
  const body = JSON.stringify({ email, password: "correct-horse-battery-staple", name: "Session" });
  await fetch(`${WREN_URL}/api/auth/sign-up/email`, { method: "POST", headers, body });
  const res = await fetch(`${WREN_URL}/api/auth/sign-in/email`, { method: "POST", headers, body });
  const cookie = decodeURIComponent(res.headers.get("set-cookie")?.split(";")[0] ?? "");
  return {
    email,
    cookie,
    run: (...args: string[]) => {
      writeConfig({ cookie });
      return wren(args, { WREN_API_KEY: undefined });
    },
  };
}

describe("keys", () => {
  it("list / create / revoke", async () => {
    const s = await sessionUser();
    expect((await s.run("keys", "list")).stdout).toContain("No API keys.");

    const created = await s.run("keys", "create", "ci deploy");
    expect(created.stdout).toContain(`Created API key "ci deploy"`);
    expect(created.stdout).toContain("Store this key now");
    const key = created.stdout.match(/Key: (wren_\S+)/)![1]!;
    const id = created.stdout.match(/\(([0-9a-f-]{36})\)/)![1]!;

    let list = (await s.run("keys", "list")).stdout;
    expect(list).toContain(`${id}  ${key.slice(0, 12)}…  "ci deploy"  active  never used`);

    await wren(["me"], { WREN_API_KEY: key }); // marks the key as used
    list = (await s.run("keys", "list")).stdout;
    expect(list).toContain("last used");

    expect((await s.run("keys", "revoke", id)).stdout).toContain(`Revoked key ${id}`);
    // The server leaves revoked keys out of the list
    expect((await s.run("keys", "list")).stdout).toContain("No API keys.");
    writeConfig({});
  });

  it("revoke of an unknown key exits 1", async () => {
    const r = await owner.run("keys", "revoke", "00000000-0000-0000-0000-000000000000");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error: Not found");
  });
});

describe("invites, members, org", () => {
  let inviteToken: string;

  it("invites list / send / revoke", async () => {
    const fresh = await createUser("fresh");
    expect((await fresh.run("invites", "list")).stdout).toContain("No invites.");

    const sent = await owner.run("invites", "send", member.email);
    expect(sent.stdout).toContain(`Invite created for ${member.email}`);
    expect(sent.stdout).toContain(`Invite link: ${WREN_URL}/admin#/invites/accept?token=`);
    inviteToken = sent.stdout.match(/token=(\S+)/)![1]!;

    const other = await owner.run("invites", "send", `other-${uid()}@cli-tests.example`, "--role", "admin");
    expect(other.code).toBe(0);
    const otherEmail = other.stdout.match(/Invite created for (\S+)/)![1]!;
    const { invites } = await owner.api("GET", "/invites");
    const otherId = invites.find((i: { email: string }) => i.email === otherEmail).id;
    expect((await owner.run("invites", "revoke", otherId)).stdout).toContain(`Revoked invite ${otherId}`);

    const list = (await owner.run("invites", "list")).stdout;
    expect(list).toMatch(new RegExp(`${member.email}  member  pending`));
    expect(list).toMatch(new RegExp(`${otherEmail}  admin  revoked`));
  });

  it("invites accept joins the org; received / accept-by-id need a verified email", async () => {
    expect((await member.run("invites", "received")).stdout).toContain("No received invites.");

    const r = await member.run("invites", "accept", inviteToken);
    expect(r.stdout).toContain(`Accepted invite. You are now a member of org ${owner.userId}.`);
    expect((await owner.run("invites", "list")).stdout).toMatch(new RegExp(`${member.email}  member  accepted`));

    const { id } = await owner.api("POST", "/invites", { email: member.email });
    const byId = await member.run("invites", "accept-by-id", id);
    expect(byId.code).toBe(1);
    expect(byId.stderr).toContain("Error:");
  });

  it("members list", async () => {
    const fresh = await createUser("lonely");
    expect((await fresh.run("members", "list")).stdout).toContain("No members.");
    const list = (await owner.run("members", "list")).stdout;
    expect(list).toContain(`${member.userId}  ${member.email}  "Test member"  member  joined`);
  });

  it("org current / switch / slug (session)", async () => {
    // The member's session can see both orgs
    writeConfig({ cookie: member.cookie });
    const run = (...args: string[]) => wren(args, { WREN_API_KEY: undefined });

    const current = (await run("org", "current")).stdout;
    expect(current).toContain("Active org: My workspace");
    expect(current).toContain("Available orgs:");
    expect(current).toContain(`→ ${member.userId}`);
    expect(current).toContain(`  ${owner.userId}`);

    expect((await run("org", "switch", owner.userId)).stdout).toContain(`Switched to org ${owner.userId}`);
    expect((await run("org", "current")).stdout).toContain(`→ ${owner.userId}`);
    expect((await run("org", "slug", "get")).stdout.trim()).toBe(owner.slug);
    await run("org", "switch", member.userId);

    const denied = await run("org", "switch", "not-my-org");
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("Not a member of that org");
    writeConfig({});
  });

  it("org slug set / get (API key)", async () => {
    const u = await createUser("slug");
    const slug = `cli-${uid()}`;
    expect((await u.run("org", "slug", "set", slug)).stdout).toContain(`Slug set: ${slug}`);
    expect((await u.run("org", "slug", "get")).stdout.trim()).toBe(slug);
    expect((await u.run("org", "current")).stdout).toContain("Active org:");
  });

  it("members remove", async () => {
    const r = await owner.run("members", "remove", member.userId);
    expect(r.stdout).toContain(`Removed member ${member.userId}`);
    expect((await owner.run("members", "remove", member.userId)).code).toBe(1);
  });
});

describe("permissions", () => {
  it("list / create / update / delete", async () => {
    const u = await createUser("perms");
    expect((await u.run("permissions", "list")).stdout).toContain("No permissions configured.");

    const col = `col-${uid()}`;
    const created = await u.run(
      "permissions", "create", "--principal", "*", "--resource", `collection:${col}`, "--access", "read",
      "--label-filter", "published", "--filter-lang", "jmespath", "--filter-expr", "title",
      "--audit-reads", "--audit-writes",
    );
    expect(created.stdout).toContain(`: * → collection:${col} [read]`);
    const id = created.stdout.match(/Permission (\S+) created/)![1]!;

    let list = (await u.run("permissions", "list")).stdout;
    expect(list).toContain(`${id}  *  collection:${col}  read label:published [jmespath: title] audit:reads+writes`);

    const updated = await u.run(
      "permissions", "update", id, "--access", "write", "--label-filter", "", "--filter-lang", "",
      "--filter-expr", "", "--audit-reads", "false", "--audit-writes", "true",
    );
    expect(updated.stdout).toContain(`Permission ${id} updated: * → collection:${col} [write]`);
    list = (await u.run("permissions", "list")).stdout;
    expect(list).toContain(`${id}  *  collection:${col}  write audit:writes`);

    expect((await u.run("permissions", "delete", id)).stdout).toContain(`Permission ${id} deleted`);
    expect((await u.run("permissions", "list")).stdout).toContain("No permissions configured.");
  });

  it("create with a minimal rule and update a single field", async () => {
    const u = await createUser("perms2");
    const created = await u.run("permissions", "create", "--principal", "*", "--resource", "tree:site", "--access", "read");
    const id = created.stdout.match(/Permission (\S+) created/)![1]!;
    expect((await u.run("permissions", "list")).stdout).toContain(`${id}  *  tree:site  read\n`);
    await u.run("permissions", "update", id, "--label-filter", "published");
    expect((await u.run("permissions", "list")).stdout).toContain("read label:published");
  });

  it("permissions update --no-label-filter clears the label filter", async () => {
    const u = await createUser("perms3");
    const created = await u.run("permissions", "create", "--principal", "*", "--resource", "tree:x", "--access", "read", "--label-filter", "published");
    const id = created.stdout.match(/Permission (\S+) created/)![1]!;
    const r = await u.run("permissions", "update", id, "--no-label-filter");
    expect(r.code).toBe(0);
    expect((await u.run("permissions", "list")).stdout).not.toContain("label:");
  });

  it("create with an invalid access exits 1", async () => {
    const r = await owner.run("permissions", "create", "--principal", "*", "--resource", "*", "--access", "everything");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error:");
  });
});

describe("llms", () => {
  it("prints an org's llms.txt, by default the current org's", async () => {
    const u = await createUser("llms");
    const own = await u.run("llms");
    expect(own.code).toBe(0);
    expect(own.stdout.length).toBeGreaterThan(0);
    const byOrg = await u.run("llms", "--org", u.slug);
    expect(byOrg.stdout).toBe(own.stdout);
  });

  it("exits 1 for an unknown org", async () => {
    const r = await owner.run("llms", "--org", `no-such-org-${uid()}`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error:");
  });
});

describe("webhooks", () => {
  it("list / create / update / deliveries / replay / delete", async () => {
    const u = await createUser("hooks");
    expect((await u.run("webhooks", "list")).stdout).toContain("No webhooks.");

    const created = await u.run("webhooks", "create", "http://localhost:9/hook", "--events", "document.created, label.set");
    expect(created.stdout).toContain("URL:    http://localhost:9/hook");
    expect(created.stdout).toContain("Events: document.created, label.set");
    expect(created.stdout).toContain("Store this secret now");
    const id = created.stdout.match(/Created webhook (\S+)/)![1]!;

    const all = await u.run("webhooks", "create", "http://localhost:9/all");
    expect(all.stdout).toContain("Events: all");
    const allId = all.stdout.match(/Created webhook (\S+)/)![1]!;

    let list = (await u.run("webhooks", "list")).stdout;
    expect(list).toContain(`${id}  http://localhost:9/hook  [document.created,label.set]  active`);
    expect(list).toContain(`${allId}  http://localhost:9/all  [all]  active`);

    expect((await u.run("webhooks", "update", id, "--disable")).stdout).toContain(`Updated webhook ${id}`);
    expect((await u.run("webhooks", "list")).stdout).toContain(`${id}  http://localhost:9/hook  [document.created,label.set]  DISABLED`);
    await u.run("webhooks", "update", id, "--enable", "--url", "http://localhost:9/v2", "--events", "label.set");
    expect((await u.run("webhooks", "list")).stdout).toContain(`${id}  http://localhost:9/v2  [label.set]  active`);

    expect((await u.run("webhooks", "deliveries", allId)).stdout).toContain("No deliveries yet.");

    expect((await u.run("webhooks", "replay", allId, "--since", "2100-01-01T00:00:00Z")).stdout).toContain("Replayed 0 events");
    await u.api("POST", `/hooked-${uid()}`, { title: "event" });
    // Events are recorded in the background, so retry until the replay finds one
    let replay = "";
    for (let i = 0; i < 40 && !/Replayed [1-9]/.test(replay); i++) {
      if (i) await Bun.sleep(250);
      replay = (await u.run("webhooks", "replay", allId, "--since", "2000-01-01T00:00:00Z", "--until", "2100-01-01T00:00:00Z")).stdout;
    }
    expect(replay).toMatch(/Replayed [1-9]\d* events \(batch: .+\)/);

    // The replay is delivered in the background; nothing listens on port 9, so it logs a failure
    let deliveries = "";
    for (let i = 0; i < 60 && !deliveries.includes("attempt"); i++) {
      await Bun.sleep(250);
      deliveries = (await u.run("webhooks", "deliveries", allId)).stdout;
    }
    expect(deliveries).toMatch(/batch:.+ \d+ events {2}attempt \d+ {2}ERR: /);

    expect((await u.run("webhooks", "delete", id)).stdout).toContain(`Deleted webhook ${id}`);
    expect((await u.run("webhooks", "delete", id)).code).toBe(1);
  }, 30_000);

  it("create with a private address exits 1", async () => {
    const r = await owner.run("webhooks", "create", "http://10.0.0.1/hook");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error:");
  });
});
