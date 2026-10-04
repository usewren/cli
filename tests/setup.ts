// Preloaded before every test file (bunfig.toml): give the CLI a throwaway home
// so tests never read or overwrite the developer's real ~/.wren/config.json.
// Bun's os.homedir() doesn't follow a runtime change of $HOME, so config.ts's
// view of "os" is mocked as well.
import { mock } from "bun:test";
import * as os from "os";
import { isolateHome } from "./harness.ts";

const home = isolateHome();
const mocked = () => ({ ...os, default: { ...os, homedir: () => home }, homedir: () => home });
mock.module("os", mocked);
mock.module("node:os", mocked);
