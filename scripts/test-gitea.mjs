// Fetches and verifies the pinned official Gitea binary used by integration tests.
// Usage: node scripts/test-gitea.mjs [ensure|path]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePinnedBinary } from "./pinned-binary.mjs";

// Intentionally not the release the demo instance runs (config/gitea-instance.json): the tests
// target the oldest Gitea this editor supports.
export const GITEA_VERSION = "1.24.6";
const GITEA_ASSET = `gitea-${GITEA_VERSION}-linux-amd64`;
const GITEA_BASE_URL = `https://dl.gitea.com/gitea/${GITEA_VERSION}`;
// Pinned; must also match the official .sha256 published next to the binary.
const GITEA_SHA256 = "bb09d565d7e22ed07a9525d22e6f7c468ec00b58484a9691d61ff70940452676";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function giteaToolsDir() {
  return process.env.GITEA_TEST_TOOLS_DIR
    ? path.resolve(process.env.GITEA_TEST_TOOLS_DIR)
    : path.join(repoRoot, "data", "test-tools");
}

function giteaBinaryPath() {
  return path.join(giteaToolsDir(), `gitea-${GITEA_VERSION}`, GITEA_ASSET);
}

// Returns the absolute path of the verified binary, downloading it if needed.
export function ensureGiteaBinary() {
  return ensurePinnedBinary({
    binary: giteaBinaryPath(),
    url: `${GITEA_BASE_URL}/${GITEA_ASSET}`,
    sha256: GITEA_SHA256,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] ?? "ensure";
  if (cmd !== "ensure" && cmd !== "path") {
    console.error(`usage: node scripts/test-gitea.mjs [ensure|path]`);
    process.exit(2);
  }
  try {
    console.log(cmd === "path" ? giteaBinaryPath() : await ensureGiteaBinary());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
