import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createUser, json, uid, type TestUser } from "../helpers.ts";

let u: TestUser;

beforeAll(async () => {
  u = await createUser("docs");
});

describe("documents", () => {
  const col = `articles-${uid()}`;

  it("create / get / update / delete", async () => {
    const created = json(await u.run("create", col, JSON.stringify({ title: "Hello" })));
    expect(created.version).toBe(1);
    expect(created.data).toEqual({ title: "Hello" });

    expect(json(await u.run("get", col, created.id)).data.title).toBe("Hello");

    const updated = json(await u.run("update", col, created.id, JSON.stringify({ title: "Updated" })));
    expect(updated.version).toBe(2);

    expect(json(await u.run("delete", col, created.id))).toEqual({ id: created.id, deleted: true });
    const gone = await u.run("get", col, created.id);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain("Error: Not found");
  });

  // The server answers a malformed body with a non-JSON 500 page; the CLI
  // reports its status and the start of the body instead of crashing.
  it("create with invalid JSON exits 1 with a clean error", async () => {
    const r = await u.run("create", col, "{not json");
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith("Error: invalid JSON");
  });

  it("collections lists collections with counts", async () => {
    await u.run("create", col, JSON.stringify({ title: "x" }));
    const { collections } = json(await u.run("collections"));
    expect(collections.find((c: { name: string }) => c.name === col)?.count).toBeGreaterThanOrEqual(1);
  });

  it("list honors --limit and --label", async () => {
    const listCol = `list-${uid()}`;
    const a = json(await u.run("create", listCol, JSON.stringify({ n: 1 })));
    await u.run("create", listCol, JSON.stringify({ n: 2 }));
    await u.run("create", listCol, JSON.stringify({ n: 3 }));
    const all = json(await u.run("list", listCol));
    expect(all.total).toBe(3);
    expect(json(await u.run("list", listCol, "--limit", "2")).items).toHaveLength(2);

    await u.run("label", listCol, a.id, "published");
    const published = json(await u.run("list", listCol, "--label", "published"));
    expect(published.items.map((d: { id: string }) => d.id)).toEqual([a.id]);
  });

  it("list --filter narrows the results", async () => {
    const listCol = `filter-${uid()}`;
    await u.run("create", listCol, JSON.stringify({ kind: "odd" }));
    await u.run("create", listCol, JSON.stringify({ kind: "even" }));
    expect(json(await u.run("list", listCol, "--filter", "kind:odd")).total).toBe(1);
  });

  it("list --offset pages through the results", async () => {
    const listCol = `page-${uid()}`;
    for (let i = 0; i < 3; i++) await u.run("create", listCol, JSON.stringify({ i }));
    const first = json(await u.run("list", listCol, "--limit", "2"));
    expect(first.items).toHaveLength(2);
    const second = json(await u.run("list", listCol, "--limit", "2", "--offset", "2"));
    expect(second.total).toBe(3);
    expect(second.items).toHaveLength(1);
    // Newest first, so the last page holds the first document created
    expect(second.items[0].data).toEqual({ i: 0 });
  });

  it("get --label returns the labeled version", async () => {
    const doc = json(await u.run("create", col, JSON.stringify({ title: "v1" })));
    await u.run("label", col, doc.id, "published");
    await u.run("update", col, doc.id, JSON.stringify({ title: "v2" }));
    const labeled = json(await u.run("get", col, doc.id, "--label", "published"));
    expect(labeled.version).toBe(1);
    expect(labeled.data.title).toBe("v1");
  });

  it("paths lists the tree paths of a document", async () => {
    const doc = json(await u.run("create", col, JSON.stringify({ title: "in tree" })));
    const tree = `site-${uid()}`;
    await u.run("tree", "set", tree, "/a", doc.id);
    expect(json(await u.run("paths", col, doc.id)).paths).toEqual([{ tree, path: "/a" }]);
  });
});

