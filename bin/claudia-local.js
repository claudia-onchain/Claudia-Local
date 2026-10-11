#!/usr/bin/env node
// claudia-local            start the local server (127.0.0.1 only) and open the dashboard in your browser.
// claudia-local doctor     check this install (network exposure, Node, lock, MCP, keys, skills, risky settings, version).
// claudia-local --version  print the version.
//
// Data lives in ~/.claudia-local (or CLAUDIA_LOCAL_HOME), never in the package folder, so `npm i -g` upgrades
// and `npx` runs keep your vault, chats and memory. The port is CLAUDIA_LOCAL_PORT (default 3939).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { existsSync, readFileSync } from "node:fs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;
const port = process.env.CLAUDIA_LOCAL_PORT || "3939";
const url = `http://127.0.0.1:${port}`;
const cmd = process.argv[2] || "";

const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(`Claudia Local needs Node.js 22.13 or newer. You have ${process.versions.node}.\nGet it at https://nodejs.org (LTS), then run this again.`);
  process.exit(1);
}

if (cmd === "--version" || cmd === "-v" || cmd === "version") { console.log(version); process.exit(0); }
if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(`Claudia Local ${version}

  claudia-local            start it and open ${url}
  claudia-local doctor     check this install (add --offline to skip the release check)
  claudia-local --version  print the version

  CLAUDIA_LOCAL_PORT       port (default 3939)
  CLAUDIA_LOCAL_HOME       data folder (default ~/.claudia-local)
  CLAUDIA_LOCAL_NO_OPEN=1  don't open the browser`);
  process.exit(0);
}

if (cmd === "doctor") {
  // Any HTTP answer on a network address counts as exposed, even the 421 the Host check sends back.
  const answers = (u, any = false) => fetch(`${u}/api/health`, { signal: AbortSignal.timeout(900) }).then(r => any || r.ok).catch(() => false);
  const running = await answers(url);
  const exposed = [];
  if (running) {
    for (const list of Object.values(networkInterfaces())) for (const a of list || []) {
      if (a.internal) continue;
      const host = a.family === "IPv6" || a.family === 6 ? `[${a.address.split("%")[0]}]` : a.address;
      if (await answers(`http://${host}:${port}`, true)) exposed.push(`${host}:${port}`);
    }
  }
  const { runChecks } = await import(new URL("../server/lib/health.js", import.meta.url));
  const { HOME } = await import(new URL("../server/lib/paths.js", import.meta.url));
  const { checks, summary } = await runChecks({ exposed, running, version, unlocked: null, online: !process.argv.includes("--offline") });
  const tag = { ok: "OK  ", warn: "WARN", bad: "BAD ", info: "INFO" };
  console.log(`Claudia Local ${version} · ${running ? `running on ${url}` : "not running"} · data: ${HOME}\n`);
  for (const c of checks) console.log(`${tag[c.status]}  ${c.label}: ${c.detail}${c.fix ? `\n      Fix in the app (Health page): ${c.fix.label}` : ""}`);
  console.log(`\n${summary.bad ? `${summary.bad} problem${summary.bad > 1 ? "s" : ""}` : "No problems"}${summary.warn ? `, ${summary.warn} warning${summary.warn > 1 ? "s" : ""}` : ""}.`);
  process.exit(summary.bad ? 1 : 0);
}

if (cmd) { console.error(`Unknown command: ${cmd}. Try claudia-local --help`); process.exit(2); }

if (!existsSync(join(root, "dashboard", "dist", "index.html"))) {
  console.error("The dashboard isn't built. In a source checkout, run: npm run build");
  process.exit(1);
}

const isUp = () => fetch(`${url}/api/health`, { signal: AbortSignal.timeout(900) }).then(r => r.ok).catch(() => false);
const open = () => {
  if (process.env.CLAUDIA_LOCAL_NO_OPEN === "1") return;
  // Windows: "start" via cmd (explorer.exe can't open a URL with a port reliably everywhere).
  const [bin, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(bin, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref(); } catch { /* no browser opener */ }
};

if (await isUp()) {
  console.log(`Claudia Local is already running: ${url}`);
  open();
} else {
  const child = spawn(process.execPath, [join(root, "server", "index.js")], { stdio: "inherit", env: { ...process.env, CLAUDIA_LOCAL_PORT: port } });
  let up = false;
  for (let i = 0; i < 120 && !up && child.exitCode === null; i++) {
    await new Promise(r => setTimeout(r, 250));
    up = await isUp();
  }
  if (up) { console.log(`\n  Claudia Local ${version}: ${url}\n  Press Ctrl+C to stop.\n`); open(); }
  const stop = () => { try { child.kill("SIGTERM"); } catch { /* */ } };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", code => process.exit(code ?? 0));
}
