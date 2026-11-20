// Server 0.9/0.10 features: conditional writes (--if-version), unchanged writes and
// --force, undelete, label remove, deep diffs with server-resolved labels, restore
// to a label, files by name, and schema patch.
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { wren } from "../harness.ts";
import { createUser, json, uid, type TestUser } from "../helpers.ts";

let u: TestUser;

beforeAll(async () => {
  u = await createUser("v010");
});

describe("conditional and unchanged writes", () => {
  const col = `cond-${uid()}`;

  it("update --if-version writes only at that version; a stale one exits 1 with currentVersion", async () => {
    const id = json(await u.run("create", col, JSON.stringify({ n: 1 }))).id;
    expect(json(await u.run("update", col, id, JSON.stringify({ n: 2 }), "--if-version", "1")).version).toBe(2);

    const stale = await u.run("update", col, id, JSON.stringify({ n: 3 }), "--if-version", "1");
    expect(stale.code).toBe(1);
    expect(stale.stdout).toBe("");
    expect(stale.stderr).toContain("Error: Version mismatch: the document is at version 2 (currentVersion: 2). Nothing was written.");
    expect((await u.api("GET", `/${col}/${id}`)).data).toEqual({ n: 2 });
  });

  it("update reports an unchanged write; --force writes a version anyway", async () => {
    const id = json(await u.run("create", col, JSON.stringify({ a: 1, b: 2 }))).id;
    const same = await u.run("update", col, id, JSON.stringify({ b: 2, a: 1 }));
    expect(same.code).toBe(0);
    expect(json(same)).toMatchObject({ version: 1, unchanged: true });
    expect(same.stderr).toContain("unchanged: same content as version 1, no new version written (--force writes one anyway)");

    const forced = await u.run("update", col, id, JSON.stringify({ a: 1, b: 2 }), "--force");
    expect(json(forced).version).toBe(2);
    expect(json(forced).unchanged).toBeUndefined();
    expect(forced.stderr).toBe("");
  });

  it("--if-version must be a number, 0 or '*'", async () => {
    const r = await u.run("update", col, "00000000-0000-0000-0000-000000000000", "{}", "--if-version", "v2");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--if-version must be a version number");
  });

  it("delete --if-version refuses a stale version, then deletes", async () => {
    const id = json(await u.run("create", col, JSON.stringify({ n: 1 }))).id;
    await u.run("update", col, id, JSON.stringify({ n: 2 }));
    const stale = await u.run("delete", col, id, "--if-version", "1");
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("currentVersion: 2");
    expect(json(await u.run("delete", col, id, "--if-version", "2"))).toEqual({ id, deleted: true });
  });

  it("by key: upsert --if-version 0 is create-only, '*' only updates; --force; delete-by-key --if-version", async () => {
    const kc = `stock-${uid()}`;
    await u.run("schema", "set", kc, "--natural-key", "sku");
    const created = await u.run("upsert", kc, "a1", JSON.stringify({ sku: "a1", qty: 5 }), "--if-version", "0");
    expect(json(created).version).toBe(1);

    const again = await u.run("upsert", kc, "a1", JSON.stringify({ sku: "a1", qty: 0 }), "--if-version", "0");
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("the document is at version 1 (currentVersion: 1)");

    const missing = await u.run("upsert", kc, "b2", JSON.stringify({ sku: "b2" }), "--if-version", "*");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Version mismatch: the document doesn't exist (currentVersion: 0)");

    const same = await u.run("upsert", kc, "a1", JSON.stringify({ sku: "a1", qty: 5 }), "--if-version", "*");
    expect(json(same)).toMatchObject({ version: 1, unchanged: true });
    expect(same.stderr).toContain("unchanged");
    expect(json(await u.run("upsert", kc, "a1", JSON.stringify({ sku: "a1", qty: 5 }), "--force")).version).toBe(2);

    const bad = await u.run("upsert", kc, "a1", "{nope");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toStartWith("Error: invalid JSON");

    expect((await u.run("delete-by-key", kc, "a1", "--if-version", "1")).stderr).toContain("currentVersion: 2");
    expect(json(await u.run("delete-by-key", kc, "a1", "--if-version", "2")).deleted).toBe(true);
  });
});