describe("natural keys", () => {
  const col = `pages-${uid()}`;

  it("upsert / get-by-key / delete-by-key", async () => {
    await u.run("schema", "set", col, "--natural-key", "slug");
    const created = json(await u.run("upsert", col, "about us", JSON.stringify({ slug: "about us", title: "About" })));
    expect(created.version).toBe(1);
    const updated = json(await u.run("upsert", col, "about us", JSON.stringify({ slug: "about us", title: "About us" })));
    expect(updated.id).toBe(created.id);
    expect(updated.version).toBe(2);

    expect(json(await u.run("get-by-key", col, "about us")).data.title).toBe("About us");
    await u.run("label", col, created.id, "published", "-v", "1");
    expect(json(await u.run("get-by-key", col, "about us", "--label", "published")).data.title).toBe("About");

    expect(json(await u.run("delete-by-key", col, "about us"))).toEqual({ id: created.id, deleted: true });
    expect((await u.run("get-by-key", col, "about us")).code).toBe(1);
  });
});

describe("versions, labels, diff", () => {
  const col = `v-${uid()}`;
  let id: string;

  beforeAll(async () => {
    id = json(await u.run("create", col, JSON.stringify({ title: "Old", draft: true }))).id;
    await u.run("update", col, id, JSON.stringify({ title: "New" }));
  });

  it("versions lists the history", async () => {
    const hist = json(await u.run("versions", col, id));
    expect(hist.versions.map((v: { version: number }) => v.version).sort()).toEqual([1, 2]);
  });

  it("label pins the current version, or --version", async () => {
    expect(json(await u.run("label", col, id, "published"))).toEqual({ id, label: "published", version: 2 });
    expect(json(await u.run("label", col, id, "staging", "-v", "1")).version).toBe(1);
    const bad = await u.run("label", col, id, "x", "-v", "99");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Version not found");
  });

  it("label --version <n> pins that version", async () => {
    const r = await u.run("label", col, id, "pinned", "--version", "1");
    expect(json(r)).toEqual({ id, label: "pinned", version: 1 });
  });

  it("diff --v1 --v2 compares two versions", async () => {
    const d = json(await u.run("diff", col, id, "--v1", "1", "--v2", "2"));
    const byPath = Object.fromEntries(d.diff.map((e: { path: string }) => [e.path, e]));
    expect(byPath["/title"]).toMatchObject({ op: "replace", value: "New", oldValue: "Old" });
    expect(byPath["/draft"].op).toBe("remove");
  });

  it("diff accepts labels for --v1/--v2", async () => {
    await u.run("label", col, id, "before", "--version", "1");
    const d = json(await u.run("diff", col, id, "--v1", "before", "--v2", "2"));
    expect(d.v1).toBe(1);
    expect(d.diff.length).toBeGreaterThan(0);
  });

  it("diff with an unknown label exits 1 (the server resolves labels)", async () => {
    const r = await u.run("diff", col, id, "--v1", "nope", "--v2", "2");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error: No such label on this document");
  });

  it("rollback restores an old version as a new one", async () => {
    expect(json(await u.run("rollback", col, id, "1"))).toEqual({ id, version: 3, rolledBackTo: 1 });
    expect(json(await u.run("get", col, id)).data).toEqual({ title: "Old", draft: true });
  });
});

