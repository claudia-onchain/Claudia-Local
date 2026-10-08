// Creator studio: shared types (mirroring @useclaudia/media and @useclaudia/social), live events and helpers.
import { useEffect, useRef } from "react";
import { bus } from "./lib";

export type MediaKind = "image" | "video" | "speech" | "music" | "sfx" | "avatar";
export type ModelInfo = { id: string; provider: string; kind: MediaKind; label: string; caps: Record<string, any>; priceHint?: string; retired?: boolean };
export type Estimate = { usd: number; low?: number; high?: number; basis: string; confidence: "exact" | "list" | "estimate" };
export type JobStatus = "needs_approval" | "queued" | "running" | "downloading" | "succeeded" | "failed" | "blocked" | "expired" | "canceled";
export type MediaOutput = { path: string; mime: string; bytes: number; width?: number; height?: number; durationSec?: number; sha256: string };
export type Job = {
  id: string; status: JobStatus; request: any; model: string; provider: string; estimate: Estimate; createdAt: number; updatedAt: number; progress?: number;
  outputs: MediaOutput[]; error?: { code: string; message: string; hint?: string };
  provenance: { prompt?: string; model: string; provider: string; costUsd?: number; watermark?: string; terms?: string; at: number };
};
export type DryRun = { dryRun: true; request?: { method: string; url: string; headers: Record<string, string>; body?: unknown }; requests?: any[]; estimate?: Estimate };
export type MediaRequest = { id: string; source: "agent" | "mcp" | "campaign"; request: any; estimate: Estimate | null; note: string; campaignId?: string; postId?: string; status: "pending" | "approved" | "rejected"; jobId?: string; createdAt: number };
export type Limits = { perJobUsd: number; perDayUsd: number; perMonthUsd: number; approveAboveUsd: number };
export type Spend = { today: number; month: number; byProvider: Record<string, { today: number; month: number }> };

export type NetworkId = string;
export type NetworkInfo = {
  id: NetworkId; name: string; tier: "direct" | "service" | "v2" | "later" | "skip"; auth: "oauth-loopback" | "oauth-relay" | "key" | "service";
  caps: Record<string, boolean>; limits: { maxChars?: number; maxImages?: number; maxVideoMb?: number; perDay?: number }; costHint?: string; setup: string; docs: string;
};
export type Account = { id: string; network: NetworkId; handle: string; name?: string; avatar?: string; connectedAt: number; expiresAt?: number; via?: NetworkId };
export type PostInput = {
  text: string; media?: { path: string; mime?: string; alt?: string }[]; link?: string; thread?: string[]; replyTo?: { network: string; id: string };
  targets: { account: string; text?: string }[]; scheduleAt?: number; labels?: { ai?: boolean; ad?: boolean; nfa?: boolean }; options?: Record<string, Record<string, unknown>>;
};
export type PostStatus = "draft" | "pending_approval" | "approved" | "scheduled" | "publishing" | "published" | "partial" | "failed" | "canceled";
export type Post = { id: string; status: PostStatus; input: PostInput; createdAt: number; updatedAt: number; results: { account: string; network: NetworkId; status: string; url?: string; remoteId?: string; error?: string; at?: number }[] };
export type Preview = { account: string; network: NetworkId; text: string; chars: number; media: number; labelsAdded: string[]; costUsd?: number; warnings: string[]; blocked?: string };
export type PkgStatus = { installed: boolean; package: string; version?: string | null; install?: string; error?: string };
export type StudioStatus = { media: PkgStatus; social: PkgStatus; killSwitch: { posting: boolean; drafts: boolean }; askBeforeAgentMedia: boolean; redirects: { loopback: string; relay: string } };
export type Brand = { id: string; name: string; refs: string[]; voice: { provider: string; voiceId: string }; style: string; banned: string[]; useInChat: boolean; useInSocial: boolean };

/** Live studio events from the server (job progress, drafts, connections, kill switch). */
export type StudioEvent = { topic: "job" | "post" | "account" | "request" | "kill"; data: any };
export function useStudioEvents(cb: (e: StudioEvent) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const f = (e: Event) => ref.current((e as CustomEvent).detail as StudioEvent);
    bus.addEventListener("studio", f);
    return () => bus.removeEventListener("studio", f);
  }, []);
}

/** URL for a file in the studio library, uploads or brand kit (served by the local server only). */
export const fileUrl = (path: string) => `/api/studio/file?path=${encodeURIComponent(path)}`;
export const isImage = (mime?: string, path?: string) => (mime ? mime.startsWith("image/") : /\.(png|jpe?g|webp|gif)$/i.test(path || ""));
export const isVideo = (mime?: string, path?: string) => (mime ? mime.startsWith("video/") : /\.(mp4|mov|webm)$/i.test(path || ""));
export const isAudio = (mime?: string, path?: string) => (mime ? mime.startsWith("audio/") : /\.(mp3|wav|m4a|ogg)$/i.test(path || ""));

export async function upload(file: File, to?: "brand"): Promise<{ path: string; mime: string; bytes: number }> {
  const res = await fetch(`/api/studio/uploads${to ? `?to=${to}` : ""}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file, credentials: "same-origin" });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);
  return data;
}

export function money(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  if (n === 0) return "$0";
  return n < 1 ? `$${n.toFixed(3).replace(/0$/, "")}` : `$${n.toFixed(2)}`;
}

export const KIND_LABEL: Record<MediaKind, string> = { image: "Image", video: "Video", speech: "Speech", music: "Music", sfx: "Sound effect", avatar: "Avatar" };
export const STATUS_LABEL: Record<string, string> = {
  needs_approval: "Needs your OK", queued: "Queued", running: "Making", downloading: "Saving", succeeded: "Done", failed: "Failed", blocked: "Blocked", expired: "Expired", canceled: "Canceled",
  draft: "Draft", pending_approval: "Waiting for you", approved: "Approved", scheduled: "Scheduled", publishing: "Publishing", published: "Published", partial: "Partly published",
};
export const statusTone = (s: string) => (["succeeded", "published"].includes(s) ? "ok" : ["failed", "blocked", "expired"].includes(s) ? "bad" : ["needs_approval", "pending_approval"].includes(s) ? "brand" : ["scheduled", "approved", "running", "downloading", "queued", "publishing"].includes(s) ? "info" : "");

/** "in 3 h", "in 52 days", "2 h ago" */
export function when(t?: number) {
  if (!t) return "";
  const d = t - Date.now(), a = Math.abs(d);
  const s = a < 3600_000 ? `${Math.max(1, Math.round(a / 60_000))} min` : a < 86400_000 ? `${Math.round(a / 3600_000)} h` : `${Math.round(a / 86400_000)} day${Math.round(a / 86400_000) === 1 ? "" : "s"}`;
  return d > 0 ? `in ${s}` : `${s} ago`;
}
export const fmtDate = (t?: number) => (t ? new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
/** For <input type="datetime-local"> */
export const toLocalInput = (t?: number) => { if (!t) return ""; const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
export const fromLocalInput = (s: string) => (s ? new Date(s).getTime() : undefined);
