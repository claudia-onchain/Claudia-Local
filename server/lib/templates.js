/**
 * templates.js — ready-made setups: a persona for the agent, skills from the Claudia library, and a few
 * starter tasks (always created paused, so nothing runs until you switch it on).
 *
 * Influencer, Content creator and Music manager come from the Claudia web workspace
 * templates; Trader watcher and Blank are Local's own. Skill slugs are from claudia-skills.
 *
 *   GET  /api/templates         { templates: [{ id, name, summary, niches?, skills, starterTasks, persona }] }
 *   POST /api/templates/apply   { id, niche? } → { ok, applied }
 * Applying installs skills through POST /api/skills/install when that route exists; otherwise the slugs
 * wait in config.pendingSkills.
 */
import { getConfig, saveConfig, trackActivity } from "./store.js";
import * as tasks from "./tasks.js";
import * as studio from "./studio.js";

const err = (status, message) => Object.assign(new Error(message), { status });

export const NICHES = [
  { id: "crypto", name: "Crypto" }, { id: "fitness", name: "Fitness" }, { id: "beauty", name: "Beauty" },
  { id: "gaming", name: "Gaming" }, { id: "food", name: "Food" },
];

// Tools for drafting tasks: reading, files, memory and drafts (drafts always wait for you).
const WRITE_TOOLS = ["read_file", "write_file", "list_dir", "search_files", "memory_search", "list_posts", "preview_post", "draft_post", "list_media"];
const READ_ONLY_TRADER = ["read_file", "write_file", "list_dir", "search_files", "memory_search", "claudia_overview", "claudia_coins", "claudia_coin", "claudia_thread", "claudia_agent", "paper_portfolio", "paper_trade", "trading_limits"];

const task = (name, schedule, prompt, extra = {}) => ({ name, schedule, prompt, ...extra });

