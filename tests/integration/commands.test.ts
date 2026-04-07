import { describe, it, expect } from "bun:test";
import { $ } from "bun";

const CLI = "./index.ts";
const SERVER = "http://localhost:4001";

async function wren(...args: string[]) {
  const result = await $`bun ${CLI} ${args}`.env({
    ...process.env,
  }).nothrow().text();
  return result.trim();
}

describe("wren cli", () => {
  it("shows help", async () => {
    const output = await wren("--help");
    expect(output).toContain("Usage: wren");
    expect(output).toContain("auth");
    expect(output).toContain("list");
    expect(output).toContain("create");
  });

  it("shows auth subcommand help", async () => {
    const output = await wren("auth", "--help");
    expect(output).toContain("login");
    expect(output).toContain("logout");
    expect(output).toContain("whoami");
  });

  it("shows version", async () => {
    const output = await wren("--version");
    expect(output).toContain("0.1.0");
  });

  it("login and whoami against test server", async () => {
    const login = await wren("auth", "login", "--email", "test@wren.dev", "--password", "secret123");
    expect(login).toContain("Signed in as test@wren.dev");

    const whoami = await wren("auth", "whoami");
    const user = JSON.parse(whoami);
    expect(user.email).toBe("test@wren.dev");
  });
});
