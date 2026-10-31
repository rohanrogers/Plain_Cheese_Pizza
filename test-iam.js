// Run real assertions against the integrated IAM, replacing the prototype's
// unconditional success banner. Uses an isolated PostgreSQL schema.
import { spawnSync } from "node:child_process";
const python =
  process.platform === "win32"
    ? ".venv/Scripts/python.exe"
    : ".venv/bin/python";
const result = spawnSync(
  python,
  ["-m", "unittest", "backend.tests.test_iam", "-v"],
  { stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
