/**
 * campaigns.js — "Launch day for $XYZ" and friends.
 *
 * A campaign is a plan: a handful of posts spread over time, some with media. Planning creates
 *   - one social draft per post, already scheduled, waiting in Socials → Approvals,
 *   - one media request per picture or clip, also waiting in Approvals (nothing is generated or paid
 *     for until you approve it; when the job finishes, its file is attached to its draft).
 * Nothing publishes without your approval.
 *
 * Planners: "agent" asks your chat model for the plan (JSON), "template" uses the built-in outlines
 * below and needs no model. Add your own outline to TEMPLATES.
 */
import { P } from "./paths.js";
import { getConfig, readJsonFile, writeJsonFile, newId } from "./store.js";
import { chatClient } from "./model.js";
import * as S from "./studio-social.js";
import * as M from "./studio-media.js";
import * as studio from "./studio.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const H = 3600_000;

/** Outlines: offsets are minutes from the campaign's start (launch time for "launch"). {coin} {goal} are filled in. */
export const TEMPLATES = {
  launch: { label: "Launch day", posts: [
    { at: -24 * 60, text: "Something new lands on Claudia tomorrow: {coin}. {goal}", media: null },
    { at: -60, text: "One hour until {coin} goes live on Claudia.", media: null },
    { at: 0, text: "{coin} is live on Claudia. {goal}", media: { kind: "image", prompt: "{brand} celebrating the launch of {coin}, bold poster, the ticker {coin} in large type", aspect: "16:9" } },
    { at: 3 * 60, text: "Thanks to everyone who came by for {coin}'s launch. Here's what happens next.", media: null },
    { at: 24 * 60, text: "Day one with {coin}: a short recap.", media: { kind: "image", prompt: "{brand} with a recap board for {coin}, warm and friendly", aspect: "1:1" } },
  ] },
  week: { label: "One week of posts", posts: Array.from({ length: 7 }, (_, i) => ({ at: i * 24 * 60, text: i === 0 ? "This week on Claudia: {coin}. {goal}" : `Day ${i + 1} with {coin}: {goal}`, media: i % 3 === 0 ? { kind: "image", prompt: "{brand} talking about {coin}, day " + (i + 1), aspect: "1:1" } : null })) },
};

export const list = () => readJsonFile(P.campaigns, []);
export const get = (id) => list().find((c) => c.id === id) || null;

export function remove(id) {
  writeJsonFile(P.campaigns, list().filter((c) => c.id !== id));
  return { ok: true };
}

const fill = (s, v) => String(s || "").replace(/\{coin\}/g, v.coin).replace(/\{goal\}/g, v.goal).replace(/\{brand\}/g, studio.getBrand().name || "A creator").replace(/\s+/g, " ").trim();

async function planWithAgent(v) {
  const cfg = getConfig();
  const c = chatClient(cfg, { temperature: 0.7, maxTokens: 3000 });
  if (c.error) throw err(409, c.error);
  const brand = studio.getBrand();
  const sys = [
    `You plan social media campaigns for ${brand.name || "the user's brand"}. Coins mentioned are launched on Claudia (a Solana-first launchpad). Write in the brand's voice.`,
    brand.style ? `Tone guide:\n${brand.style.slice(0, 2000)}` : "",
    brand.topics?.length ? `Topics the brand covers: ${brand.topics.join(", ")}.` : "",
    brand.banned.length ? `Never use: ${brand.banned.join(", ")}.` : "",
    "Rules: never promise prices, returns or gains. No 'to the moon', no financial advice. Plain, warm, short. Each post fits on X (under 270 characters).",
    `Answer with JSON only: {"posts":[{"at": minutes from the start (can be negative for teasers), "text": "...", "media": null or {"kind":"image"|"video","prompt":"...","aspect":"1:1"|"16:9"|"9:16"}}]}. At most ${v.maxPosts} posts; media on at most ${v.maxMedia} of them.`,
  ].filter(Boolean).join("\n\n");
  const user = `Campaign: ${v.name}\nCoin: ${v.coin || "(none)"}\nGoal: ${v.goal || "(not given)"}\nLength: ${v.days} day(s) from the start.\nNotes: ${v.notes || "(none)"}`;
  const text = await c.client.complete([{ role: "system", content: sys }, { role: "user", content: user }]);
  const m = text.match(/\{[\s\S]*\}/);
  let j;
  try { j = JSON.parse(m ? m[0] : text); } catch { throw err(502, "The model's plan wasn't valid JSON. Try again, or use the template planner."); }
  if (!Array.isArray(j.posts) || !j.posts.length) throw err(502, "The model didn't return any posts. Try again, or use the template planner.");
  return j.posts;
}

