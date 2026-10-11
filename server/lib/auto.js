/**
 * auto.js — wires up everything that runs on its own: the approval bus, the headless runner, tasks,
 * the heartbeat, watchers and Telegram. index.js calls init() once, onLock() when the app locks and
 * close() on shutdown.
 *
 * One scheduler tick every 30 s while unlocked and not stopped: due tasks, the heartbeat, then watchers.
 * Dashboard events go out on the WebSocket as { type: "auto", topic, data } (topics: task, run,
 * run_started, run_event, autonomy, approval, telegram).
 */
import * as approvals from "./approvals.js";
import * as runner from "./runner.js";
import * as tasks from "./tasks.js";
import * as watchers from "./watchers.js";
import * as telegram from "./telegram.js";
import * as vault from "./vault.js";

let timer = null;

export function init({ agent, tools, broadcast, log }) {
  runner.init(agent);
  approvals.init();
  approvals.on((ev, item) => { try { broadcast({ type: "auto", topic: "approval", data: { event: ev, item } }); } catch { /* */ } });
  tasks.wire({ broadcast, log, tools, notify: (text) => telegram.notify(text) });
  tasks.init();
  tasks.watchStopFile();
  telegram.init({ log, broadcast });
  timer = setInterval(() => {
    if (!vault.isUnlocked()) return;
    try { tasks.tick(); } catch (e) { log(`[tasks] tick: ${e.message}`); }
    watchers.tick().catch((e) => log(`[watchers] ${e.message}`));
  }, 30_000);
  timer.unref();
}

/** The app locked: stop runs and Telegram now (they can't reach the keys anyway). */
export function onLock() {
  tasks.abortAll();
  telegram.stop();
}

export function close() {
  clearInterval(timer);
  onLock();
}