describe("undelete", () => {
  const col = `undel-${uid()}`;

  it("brings a deleted document back; 404 when it isn't deleted", async () => {
    const id = json(await u.run("create", col, JSON.stringify({ n: 1 }))).id;
    await u.run("update", col, id, JSON.stringify({ n: 2 }));
    await u.run("delete", col, id);
    expect(json(await u.run("undelete", col, id))).toEqual({ id, undeleted: true, version: 2 });
    expect(json(await u.run("get", col, id)).data).toEqual({ n: 2 });

    const again = await u.run("undelete", col, id);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("No deleted document with that id");
  });

  it("refuses when another document took the natural key", async () => {
    const kc = `undelkey-${uid()}`;
    await u.run("schema", "set", kc, "--natural-key", "slug");
    const old = json(await u.run("upsert", kc, "home", JSON.stringify({ slug: "home" }))).id;
    await u.run("delete", kc, old);
    await u.run("upsert", kc, "home", JSON.stringify({ slug: "home", v: 2 }));
    const r = await u.run("undelete", kc, old);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Natural key conflict");
  });
});

describe("label remove and diff", () => {
  const col = `lbl-${uid()}`;
  let id: string;

  beforeAll(async () => {
    id = json(await u.run("create", col, JSON.stringify({ a: { b: 1, c: [1, 2] }, x: 1 }))).id;
    await u.run("label", col, id, "before");
    await u.run("update", col, id, JSON.stringify({ a: { b: 2, c: [1, 2, 3] }, x: 1 }));
  });

  it("label remove removes a label; the old form still sets one", async () => {
    expect(json(await u.run("label", col, id, "tmp", "-v", "1"))).toEqual({ id, label: "tmp", version: 1 });
    expect(json(await u.run("label", "remove", col, id, "tmp"))).toEqual({ id, label: "tmp", removed: true, version: 1 });
    const gone = await u.run("label", "remove", col, id, "tmp");
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain("No such label on this document");
  });

  it("diff sends labels to the server; --deep reports nested changes", async () => {
    const shallow = json(await u.run("diff", col, id, "--v1", "before", "--v2", "2"));
    expect(shallow.v1).toBe(1);
    expect(shallow.diff.map((d: { path: string }) => d.path)).toEqual(["/a"]);

    const deep = json(await u.run("diff", col, id, "--v1", "before", "--v2", "2", "--deep"));
    expect(deep.diff).toEqual(expect.arrayContaining([
      { op: "replace", path: "/a/b", value: 2, oldValue: 1 },
      { op: "add", path: "/a/c/2", value: 3 },
    ]));
    expect(deep.diff).toHaveLength(2);
  });
});