/**
 * Plan a campaign. Input: { name, coin, goal, notes, template: "launch"|"week", planner: "agent"|"template",
 *   accounts: [ids or networks], startAt (ms), days, withMedia: boolean }
 */
export async function plan(x = {}) {
  const v = {
    name: String(x.name || "").trim().slice(0, 80) || "Campaign",
    coin: String(x.coin || "").trim().slice(0, 20),
    goal: String(x.goal || "").trim().slice(0, 400),
    notes: String(x.notes || "").trim().slice(0, 1000),
    days: Math.max(1, Math.min(14, Math.round(Number(x.days) || 2))),
    maxPosts: 12, maxMedia: x.withMedia === false ? 0 : 4,
  };
  if (v.coin && !/^\$?[A-Za-z0-9]{1,13}$/.test(v.coin)) throw err(400, "The coin should be a ticker like $XYZ.");
  if (v.coin && !v.coin.startsWith("$")) v.coin = "$" + v.coin.toUpperCase();
  const startAt = Number(x.startAt) || Date.now() + 26 * H;
  if (startAt < Date.now() - 60_000) throw err(400, "Pick a start time in the future.");

  const s = await S.social();
  const accounts = studio.resolveAccounts(s, x.accounts);
  const mediaOk = (await M.status()).installed && v.maxMedia > 0;

  const raw = x.planner === "agent" ? await planWithAgent(v) : (TEMPLATES[x.template] || TEMPLATES.launch).posts;
  const items = raw.slice(0, v.maxPosts).map((p) => ({
    at: Math.max(Date.now() + 5 * 60_000, startAt + Math.round(Number(p.at) || 0) * 60_000),
    text: fill(p.text, v).slice(0, 2000),
    media: p.media && mediaOk ? { kind: p.media.kind === "video" ? "video" : "image", prompt: fill(p.media.prompt, v).slice(0, 1500), aspect: ["1:1", "16:9", "9:16"].includes(p.media.aspect) ? p.media.aspect : "1:1" } : null,
  })).filter((p) => p.text);

  const camp = { id: newId("cmp_"), name: v.name, coin: v.coin, goal: v.goal, planner: x.planner === "agent" ? "agent" : "template", startAt, createdAt: Date.now(), accounts, items: [], problems: [] };
  let mediaLeft = v.maxMedia;
  for (const p of items) {
    const it = { at: p.at, text: p.text, postId: null, requestId: null };
    try {
      const post = await studio.draftForApproval({ text: p.text, accounts, scheduleAt: p.at, labels: { ai: true, nfa: !!v.coin } }, "campaign");
      it.postId = post.id;
    } catch (e) { camp.problems.push(`Post "${p.text.slice(0, 40)}…": ${e.message}`); }
    if (p.media && it.postId && mediaLeft-- > 0) {
      try {
        const r = await studio.addRequest({ source: "campaign", request: { ...p.media, brand: true }, note: `${v.name}: ${p.text.slice(0, 80)}`, campaignId: camp.id, postId: it.postId });
        it.requestId = r.id;
      } catch (e) { camp.problems.push(`Media for "${p.text.slice(0, 40)}…": ${e.message}`); }
    }
    camp.items.push(it);
  }
  writeJsonFile(P.campaigns, [camp, ...list()].slice(0, 200));
  studio.logAction("campaign", `Planned campaign "${v.name}": ${camp.items.filter((i) => i.postId).length} drafts, ${camp.items.filter((i) => i.requestId).length} media requests, all waiting in Approvals`, { campaignId: camp.id });
  return camp;
}