describe("schema", () => {
  const titleSchema = { type: "object", required: ["title"], properties: { title: { type: "string" } } };

  it("set with every option / get / delete", async () => {
    const col = `s-${uid()}`;
    const set = json(await u.run(
      "schema", "set", col, JSON.stringify(titleSchema),
      "--display-name", "{title}", "--list-columns", "title, date,", "--natural-key", "slug", "--type", "json",
    ));
    expect(set.schema).toEqual(titleSchema);
    expect(set.listColumns).toEqual(["title", "date"]);
    const got = json(await u.run("schema", "get", col));
    expect(got).toMatchObject({ displayName: "{title}", naturalKey: "slug", collectionType: "json" });
    expect(json(await u.run("schema", "delete", col))).toEqual({ collection: col, deleted: true });
    expect((await u.run("schema", "get", col)).code).toBe(1);
  });

  it("set rejects invalid JSON", async () => {
    const r = await u.run("schema", "set", `s-${uid()}`, "{oops");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("invalid JSON");
  });

  it("validate prints a summary and exits 0 when everything passes", async () => {
    const col = `val-${uid()}`;
    await u.run("create", col, JSON.stringify({ title: "ok" }));
    await u.run("schema", "set", col, JSON.stringify(titleSchema));
    const r = await u.run("schema", "validate", col);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Schema:     current schema");
    expect(r.stdout).toContain("Invalid:    0");
  });

  it("validate with a proposed schema lists failures and exits 1", async () => {
    const col = `val-${uid()}`;
    for (let i = 0; i < 3; i++) await u.run("create", col, JSON.stringify({ n: i }));
    const r = await u.run("schema", "validate", col, JSON.stringify(titleSchema), "--limit", "1", "--max", "2");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Schema:     proposed schema");
    expect(r.stdout).toContain("(limit reached");
    expect(r.stdout).toContain("Failures:");
    expect(r.stdout).toContain("more not shown");
  });

  it("validate --json prints the raw result", async () => {
    const col = `val-${uid()}`;
    await u.run("create", col, JSON.stringify({ n: 1 }));
    const res = json(await u.run("schema", "validate", col, JSON.stringify(titleSchema), "--json"));
    expect(res).toMatchObject({ schemaSource: "proposed", checked: 1, invalid: 1 });
  });

  it("validate rejects an invalid proposed schema and a missing schema", async () => {
    const bad = await u.run("schema", "validate", `v-${uid()}`, "{oops");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("invalid JSON in proposed schema");
    const none = await u.run("schema", "validate", `v-${uid()}`);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("No schema set");
  });
});

describe("tree", () => {
  const col = `t-${uid()}`;

  it("set / get / view / list / remove", async () => {
    const tree = `site-${uid()}`;
    const doc = json(await u.run("create", col, JSON.stringify({ title: "Hello" })));
    const first = await u.run("tree", "set", tree, "blog/hello", doc.id);
    expect(json(first)).toMatchObject({ path: "/blog/hello", documentId: doc.id });
    // The first assignment in a new tree comes with a hint on stderr
    expect(first.stderr).toContain("ℹ");
    expect(first.stderr).toContain("To make it publicly readable");

    const second = await u.run("tree", "set", tree, "/blog/other", doc.id);
    expect(second.stderr).toBe("");

    const node = json(await u.run("tree", "get", tree, "blog/hello"));
    expect(node.document.id).toBe(doc.id);
    expect(json(await u.run("tree", "get", tree, "/blog")).children).toHaveLength(2);

    const view = await u.run("tree", "view", tree);
    expect(view.stdout).toContain(`/blog/hello  [${col} v1]  title: "Hello"`);

    const { trees } = json(await u.run("tree", "list"));
    expect(trees.find((t: { name: string }) => t.name === tree)?.count).toBe(2);

    expect(json(await u.run("tree", "remove", tree, "blog/other"))).toMatchObject({ path: "/blog/other", removed: true });
    expect((await u.run("tree", "get", tree, "/blog/other")).code).toBe(1);
  });

  it("set without a document creates an empty folder", async () => {
    const tree = `site-${uid()}`;
    const r = await u.run("tree", "set", tree, "/empty");
    expect(json(r)).toEqual({ tree, path: "/empty", documentId: null });
    const root = json(await u.run("tree", "get", tree, "/"));
    expect(root.children).toEqual([{ path: "/empty", documentId: null }]);
  });

  it("view of an empty tree", async () => {
    expect((await u.run("tree", "view", `none-${uid()}`)).stdout).toContain("is empty");
  });

  it("view shows (empty) for a document without fields", async () => {
    const tree = `site-${uid()}`;
    const doc = json(await u.run("create", col, "{}"));
    await u.run("tree", "set", tree, "/blank", doc.id);
    expect((await u.run("tree", "view", tree)).stdout).toContain("(empty)");
  });
});