describe("restore", () => {
  it("a collection: prints what was restored, undeleted, deleted and left alone", async () => {
    const col = `rest-${uid()}`;
    const ids: string[] = [];
    for (const name of ["a1", "b1", "c1"]) ids.push(json(await u.run("create", col, JSON.stringify({ name }))).id);
    const [a, b, c] = ids as [string, string, string];
    for (const id of [a, b, c]) await u.run("label", col, id, "fixture");
    await u.run("update", col, a, JSON.stringify({ name: "a2" }));
    await u.run("delete", col, b);
    const d = json(await u.run("create", col, JSON.stringify({ name: "new" }))).id;

    const r = await u.run("restore", col, "--label", "fixture", "--delete-unlabeled");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Restored ${col} to label "fixture": 1 restored, 1 undeleted, 1 deleted, 1 unchanged`);
    expect(r.stdout).toContain(`Collections changed: ${col}`);
    expect((await u.api("GET", `/${col}/${a}`)).data).toEqual({ name: "a1" });
    expect((await u.api("GET", `/${col}/${d}`)).status).toBe(404);

    const again = await u.run("restore", col, "-l", "fixture", "--json");
    expect(json(again)).toEqual({ label: "fixture", restored: 0, undeleted: 0, deleted: 0, unchanged: 3, collections: [] });
    const quiet = await u.run("restore", col, "-l", "fixture");
    expect(quiet.stdout).not.toContain("Collections changed");
  });

  it("an unknown label exits 1", async () => {
    const col = `rest-${uid()}`;
    await u.run("create", col, "{}");
    const r = await u.run("restore", col, "--label", "nope");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No document here has the label "nope"');
  });

  it("needs a collection or --tree, not both, and a label", async () => {
    for (const args of [["restore", "--label", "x"], ["restore", "c", "--tree", "t", "--label", "x"]]) {
      const r = await u.run(...args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("give a collection or --tree <name> (not both)");
    }
    expect((await u.run("restore", "c")).stderr).toContain("required option '-l, --label <label>' not specified");
  });

  it("--tree restores every document in a tree; without write access to all collections it names them", async () => {
    const tree = `rt-${uid()}`, pages = `rtpages-${uid()}`, other = `rtother-${uid()}`;
    const page = json(await u.run("create", pages, JSON.stringify({ title: "v1" }))).id;
    const doc = json(await u.run("create", other, JSON.stringify({ title: "o1" }))).id;
    await u.run("tree", "set", tree, "/index", page);
    await u.run("tree", "set", tree, "/other", doc);
    await u.run("promote", tree, "--label", "release-1");
    await u.run("update", pages, page, JSON.stringify({ title: "v2" }));

    const r = await u.run("restore", "--tree", tree, "--label", "release-1");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Restored tree "${tree}" to label "release-1": 1 restored, 0 undeleted, 0 deleted, 1 unchanged`);
    expect(r.stdout).toContain(`Collections changed: ${pages}`);
    expect((await u.api("GET", `/${pages}/${page}`)).data).toEqual({ title: "v1" });

    // A key with rules of its own: write on the tree and one collection only
    const key = await u.api("POST", "/keys", { name: `restore-${uid()}` });
    for (const resource of [`tree:${tree}`, `collection:${pages}`]) {
      await u.api("POST", "/permissions", { principal: `key:${key.id}`, resource, access: "write" });
    }
    const denied = await wren(["restore", "--tree", tree, "--label", "release-1"], { WREN_API_KEY: key.key });
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain(`write access to every collection in it: ${other}`);
  });
});

