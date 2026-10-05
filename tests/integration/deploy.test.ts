import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { wren } from "../harness.ts";
import { createUser, uid, WREN_URL, type TestUser } from "../helpers.ts";

let u: TestUser;

beforeAll(async () => {
  u = await createUser("deploy");
});

function makeSite(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "wren-site-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

async function publicFetch(path: string): Promise<Response> {
  return fetch(`${WREN_URL}${path}`);
}

describe("deploy", () => {
  it("uploads every file, creates the binary collection and assigns tree paths", async () => {
    const tree = `site-${uid()}`;
    const dir = makeSite({
      "index.html": "<h1>home</h1>",
      "css/site.css": "body{}",
      "node_modules/skip.js": "ignored",
      ".git/HEAD": "ignored",
    });
    const r = await u.run("deploy", dir, "--tree", tree);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Found 2 files");
    expect(r.stdout).toContain(`Creating binary collection: ${tree}-assets`);
    expect(r.stdout).toContain(`Deployed to tree "${tree}":  2 uploaded, 0 unchanged, 2 new paths`);
    expect(r.stdout).toContain(`/orgs/${u.slug}/tree/${tree}/index.html`);

    const schema = await u.api("GET", `/${tree}-assets/_schema`);
    expect(schema.collectionType).toBe("binary");
    const snap = await u.api("GET", `/tree/${tree}?full=true`);
    expect(snap.nodes.map((n: { path: string }) => n.path).sort()).toEqual(["/css/site.css", "/index.html"]);
  });

  it("skips unchanged files by SHA-256 and re-uploads same-size edits", async () => {
    const tree = `site-${uid()}`;
    const dir = makeSite({ "index.html": "version 1", "about.html": "about" });
    await u.run("deploy", dir, "--tree", tree);

    const again = await u.run("deploy", dir, "--tree", tree);
    expect(again.stdout).toContain("0 uploaded, 2 unchanged, 0 new paths");
    expect(again.stdout).not.toContain("Creating binary collection");

    // Same size, different bytes: a size comparison would miss this
    writeFileSync(join(dir, "index.html"), "version 2");
    const changed = await u.run("deploy", dir, "--tree", tree);
    expect(changed.stdout).toContain("1 uploaded, 1 unchanged, 0 new paths");

    const node = await u.api("GET", `/tree/${tree}/index.html`);
    expect(node.document.version).toBe(2);
    const raw = await u.api("GET", `/${tree}-assets/${node.document.id}/raw`);
    expect(raw.text).toBe("version 2");
  });

  it("--dry-run reports without changing anything", async () => {
    const tree = `site-${uid()}`;
    const dir = makeSite({ "index.html": "a", "b.html": "b" });
    await u.run("deploy", dir, "--tree", tree);
    writeFileSync(join(dir, "index.html"), "changed");
    writeFileSync(join(dir, "new.html"), "new");
    rmSync(join(dir, "b.html"));

    const r = await u.run("deploy", dir, "--tree", tree, "--dry-run", "--clean");
    expect(r.stdout).toContain("  update: /index.html");
    expect(r.stdout).toContain("  upload: /new.html");
    expect(r.stdout).toContain("  remove: /b.html");
    expect(r.stdout).toContain("Dry run: 2 to upload, 0 unchanged, 1 to remove");

    const snap = await u.api("GET", `/tree/${tree}?full=true`);
    expect(snap.nodes.map((n: { path: string }) => n.path).sort()).toEqual(["/b.html", "/index.html"]);
  });

  it("--dry-run on a new tree does not create the collection", async () => {
    const tree = `site-${uid()}`;
    const r = await u.run("deploy", makeSite({ "index.html": "x" }), "--tree", tree, "--dry-run");
    expect(r.stdout).toContain("Dry run: 1 to upload");
    expect((await u.api("GET", `/${tree}-assets/_schema`)).status).toBe(404);
  });

  it("--clean removes tree paths of deleted files", async () => {
    const tree = `site-${uid()}`;
    const dir = makeSite({ "index.html": "a", "old.html": "old" });
    await u.run("deploy", dir, "--tree", tree);
    rmSync(join(dir, "old.html"));
    const r = await u.run("deploy", dir, "--tree", tree, "--clean");
    expect(r.stdout).toContain("1 removed");
    expect((await u.api("GET", `/tree/${tree}/old.html`)).status).toBe(404);
  });

  it("--collection picks the asset collection", async () => {
    const tree = `site-${uid()}`;
    const col = `custom-${uid()}`;
    await u.run("deploy", makeSite({ "index.html": "x" }), "--tree", tree, "--collection", col);
    const node = await u.api("GET", `/tree/${tree}/index.html`);
    expect(node.document.collection).toBe(col);
  });

  it("--label labels uploaded and unchanged versions", async () => {
    const tree = `site-${uid()}`;
    const dir = makeSite({ "index.html": "a", "b.html": "b" });
    const r = await u.run("deploy", dir, "--tree", tree, "--label", "preview");
    expect(r.stdout).toContain("Label: preview");
    expect(r.stdout).toContain(`"preview" versions stay private until promoted`);
    expect(r.stdout).toContain(`wren promote ${tree} --from preview`);

    writeFileSync(join(dir, "index.html"), "A");
    await u.run("deploy", dir, "--tree", tree, "--label", "staging");
    for (const path of ["/index.html", "/b.html"]) {
      const node = await u.api("GET", `/tree/${tree}${path}?label=staging`);
      expect(node.status).toBe(200);
    }
  });

  it("--public creates a public read rule (labelFilter published when labeled)", async () => {
    const tree = `site-${uid()}`;
    const dir = makeSite({ "index.html": "<p>public</p>" });
    const r = await u.run("deploy", dir, "--tree", tree, "--public");
    expect(r.stdout).toContain(`Created public read permission for tree:${tree}`);
    const res = await publicFetch(`/orgs/${u.slug}/tree/${tree}/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>public</p>");

    const tree2 = `site-${uid()}`;
    const r2 = await u.run("deploy", dir, "--tree", tree2, "--public", "--label", "preview");
    expect(r2.stdout).toContain("(labelFilter: published)");
    const { permissions } = await u.api("GET", "/permissions");
    expect(permissions.find((p: { resource: string }) => p.resource === `tree:${tree2}`).labelFilter).toBe("published");
    // Not promoted yet: visitors see nothing
    expect((await publicFetch(`/orgs/${u.slug}/tree/${tree2}/index.html`)).status).not.toBe(200);
  });

  it("errors on a missing or empty directory", async () => {
    const missing = await u.run("deploy", "/no/such/dir", "--tree", "x");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("directory not found");
    const empty = await u.run("deploy", mkdtempSync(join(tmpdir(), "wren-empty-")), "--tree", "x");
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("no files found");
  });

  it("deploys a relative directory and the current directory", async () => {
    const dir = makeSite({ "index.html": "cwd" });
    const cwd = process.cwd();
    process.chdir(join(dir, ".."));
    try {
      const rel = await u.run("deploy", dir.split("/").pop()!, "--tree", `site-${uid()}`, "--dry-run");
      expect(rel.stdout).toContain("Found 1 files");
      process.chdir(dir);
      const here = await u.run("deploy", "--tree", `site-${uid()}`, "--dry-run");
      expect(here.stdout).toContain(`Found 1 files in ${dir}`);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("promote", () => {
  it("labels the current version of every document atomically", async () => {
    const tree = `site-${uid()}`;
    const dir = makeSite({ "index.html": "v1", "about.html": "about" });
    await u.run("deploy", dir, "--tree", tree, "--public", "--label", "preview");
    writeFileSync(join(dir, "index.html"), "v2");
    await u.run("deploy", dir, "--tree", tree);   // v2 without label

    const r = await u.run("promote", tree, "--from", "preview");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Done: 2 documents in tree "${tree}" labeled "published" (from "preview") in one transaction.`);
    expect(r.stdout).toContain(`Public: ${WREN_URL}/orgs/${u.slug}/tree/${tree}/index.html`);

    // --from preview promoted v1, not the newer unlabeled v2
    const res = await publicFetch(`/orgs/${u.slug}/tree/${tree}/index.html`);
    expect(await res.text()).toBe("v1");

    const all = await u.run("promote", tree, "--label", "live");
    expect(all.stdout).toContain(`labeled "live" in one transaction`);
    const live = await u.api("GET", `/tree/${tree}/index.html?label=live`);
    expect(live.document.version).toBe(2);
  });

  it("fails on an empty tree", async () => {
    const r = await u.run("promote", `none-${uid()}`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Error:");
  });
});

describe("promote against a server without atomic promote", () => {
  // Older servers answer 405 on POST /tree/{name}/_promote; the CLI then labels
  // documents one by one. A local stub stands in for such a server.
  let server: ReturnType<typeof Bun.serve>;
  const labeled: unknown[] = [];
  let nodes: unknown[] = [];
  let meFails = false;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/_promote")) return Response.json({ error: "Method not allowed" }, { status: 405 });
        if (url.pathname.startsWith("/api/v1/tree/")) {
          return Response.json({ tree: "old", from: url.searchParams.get("label"), nodes });
        }
        if (url.pathname.endsWith("/labels")) {
          labeled.push({ path: url.pathname, ...(await req.json() as object) });
          return Response.json({ ok: true });
        }
        if (url.pathname === "/api/v1/me") {
          if (meFails) return new Response("<html>Bad gateway</html>", { status: 502 });
          return Response.json({ org: { slug: "stub-org" } });
        }
        if (url.pathname === "/api/v1/collections") return new Response("<html>maintenance</html>");
        return Response.json({ error: "Not found" }, { status: 404 });
      },
    });
  });

  afterAll(() => server.stop(true));

  it("falls back to labeling each document", async () => {
    nodes = [
      { path: "/index.html", documentId: "d1", document: { collection: "old-assets", version: 3 } },
      { path: "/a.html", documentId: "d2", document: { collection: "old-assets", version: 1 } },
    ];
    const r = await wren(["promote", "old", "--from", "preview"], { WREN_URL: `http://localhost:${server.port}`, WREN_API_KEY: "wren_stub" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Server has no atomic promote");
    expect(r.stdout).toContain(`Promoting 2 documents in tree "old" → label "published" (from "preview")`);
    expect(r.stdout).toContain("Public: http://localhost:");
    expect(labeled).toEqual([
      { path: "/api/v1/old-assets/d1/labels", label: "published", version: 3 },
      { path: "/api/v1/old-assets/d2/labels", label: "published", version: 1 },
    ]);
  });

  it("a failing /me lookup only skips the public URL", async () => {
    nodes = [{ path: "/index.html", documentId: "d1", document: { collection: "old-assets", version: 3 } }];
    meFails = true;
    try {
      const r = await wren(["promote", "old"], { WREN_URL: `http://localhost:${server.port}`, WREN_API_KEY: "wren_stub" });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Done: 1 documents labeled "published".`);
      expect(r.stdout).not.toContain("Public:");
    } finally {
      meFails = false;
    }
  });

  it("a non-JSON success body exits 1 with the status and an excerpt", async () => {
    const r = await wren(["collections"], { WREN_URL: `http://localhost:${server.port}`, WREN_API_KEY: "wren_stub" });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("Error: HTTP 200 OK (not JSON): <html>maintenance</html>\n");
  });

  it("reports an empty tree", async () => {
    nodes = [];
    const r = await wren(["promote", "old"], { WREN_URL: `http://localhost:${server.port}`, WREN_API_KEY: "wren_stub" });
    expect(r.stdout).toContain(`Tree "old" is empty.`);
    const from = await wren(["promote", "old", "--from", "x"], { WREN_URL: `http://localhost:${server.port}`, WREN_API_KEY: "wren_stub" });
    expect(from.stdout).toContain(`(no documents with label "x")`);
  });
});
