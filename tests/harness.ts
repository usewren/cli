// Runs the CLI in-process so `bun test --coverage` sees index.ts.
//
// index.ts registers its commands on commander's global `program` and calls
// program.parse() at import time. The harness swaps in its own Command via
// mock.module("commander") before index.ts is first imported, ignores that
// import-time parse(), and then drives every run with program.parseAsync()
// (commander resets option values between parses). Commander is told to throw
// instead of exiting, and process.exit is replaced with a throw, so a run ends
// with an exit code instead of ending the test process.
import { mock } from "bun:test";
import * as commander from "commander";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { Command, CommanderError } = commander;

export class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let out: string[] = [];
let err: string[] = [];

const program = new Command();
program.exitOverride();
program.configureOutput({
  writeOut: (s) => void out.push(s),
  writeErr: (s) => void err.push(s),
});
program.parse = (() => program) as typeof program.parse; // index.ts's own parse() call
mock.module("commander", () => ({ ...commander, program }));

let loaded: Promise<unknown> | undefined;

/** Run `wren <args>` in-process. `env` entries are set for the run and restored after. */
export async function wren(args: string[], env: Record<string, string | undefined> = {}): Promise<RunResult> {
  loaded ??= import("../index.ts");
  await loaded;

  out = [];
  err = [];
  const saved = {
    exit: process.exit,
    log: console.log,
    error: console.error,
    write: process.stdout.write,
    env: Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]])),
  };
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as typeof process.exit;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" ") + "\n");
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" ") + "\n");
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  let code = 0;
  try {
    await program.parseAsync(["bun", "index.ts", ...args]);
  } catch (e) {
    if (e instanceof ExitError) code = e.code;
    else if (e instanceof CommanderError) code = e.exitCode;
    else throw e;
  } finally {
    process.exit = saved.exit;
    console.log = saved.log;
    console.error = saved.error;
    process.stdout.write = saved.write;
    for (const [k, v] of Object.entries(saved.env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** A private HOME for the CLI's ~/.wren/config.json. */
export function isolateHome(): string {
  const home = mkdtempSync(join(tmpdir(), "wren-cli-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}