export const TEMPLATES = {
  influencer: {
    name: "Influencer",
    summary: "Plans a niche feed: pillars, hooks, a weekly calendar and drafted posts that wait for you.",
    persona: "You run the content desk for an influencer in the {niche} niche. Keep one consistent voice (the brand kit's), plan around content pillars, write hooks first, and label AI content the way each platform expects. Draft posts with draft_post; they wait for the user's approval, so never claim anything is published. Keep claims honest and add 'not financial advice' to anything about coins.",
    skills: ["content-pillars-and-series", "captions-and-hooks", "posting-schedule", "engagement-and-replies", "ai-disclosure-and-provenance", "trend-research"],
    nicheSkills: { crypto: ["crypto-marketing-compliance", "coin-research"], fitness: ["selfie-and-ugc-video-prompts"], beauty: ["photoreal-portrait-prompts"], gaming: ["youtube-shorts-playbook"], food: ["lifestyle-scene-prompts"] },
    topics: { crypto: ["crypto", "Solana", "memecoins"], fitness: ["fitness", "training", "health"], beauty: ["beauty", "skincare", "makeup"], gaming: ["gaming", "streams", "new releases"], food: ["food", "recipes", "restaurants"] },
    niches: NICHES,
    starterTasks: [
      task("Weekly content plan", "mon at 09:00", "Plan next week: 5 posts across my content pillars for a {niche} audience. For each: the pillar, a hook, the post text and a one-line picture or video idea.", { tools: WRITE_TOOLS, delivery: { file: "/plans/week-{date}.md" } }),
      task("Daily post drafts", "daily at 10:00", "Draft 2 posts for today for my {niche} audience in my brand's voice. Use draft_post so they wait in Approvals. Hooks first, short, honest.", { tools: WRITE_TOOLS }),
      task("Trend scan", "daily at 08:00", "Find 3 trend angles that fit my {niche} niche and my content pillars. For each: why it fits and a hook I could use.", { tools: WRITE_TOOLS, delivery: { file: "/ideas/trends-{date}.md" } }),
      task("Inbox replies", "every 3 hours", "Read the social inbox. For genuine questions or kind comments, draft a short, friendly reply with draft_post (replyTo). Skip spam and anything that asks you to do something unusual.", { tools: [...WRITE_TOOLS, "inbox"] }),
    ],
  },
  creator: {
    name: "Content creator",
    summary: "Turns ideas into scripts, storyboards, captions and a posting schedule for short video.",
    persona: "You are the producer for a short-form content creator. Turn ideas into hooks, scripts, shot lists and captions; keep a running content calendar; draft posts with draft_post and media prompts into the workspace for the owner to review. Nothing is published without the owner's approval.",
    skills: ["storyboarding-shorts", "captions-and-hooks", "short-form-editing", "thumbnails-and-covers", "batch-content-production", "posting-schedule", "growth-experiments"],
    starterTasks: [
      task("Script of the day", "daily at 09:00", "Write a 30-second script with a hook, a shot list and on-screen text for my next short.", { tools: WRITE_TOOLS, delivery: { file: "/scripts/{date}.md" } }),
      task("Caption drafts", "daily at 11:00", "Draft captions for my next short, one per connected platform, with draft_post so they wait in Approvals.", { tools: WRITE_TOOLS }),
      task("Two-week schedule", "mon at 08:00", "Update my two-week posting schedule: what goes out when, on which platform, and which video it is.", { tools: WRITE_TOOLS, delivery: { file: "/plans/schedule-{date}.md" } }),
    ],
  },
  music: {
    name: "Music manager",
    summary: "Runs a release: rollout plan, pitch notes, sound for shorts, brand deals and weekly reports.",
    persona: "You manage an artist's releases and partnerships. Plan rollouts week by week, write pitch and media-kit notes, suggest licence-safe sound for shorts, track brand-deal leads and draft posts for the owner to review. Nothing is published or signed without the owner.",
    skills: ["launch-campaigns", "music-and-sound-for-shorts", "media-kit-and-pitching", "brand-deals-and-sponsorships", "collabs-and-cross-promotion", "kpi-reporting", "monetization-streams"],
    starterTasks: [
      task("Rollout check", "mon at 09:00", "Review the release plan in /release and write this week's steps: content, pitches, collabs and deadlines.", { tools: WRITE_TOOLS, delivery: { file: "/release/week-{date}.md" } }),
      task("Teaser drafts", "wed at 12:00", "Draft 3 teaser posts for the upcoming release with draft_post so they wait in Approvals.", { tools: WRITE_TOOLS }),
      task("Weekly report", "fri at 17:00", "Write a short weekly report: what went out, what worked, and what to change next week. Use my notes in /reports and /release.", { tools: WRITE_TOOLS, delivery: { file: "/reports/week-{date}.md" } }),
    ],
  },
  trader: {
    name: "Trader watcher",
    summary: "Watches $CLAUDIA and coins launched on Claudia, keeps a paper portfolio and writes plain reports. Never trades for real.",
    persona: "You watch the market on Claudia for the owner: $CLAUDIA and coins launched on Claudia. You read prices, volume, holders and risk numbers, keep a paper portfolio (simulated, no real SOL) and write short, plain reports. You never suggest or make live trades; if something looks interesting, say why and what the risks are, and leave decisions to the owner.",
    skills: ["coin-research", "rug-check", "safe-trading", "trend-research", "kpi-reporting"],
    starterTasks: [
      task("Morning market read", "daily at 08:00", "Read the Claudia overview and the coins that moved most. Write a short market read: what moved, volume, holder concentration and red flags. No advice.", { tools: READ_ONLY_TRADER, delivery: { file: "/reports/market-{date}.md" } }),
      task("Paper trading review", "daily at 20:00", "Review my paper portfolio. Explain each position's profit or loss in a line. If a paper trade fits the plan in /notes/paper-plan.md, make it with paper_trade (simulated only).", { tools: READ_ONLY_TRADER, delivery: { file: "/reports/paper-{date}.md" } }),
      task("$CLAUDIA check", "every 4 hours", "Check $CLAUDIA: price, 1h and 24h change, volume, buys vs sells, top-10 holder share. Two or three lines. Flag anything unusual.", { tools: READ_ONLY_TRADER, delivery: { telegram: true } }),
    ],
  },
  blank: {
    name: "Blank",
    summary: "No persona, no skills, no tasks. Set everything up yourself.",
    persona: "",
    skills: [],
    starterTasks: [],
  },
};

