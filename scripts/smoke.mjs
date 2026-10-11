// npm run smoke: boot the server with a throwaway data folder, check /api/health, set up a vault, check
// /api/state and the health report, then stop. Plain Node, so it runs the same on Linux, macOS and Windows (CI).
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = String(process.env.SMOKE_PORT || 3990);
const base = `http://127.0.0.1:${port}`;
const home = mkdtempSync(join(tmpdir(), "claudia-local-smoke-"));
const version = (await import("../package.json", { with: { type: "json" } })).default.version;
const child = spawn(process.execPath, ["server/index.js"], { env: { ...process.env, CLAUDIA_LOCAL_HOME: home, CLAUDIA_LOCAL_PORT: port }, stdio: ["ignore", "pipe", "inherit"] });
child.stdout.on("data", d => process.stdout.write(d));

const fail = (msg) => { console.error(`SMOKE FAILED: ${msg}`); child.kill(); rmSync(home, { recursive: true, force: true }); process.exit(1); };
const get = (path, opts = {}) => fetch(base + path, { signal: AbortSignal.timeout(5000), ...opts });

let up = false;
for (let i = 0; i < 80 && !up; i++) {
  await new Promise(r => setTimeout(r, 250));
  up = await get("/api/health").then(r => r.ok).catch(() => false);
}
if (!up) fail("the server didn't answer /api/health within 20 s");
const h = await (await get("/api/health")).json();
if (h.version !== version) fail(`/api/health says ${h.version}, package.json says ${version}`);
// fetch can't set Host, so ask with node:http: a page on another name (DNS rebinding) must be refused.
const foreign = await new Promise(res => request({ host: "127.0.0.1", port, path: "/api/health", headers: { host: `evil.example:${port}` } }, r => { r.resume(); res(r.statusCode); }).on("error", () => res(0)).end());
if (foreign !== 421) fail(`a foreign Host header got ${foreign}, not 421`);

const setup = await get("/api/setup", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ passphrase: "smoke-test-passphrase", confirm: "smoke-test-passphrase" }) });
if (!setup.ok) fail(`setup answered ${setup.status}: ${await setup.text()}`);
const cookie = (setup.headers.get("set-cookie") || "").split(";")[0];
const state = await (await get("/api/state", { headers: { cookie } })).json();
if (!state.setup || !state.unlocked) fail(`unexpected state ${JSON.stringify(state)}`);
const report = await get("/api/health/report?online=0", { headers: { cookie } });
if (!report.ok) fail(`health report answered ${report.status}`);
const { checks } = await report.json();
const bound = checks.find(c => c.id === "bound");
if (bound?.status !== "ok") fail(`bound check: ${JSON.stringify(bound)}`);
const page = await get("/");
if (!page.ok || !(await page.text()).includes("<div id=\"root\"")) console.warn("Note: the dashboard isn't built (run npm run build); the API is fine.");

console.log(`SMOKE OK: Claudia Local ${version} on ${base}, ${checks.length} health checks, listening on 127.0.0.1 only.`);
child.kill();
await new Promise(r => child.once("exit", r));
rmSync(home, { recursive: true, force: true });
