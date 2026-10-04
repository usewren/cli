// Shared setup for the integration tests: they run against a real WREN server
// (see tests/run-local.sh). The CLI reads the server from WREN_URL.
import { wren, type RunResult } from "./harness.ts";

export const WREN_URL = (process.env.WREN_URL ?? process.env.WREN_TEST_URL ?? "http://localhost:4000").replace(/\/$/, "");
// The CLI reads WREN_URL itself; make sure it is set even if only WREN_TEST_URL was
process.env.WREN_URL = WREN_URL;

export function uid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function authPost(path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${WREN_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      // better-auth rejects cross-site POSTs, so send the server's own origin
      Origin: WREN_URL,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

export interface TestUser {
  email: string;
  password: string;
  cookie: string;
  apiKey: string;
  keyId: string;
  userId: string;
  slug: string;
  /** Run the CLI as this user (API key via WREN_API_KEY). */
  run: (...args: string[]) => Promise<RunResult>;
  /** Call the API directly, for setup and for checking what a command did. */
  api: (method: string, path: string, body?: unknown) => Promise<any>;
}

/** Sign up a fresh user, sign in, and create an API key for their own org. */
export async function createUser(prefix = "cli"): Promise<TestUser> {
  const email = `${prefix}-${uid()}@cli-tests.example`;
  const password = "correct-horse-battery-staple";
  const signUp = await authPost("/api/auth/sign-up/email", { email, password, name: `Test ${prefix}` });
  if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status} ${await signUp.text()}`);
  const signIn = await authPost("/api/auth/sign-in/email", { email, password });
  if (!signIn.ok) throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
  const cookie = decodeURIComponent(signIn.headers.get("set-cookie")?.split(";")[0] ?? "");
  const keyRes = await authPost("/api/v1/keys", { name: "cli-tests" }, cookie);
  if (!keyRes.ok) throw new Error(`key creation failed: ${keyRes.status} ${await keyRes.text()}`);
  const key = (await keyRes.json()) as { id: string; key: string };

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${WREN_URL}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${key.key}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("json") ? { status: res.status, ...(await res.json()) } : { status: res.status, text: await res.text() };
  };
  const me = await api("GET", "/me");

  return {
    email,
    password,
    cookie,
    apiKey: key.key,
    keyId: key.id,
    userId: me.user.id,
    slug: me.org.slug,
    run: (...args: string[]) => wren(args, { WREN_API_KEY: key.key }),
    api,
  };
}

/** Parse the JSON a command printed. */
export function json(r: RunResult): any {
  return JSON.parse(r.stdout);
}