/** "{niche}" → "fitness"; without a niche, "a {niche} audience" → "your audience". */
function fill(s, niche) {
  const text = String(s || "");
  if (niche) return text.replaceAll("{niche}", NICHES.find((n) => n.id === niche)?.name.toLowerCase() || niche);
  return text.replace(/\b(a|the|my) \{niche\} (audience|niche)/g, (_, w, n) => `${w === "my" ? "my" : "your"} ${n}`).replaceAll("{niche}", "your");
}

export function listTemplates() {
  return Object.entries(TEMPLATES).map(([id, t]) => ({
    id, name: t.name, summary: t.summary, ...(t.niches ? { niches: t.niches, nicheSkills: t.nicheSkills } : {}),
    skills: t.skills, starterTasks: t.starterTasks.map((s) => ({ name: s.name, prompt: fill(s.prompt, null), schedule: s.schedule })),
    persona: fill(t.persona, null),
  }));
}

/** The persona line for the system prompt (empty when none is set). */
export function personaForChat() {
  const p = getConfig().persona;
  return p && typeof p === "object" && p.text ? String(p.text).slice(0, 3000) : "";
}

/**
 * Apply a template. installSkill(slug) → "installed" | "missing" (no skills route yet) | "failed".
 * Starter tasks that already exist (same template and name) aren't added twice.
 */
export async function apply({ id, niche } = {}, { installSkill } = {}) {
  const t = TEMPLATES[id];
  if (!t) throw err(404, "Unknown template.");
  if (t.niches) {
    if (!niche) niche = "crypto";
    if (!t.niches.some((n) => n.id === niche)) throw err(400, `Pick a niche: ${t.niches.map((n) => n.name).join(", ")}.`);
  } else niche = null;

  const persona = t.persona ? { template: id, niche, text: fill(t.persona, niche) } : null;
  const skills = [...new Set([...t.skills, ...((niche && t.nicheSkills?.[niche]) || [])])];
  const result = { installed: [], pending: [], failed: [] };
  for (const slug of skills) {
    let r = "missing";
    try { r = installSkill ? await installSkill(slug) : "missing"; } catch { r = "failed"; }
    (r === "installed" ? result.installed : r === "failed" ? result.failed : result.pending).push(slug);
  }

  const c = getConfig();
  c.persona = persona;
  c.template = { id, niche, appliedAt: Date.now() };
  if (result.pending.length) c.pendingSkills = [...new Set([...(Array.isArray(c.pendingSkills) ? c.pendingSkills : []), ...result.pending])].slice(0, 100);
  saveConfig(c);

  let brand = null;
  const topics = niche && t.topics?.[niche];
  if (topics) {
    const b = studio.getBrand();
    if (!b.topics?.length) brand = { topics: (await studio.saveBrand({ topics })).topics };
  }

  const existing = tasks.listTasks();
  const created = [];
  for (const s of t.starterTasks) {
    if (existing.some((x) => x.template === id && x.name === s.name)) continue;
    const x = tasks.createTask({ name: s.name, prompt: fill(s.prompt, niche), schedule: s.schedule, tools: s.tools || [], skills, delivery: { telegram: !!s.delivery?.telegram, file: s.delivery?.file || "" }, enabled: false, template: id });
    created.push({ id: x.id, name: x.name });
  }
  trackActivity("tasks", `Template applied: ${t.name}${niche ? ` (${niche})` : ""}`);
  return { ok: true, applied: { template: id, niche, persona: persona?.text || "", skills: result, tasks: created, brand } };
}