describe("files by name", () => {
  const dir = mkdtempSync(join(tmpdir(), "wren-cli-byname-"));

  it("upload --key stores by name, re-uploading identical bytes is unchanged, download --key reads it", async () => {
    const col = `named-${uid()}`;
    await u.run("schema", "patch", col, "--type", "binary", "--natural-key", "filename");
    const file = join(dir, "logo.svg");
    writeFileSync(file, "<svg/>");

    const created = await u.run("upload", col, file, "--key");
    expect(json(created)).toMatchObject({ version: 1, naturalKey: "logo.svg" });
    const same = await u.run("upload", col, file, "--key");
    expect(json(same)).toMatchObject({ version: 1, unchanged: true });
    expect(same.stderr).toContain("unchanged: same content as version 1, no new version written");
    expect(same.stderr).not.toContain("--force");

    writeFileSync(file, "<svg>2</svg>");
    const renamed = json(await u.run("upload", col, file, "--key", "brand-logo.svg", "--if-version", "0"));
    expect(renamed).toMatchObject({ version: 1, naturalKey: "brand-logo.svg" });
    const exists = await u.run("upload", col, file, "--key", "brand-logo.svg", "--if-version", "0");
    expect(exists.code).toBe(1);
    expect(exists.stderr).toContain("currentVersion: 1");

    expect((await u.run("download", col, "brand-logo.svg", "--key")).stdout).toBe("<svg>2</svg>");
    const out = join(dir, "out.svg");
    await u.run("download", col, "logo.svg", "--key", "--out", out);
    expect(readFileSync(out, "utf8")).toBe("<svg/>");
  });

  it("upload --if-version needs --key", async () => {
    const file = join(dir, "x.txt");
    writeFileSync(file, "x");
    const r = await u.run("upload", `named-${uid()}`, file, "--if-version", "1");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--if-version needs --key");
  });

  it("upload-version --if-version refuses a stale version; identical bytes are unchanged", async () => {
    const col = `files-${uid()}`;
    const file = join(dir, "a.txt");
    writeFileSync(file, "v1");
    const up = json(await u.run("upload", col, file));
    writeFileSync(file, "v2");
    expect(json(await u.run("upload-version", col, up.id, file, "--if-version", "1")).version).toBe(2);
    writeFileSync(file, "v3");
    const stale = await u.run("upload-version", col, up.id, file, "--if-version", "1");
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("the document is at version 2 (currentVersion: 2)");
    writeFileSync(file, "v2");
    const same = await u.run("upload-version", col, up.id, file);
    expect(json(same)).toMatchObject({ version: 2, unchanged: true });
  });
});

describe("schema patch", () => {
  const titleSchema = { type: "object", required: ["title"] };

  it("changes only the given fields and clears with --no-<field>", async () => {
    const col = `patch-${uid()}`;
    await u.run("schema", "set", col, JSON.stringify(titleSchema), "--display-name", "{title}", "--list-columns", "title");
    await u.run("create", col, JSON.stringify({ title: "t", slug: "p1" }));

    const keyed = json(await u.run("schema", "patch", col, "--natural-key", "slug"));
    expect(keyed).toMatchObject({ naturalKey: "slug", displayName: "{title}", listColumns: ["title"], keysRegistered: 1, schema: titleSchema });

    const more = json(await u.run("schema", "patch", col, "--display-name", "{slug}", "--list-columns", "slug, title", "--indexes", JSON.stringify([{ path: "slug", kind: "btree" }])));
    expect(more).toMatchObject({ displayName: "{slug}", listColumns: ["slug", "title"], naturalKey: "slug", indexes: [{ path: "slug", kind: "btree" }] });

    const cleared = json(await u.run("schema", "patch", col, "--no-display-name", "--no-list-columns", "--no-natural-key", "--no-indexes", "--no-schema"));
    expect(cleared).toMatchObject({ displayName: null, listColumns: null, naturalKey: null, indexes: [], schema: {} });

    const replaced = json(await u.run("schema", "patch", col, JSON.stringify(titleSchema)));
    expect(replaced.schema).toEqual(titleSchema);
  });

  it("creates a definition when there is none", async () => {
    const r = json(await u.run("schema", "patch", `patchnew-${uid()}`, "--type", "binary", "--natural-key", "filename"));
    expect(r).toMatchObject({ collectionType: "binary", naturalKey: "filename" });
  });

  it("rejects nothing to change, bad JSON and a schema together with --no-schema", async () => {
    const col = `patch-${uid()}`;
    const cases: [string[], string][] = [
      [[], "nothing to change"],
      [["{oops"], "invalid JSON"],
      [["--indexes", "[oops"], "invalid JSON in --indexes"],
      [["{}", "--no-schema"], "give a schema or --no-schema, not both"],
    ];
    for (const [args, message] of cases) {
      const r = await u.run("schema", "patch", col, ...args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(message);
    }
    const server = await u.run("schema", "patch", col, "--indexes", JSON.stringify([{ path: "x", kind: "nope" }]));
    expect(server.code).toBe(1);
    expect(server.stderr).toContain("Error:");
  });
});
