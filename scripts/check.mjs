// npm run check: type-check the dashboard, then syntax-check every server file and the CLI (works on Windows too).
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", "dashboard/tsconfig.json", "--noEmit"], { stdio: "inherit" });

const files = [
  ...["server", join("server", "lib")].flatMap(d => readdirSync(d).filter(f => f.endsWith(".js")).map(f => join(d, f))),
  join("bin", "claudia-local.js"),
  ...readdirSync("scripts").filter(f => f.endsWith(".mjs")).map(f => join("scripts", f)),
];
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { stdio: "inherit" });
  if (r.status !== 0) bad++;
}
if (bad) { console.error(`${bad} file(s) failed the syntax check.`); process.exit(1); }
console.log(`Checked the dashboard types and ${files.length} files.`);
