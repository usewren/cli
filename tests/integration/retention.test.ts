import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { $ } from "bun";
import { join } from "path";
import { createUser, json, WREN_URL, type TestUser } from "../helpers.ts";

let owner: TestUser;
const realPrompt = globalThis.prompt;

/** A document with versions 1..n; labels map label → version. */
async function docWithVersions(user: TestUser, collection: string, n: number, labels: Record<string, number> = {}) {
  const doc = await user.api("POST", `/${collection}`, { title: "v1" });
  for (let v = 2; v <= n; v++) await user.api("PUT", `/${collection}/${doc.id}`, { title: `v${v}` });
  for (const [label, version] of Object.entries(labels)) await user.api("POST", `/${collection}/${doc.id}/labels`, { label, version });
  return doc as { id: string };
}

beforeAll(async () => {
  owner = await createUser("retention");
});
afterEach(() => { globalThis.prompt = realPrompt; });

describe("retention", () => {
  it("get: nothing set yet", async () => {
    const r = await owner.run("retention", "get");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe([
      "Org default: none (every version is kept)",
      "Collections: none with a policy of their own",
      "Current versions and labeled versions are always kept.",
      "",
    ].join("\n"));
  });

  it("set: needs a rule; flags are checked before anything is sent", async () => {
    const none = await owner.run("retention", "set", "notes");
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("give at least one rule, or --keep-all");
    const both = await owner.run("retention", "set", "notes", "--keep-all", "--max-versions", "3");
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("--keep-all can't be combined with a rule");
    for (const [flag, value] of [["--max-versions", "abc"], ["--max-versions", "1.5"], ["--max-age-days", "0"]]) {
      const bad = await owner.run("retention", "set", "notes", flag!, value!);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain(`${flag} must be a whole number of at least 1`);
    }
    const internal = await owner.run("retention", "set", "_events", "--max-versions", "3");
    expect(internal.code).toBe(1);
    expect(internal.stderr).toContain("Use * for the org default, or a collection name");
    expect((await owner.api("GET", "/retention")).collections).toEqual([]);
  });

  it("set, get, preview, apply, remove", async () => {
    const a = await docWithVersions(owner, "notes", 4, { approved: 1 });
    await docWithVersions(owner, "notes", 4);
    await docWithVersions(owner, "posts", 3);
    await docWithVersions(owner, "pages", 3);

    const set = await owner.run("retention", "set", "notes", "--max-versions", "2");
    expect(set.stdout).toBe("Policy for notes: keep the newest 2 versions\nCurrent versions and labeled versions are always kept. Preview with: wren retention preview notes\n");
    const def = await owner.run("retention", "set", "*", "--labeled-only", "--max-age-days", "30", "--after-label", " live ");
    expect(def.stdout).toContain(`Policy for the org default: keep only labeled versions; remove versions older than 30 days; remove versions older than the version labeled "live"`);
    expect(def.stdout).toContain("Preview with: wren retention preview '*'");
    expect((await owner.run("retention", "set", "archive", "--keep-all")).stdout).toContain("Policy for archive: keep everything (exempt)");
    expect((await owner.api("GET", "/retention")).default).toMatchObject({ collection: "*", labeledOnly: true, maxAgeDays: 30, afterLabel: "live", maxVersions: null });

    const got = await owner.run("retention", "get");
    expect(got.stdout).toContain(`Org default: keep only labeled versions; remove versions older than 30 days; remove versions older than the version labeled "live"`);
    expect(got.stdout).toContain("Collections:\n  archive  keep everything (exempt)\n  notes    keep the newest 2 versions\n");
    expect(got.stdout).not.toContain("Recent runs");
    const raw = json(await owner.run("retention", "get", "--json"));
    expect(raw.collections.map((c: { collection: string }) => c.collection)).toEqual(["archive", "notes"]);

    // Saved policy: notes a loses v2 (v1 is labeled), notes b loses v1 and v2
    const saved = await owner.run("retention", "preview", "notes");
    expect(saved.stdout).toBe("Would remove 3 versions in 2 documents, freeing <0.01 MB.\nNothing has been changed.\n");
    expect((await owner.run("retention", "preview", "notes", "--max-versions", "10")).stdout).toBe("Nothing would be removed.\nNothing has been changed.\n");
    // The default covers posts and pages (notes and archive have their own policy)
    const all = await owner.run("retention", "preview", "*");
    expect(all.stdout).toContain("Would remove 4 versions in 2 documents, freeing <0.01 MB.\n");
    expect(all.stdout).toMatch(/\n {2}pages {2}2 versions in 1 document, <0\.01 MB\n {2}posts {2}2 versions in 1 document, <0\.01 MB\n/);
    expect((await owner.api("GET", `/notes/${a.id}/versions/2`)).status).toBe(200);

    // apply asks first; anything but y/yes cancels
    for (const answer of ["n", "", null]) {
      globalThis.prompt = () => answer;
      const r = await owner.run("retention", "apply");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Cancelled (use --yes to skip this question).");
    }
    expect((await owner.api("GET", `/notes/${a.id}/versions/2`)).status).toBe(200);
    let asked = "";
    globalThis.prompt = (q?: string) => { asked = q ?? ""; return " YES "; };
    const applied = await owner.run("retention", "apply");
    expect(asked).toContain("This can't be undone. [y/N]");
    expect(applied.stdout).toMatch(/^Removed 7 versions in 4 documents, freeing <0\.01 MB\.\n/);
    expect(applied.stdout).toMatch(/ {2}notes {2}3 versions in 2 documents/);
    expect((await owner.api("GET", `/notes/${a.id}/versions/2`)).status).toBe(404);
    expect((await owner.api("GET", `/notes/${a.id}/versions/1`)).status).toBe(200);
    expect((await owner.api("GET", `/notes/${a.id}/versions/4`)).status).toBe(200);

    globalThis.prompt = () => { throw new Error("--yes must not ask"); };
    expect((await owner.run("retention", "apply", "--yes")).stdout).toBe("Nothing to remove.\n");

    const runs = (await owner.run("retention", "get")).stdout;
    expect(runs).toMatch(/Recent runs:\n {2}\d{4}-\d\d-\d\d \d\d:\d\d {2}\w+ {2}2 versions removed, <0\.01 MB freed {2}\(you\)\n/);
    expect(runs).toContain("  notes  3 versions removed, <0.01 MB freed  (you)");

    expect((await owner.run("retention", "remove", "notes")).stdout).toBe("Removed the retention policy for notes\n");
    expect((await owner.run("retention", "remove", "*")).stdout).toBe("Removed the retention policy for the org default\n");
    const again = await owner.run("retention", "remove", "notes");
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("Error: No policy for that collection");
    expect((await owner.api("GET", "/retention")).collections.map((c: { collection: string }) => c.collection)).toEqual(["archive"]);
  });

  it("apply really reads the answer from stdin", async () => {
    const result = await $`bun ./index.ts retention apply < ${new Response("n\n")}`
      .cwd(join(import.meta.dir, "..", "..")).env({ ...process.env, WREN_URL, WREN_API_KEY: owner.apiKey }).nothrow().quiet();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Cancelled");
  });
});
