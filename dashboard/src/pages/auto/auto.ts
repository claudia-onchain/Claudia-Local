// Tasks, approvals, templates and Telegram: shared types and live events from the server ({ type: "auto" }).
import { useEffect, useRef } from "react";
import { bus } from "../../lib";

export type Budget = { maxRounds: number; maxToolCalls: number };
export type Task = {
  id: string; name: string; prompt: string; schedule: string; scheduleLabel: string; scheduleError: string | null; model: string; tools: string[]; skills: string[];
  budget: Budget; delivery: { telegram: boolean; file: string }; allowPost: boolean; enabled: boolean; template: string | null;
  lastRun: { at: number; status: string; runId?: string; summary: string } | null; nextRun: number | null; upcoming: number[]; running: boolean; createdAt: number;
};
export type RunEntry = { id: string; taskId: string; name: string; trigger: string; status: string; startedAt: number; endedAt: number; summary: string; toolCalls: number; tokens: number; approvals: number };
export type RunEvent = { t: number; type: "text" | "tool" | "result" | "error" | "notice" | "approval"; text?: string; name?: string; args?: string; error?: boolean; id?: string };
export type Run = RunEntry & { origin: string; events: RunEvent[]; usage: { prompt: number; completion: number }; delivered: string[]; approvals: string[] };
export type Budgets = { runsPerDay: number; toolCallsPerDay: number; postsPerDay: number; tokensPerDay: number; usdPerDay: number };
export type Autonomy = {
  stopped: boolean; stopFile: boolean; stopFilePath: string; budgets: Budgets; used: { runs: number; toolCalls: number; posts: number; tokens: number };
  spendToday: number | null; spendEstimate: boolean; unlocked: boolean;
  heartbeat: { enabled: boolean; everyMinutes: number; telegram: boolean; lastRun: number | null; nextRun: number | null; running: boolean };
  running: { id: string; runId: string; startedAt: number }[];
};
export type TasksData = { tasks: Task[]; autonomy: Autonomy; defaults: { tools: string[] }; pending: number };
export type Approval = {
  id: string; kind: "question" | "thread_post" | "social_post" | "trade"; status: "pending" | "confirm" | "answered" | "denied" | "done" | "failed" | "expired" | "canceled";
  question: string; options: string[]; allowCustom: boolean; detail: any; source: string; origin: string; taskId: string | null; createdAt: number; expiresAt: number;
  answer?: { answers: string[]; custom?: string; by: string; at: number }; result?: string; preview?: any; previewText?: string;
};
export type Template = { id: string; name: string; summary: string; niches?: { id: string; name: string }[]; skills: string[]; starterTasks: { name: string; prompt: string; schedule: string }[]; persona: string };
export type Watcher = {
  id: string; name: string; type: "price" | "volume" | "thread" | "inbox"; token?: string; room?: string; thresholdPct?: number; everyMinutes: number; cooldownMinutes: number;
  taskId: string | null; enabled: boolean; lastCheck: number; lastFired: number; lastError: string | null;
};
export type Telegram = {
  tokenSet: boolean; enabled: boolean; bot: { id: number; username: string; name: string } | null; polling: boolean; lastOk: number | null; error: string | null;
  owners: { id: string; name: string; pairedAt: number }[]; pairing: { code: string; expiresAt: number } | null; voice: { openai: boolean; groq: boolean };
};

export type AutoEvent = { topic: "task" | "run" | "run_started" | "run_event" | "autonomy" | "approval" | "telegram"; data: any };
export function useAutoEvents(cb: (e: AutoEvent) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const f = (e: Event) => ref.current((e as CustomEvent).detail as AutoEvent);
    bus.addEventListener("auto", f);
    return () => bus.removeEventListener("auto", f);
  }, []);
}

export const RUN_STATUS: Record<string, string> = { ok: "Done", error: "Failed", stopped: "Stopped", budget: "Hit its budget", skipped: "Skipped" };
export const runTone = (s: string) => (s === "ok" ? "ok" : s === "error" ? "bad" : s === "budget" || s === "skipped" ? "copper" : "");
export const KIND: Record<string, string> = { question: "Question", thread_post: "Thread post", social_post: "Social post", trade: "Trade" };
export const SOURCE: Record<string, string> = { chat: "Chat", task: "Task", heartbeat: "Heartbeat", watcher: "Watcher", telegram: "Telegram" };

export const fmtTime = (t?: number | null) => (t ? new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");