describe("binary assets", () => {
  const col = `files-${uid()}`;
  const dir = mkdtempSync(join(tmpdir(), "wren-cli-assets-"));

  it("upload / upload-version / download", async () => {
    await u.run("schema", "set", col, "--type", "binary");
    const file = join(dir, "hello.txt");
    writeFileSync(file, "hello v1");
    const up = json(await u.run("upload", col, file));
    expect(up.version).toBe(1);
    expect(up.data.filename).toBe("hello.txt");

    writeFileSync(file, "hello v2!");
    const v2 = json(await u.run("upload-version", col, up.id, file));
    expect(v2.version).toBe(2);

    const stdout = await u.run("download", col, up.id);
    expect(stdout.stdout).toBe("hello v2!");

    const out = join(dir, "out.txt");
    const saved = await u.run("download", col, up.id, "--out", out);
    expect(saved.stdout).toContain(`Saved to ${out}`);
    expect(readFileSync(out, "utf8")).toBe("hello v2!");
  });

  it("download --version <n> downloads that version", async () => {
    const file = join(dir, "pinned.txt");
    writeFileSync(file, "one");
    const up = json(await u.run("upload", col, file));
    writeFileSync(file, "two");
    await u.run("upload-version", col, up.id, file);
    expect((await u.run("download", col, up.id, "--version", "1")).stdout).toBe("one");
  });

  it("upload of a missing file exits 1", async () => {
    const r = await u.run("upload", col, join(dir, "nope.bin"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("file not found");
    const v = await u.run("upload-version", col, "00000000-0000-0000-0000-000000000000", join(dir, "nope.bin"));
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("file not found");
  });

  it("download of a missing asset exits 1", async () => {
    const r = await u.run("download", col, "00000000-0000-0000-0000-000000000000");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error:");
  });

  it("upload-version of an unknown asset exits 1 with the server's error", async () => {
    const file = join(dir, "x.txt");
    writeFileSync(file, "x");
    const r = await u.run("upload-version", col, "00000000-0000-0000-0000-000000000000", file);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error:");
  });
});

describe("query and materialized", () => {
  const col = `q-${uid()}`;

  beforeAll(async () => {
    await u.run("create", col, JSON.stringify({ title: "a", category: "news" }));
    await u.run("create", col, JSON.stringify({ title: "b", category: "news" }));
    await u.run("create", col, JSON.stringify({ title: "c", category: "opinion" }));
  });

  it("query with --where/--select/--limit/--label/--cursor", async () => {
    const res = json(await u.run("query", col, "--where", "category:news", "--select", "title, category", "--limit", "5"));
    expect(res.items).toHaveLength(2);
    expect(Object.keys(res.items[0].data).sort()).toEqual(["category", "title"]);

    const page = json(await u.run("query", col, "--limit", "1"));
    expect(page.cursor).toBeTruthy();
    const next = json(await u.run("query", col, "--limit", "1", "--cursor", page.cursor));
    expect(next.items.length).toBeLessThanOrEqual(1);

    expect(json(await u.run("query", col, "--label", "published")).items).toEqual([]);
  });

  it("query --json sends a full body (aggregation)", async () => {
    const body = { aggregate: { groupBy: ["category"], metrics: { n: { count: "title" } } } };
    const res = json(await u.run("query", col, "--json", JSON.stringify(body)));
    const news = res.rows.find((r: { key: { category: string } }) => r.key.category === "news");
    expect(news.n).toBe(2);
  });

  it("materialized set / list / get / delete", async () => {
    const set = json(await u.run("materialized", "set", col, "slim", "--query", JSON.stringify({ select: ["title"] })));
    expect(set).toMatchObject({ name: "slim", refreshOn: "write" });
    const manual = json(await u.run("materialized", "set", col, "manual", "--query", "{}", "--refresh", "manual"));
    expect(manual.refreshOn).toBe("manual");

    const { materialized } = json(await u.run("materialized", "list", col));
    expect(materialized.map((m: { name: string }) => m.name)).toEqual(["manual", "slim"]);

    let got = await u.run("materialized", "get", col, "slim");
    for (let i = 0; got.code !== 0 && i < 50; i++) {
      await Bun.sleep(100); // the first refresh runs in the background
      got = await u.run("materialized", "get", col, "slim");
    }
    expect(json(got).result.data).toBeDefined();

    expect(json(await u.run("materialized", "delete", col, "slim"))).toEqual({ collection: col, name: "slim", deleted: true });
    expect((await u.run("materialized", "get", col, "slim")).code).toBe(1);
  });
});
