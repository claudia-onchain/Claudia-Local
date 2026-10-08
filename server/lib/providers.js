/**
 * providers.js — every outside service you can plug your own key into, in one list.
 *
 * Claudia Local hosts no keys: you bring your own for everything (media models, chat models, social
 * networks, posting services, developer apps). Keys live in the encrypted vault (vault.js → `keys`),
 * the dashboard only ever sees "set" + the last 4 characters, and the media / social packages read
 * them through a KeyProvider (createKeyProvider below).
 *
 * ── Adding a provider ──────────────────────────────────────────────────────
 * Add one entry to PROVIDERS:
 *   id       short id, also the vault name of its first field ("google")
 *   group    "media" | "chat" | "social" | "service" | "app" (where Settings lists it)
 *   name     what people call it        for   one line: what Claudia uses it for
 *   docs     where to get the key       fields  what to paste (see FIELD below)
 *   check    optional: (get) => { method, url, headers, body? } for a read-only request that costs
 *            nothing. "Test" shows it as a dry run (secrets → ***); "Send check" sends it.
 * The vault name of a field is `<id>` for the first field and `<id>.<fieldId>` for the others, unless
 * the field sets `name`. Packages may ask for other spellings: list them in `aliases`.
 */
import { randomBytes } from "node:crypto";
import * as vault from "./vault.js";

/** Field: { id, label, secret = true, placeholder, optional, pattern (soft check), name, aliases } */
const F = (id, label, extra = {}) => ({ id, label, secret: true, ...extra });

export const PROVIDERS = [
  // ── media generation ────────────────────────────────────────────────────
  { id: "google", group: "media", name: "Google AI (Gemini)", for: "Images with Nano Banana, video with Gemini Omni (Veo until 22 Oct 2026), Lyria music and Gemini voices.",
    docs: "https://aistudio.google.com/apikey", fields: [F("key", "API key", { placeholder: "AIza…", pattern: /^AIza[0-9A-Za-z_-]{30,}$/ })],
    check: (k) => ({ method: "GET", url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: { "x-goog-api-key": k("key") } }) },
  { id: "openai", group: "media", name: "OpenAI", for: "Images (gpt-image), speech, and chat if you pick OpenAI as the chat provider.",
    docs: "https://platform.openai.com/api-keys", fields: [F("key", "API key", { placeholder: "sk-…", pattern: /^sk-[A-Za-z0-9_-]{20,}$/ })],
    check: (k) => ({ method: "GET", url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "fal", group: "media", name: "fal.ai", for: "Many image and video models (Flux, Kling, Seedance and more) behind one key.",
    docs: "https://fal.ai/dashboard/keys", fields: [F("key", "API key", { placeholder: "key-id:key-secret", pattern: /^[^\s:]{8,}:[^\s]{16,}$/ })] },
  { id: "elevenlabs", group: "media", name: "ElevenLabs", for: "Speech in Claudia's voice, music and sound effects.",
    docs: "https://elevenlabs.io/app/settings/api-keys", fields: [F("key", "API key", { placeholder: "sk_…" })],
    check: (k) => ({ method: "GET", url: "https://api.elevenlabs.io/v1/user", headers: { "xi-api-key": k("key") } }) },
  { id: "heygen", group: "media", name: "HeyGen", for: "Talking-avatar videos.",
    docs: "https://app.heygen.com/settings?nav=API", fields: [F("key", "API key")],
    check: (k) => ({ method: "GET", url: "https://api.heygen.com/v2/user/remaining_quota", headers: { "X-Api-Key": k("key") } }) },
  { id: "runway", group: "media", name: "Runway", for: "Video generation (Gen-4 and newer).",
    docs: "https://dev.runwayml.com/", fields: [F("key", "API key", { placeholder: "key_…" })],
    check: (k) => ({ method: "GET", url: "https://api.dev.runwayml.com/v1/organization", headers: { Authorization: `Bearer ${k("key")}`, "X-Runway-Version": "2024-11-06" } }) },
  { id: "byteplus", group: "media", name: "BytePlus ModelArk", for: "Seedream images and Seedance video, direct from BytePlus.",
    docs: "https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey", fields: [F("key", "API key")] },

  // ── chat models (OpenAI-compatible; see CHAT_PRESETS) ───────────────────
  { id: "openrouter", group: "chat", name: "OpenRouter", for: "Chat with hundreds of models through one key.",
    docs: "https://openrouter.ai/keys", fields: [F("key", "API key", { placeholder: "sk-or-…", vaultField: "openrouterKey", pattern: /^sk-or-[A-Za-z0-9_-]{10,200}$/ })],
    check: (k) => ({ method: "GET", url: "https://openrouter.ai/api/v1/key", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "xai", group: "chat", name: "xAI", for: "Chat with Grok models.", docs: "https://console.x.ai",
    fields: [F("key", "API key", { placeholder: "xai-…", pattern: /^xai-[A-Za-z0-9_-]{20,}$/ })],
    check: (k) => ({ method: "GET", url: "https://api.x.ai/v1/models", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "qwen", group: "chat", name: "Qwen (Alibaba Cloud Model Studio)", for: "Chat with Qwen models.", docs: "https://www.alibabacloud.com/help/en/model-studio/get-api-key",
    fields: [F("key", "API key", { placeholder: "sk-…" })],
    check: (k) => ({ method: "GET", url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "deepseek", group: "chat", name: "DeepSeek", for: "Chat with DeepSeek models.", docs: "https://platform.deepseek.com/api_keys",
    fields: [F("key", "API key", { placeholder: "sk-…" })],
    check: (k) => ({ method: "GET", url: "https://api.deepseek.com/models", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "kimi", group: "chat", name: "Kimi (Moonshot AI)", for: "Chat with Kimi models.", docs: "https://platform.moonshot.ai/console/api-keys",
    fields: [F("key", "API key", { placeholder: "sk-…" })],
    check: (k) => ({ method: "GET", url: "https://api.moonshot.ai/v1/models", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "anthropic", group: "chat", name: "Anthropic", for: "Chat with Claude models (OpenAI-compatible endpoint).", docs: "https://console.anthropic.com/settings/keys",
    fields: [F("key", "API key", { placeholder: "sk-ant-…", pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/ })],
    check: (k) => ({ method: "GET", url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": k("key"), "anthropic-version": "2023-06-01" } }) },
  { id: "chat-custom", group: "chat", name: "Other OpenAI-compatible server", for: "Any server that speaks the OpenAI chat API (set its address under Chat model).",
    docs: "https://platform.openai.com/docs/api-reference/chat", fields: [F("key", "API key", { optional: true })] },

  // ── social networks (direct) ────────────────────────────────────────────
  { id: "x", group: "social", name: "X", for: "Post, reply and read mentions. Uses your own X developer app (OAuth 2.0). X bills your developer account per request.",
    docs: "https://developer.x.com/en/portal/dashboard",
    fields: [F("clientId", "OAuth 2.0 Client ID", { secret: false, name: "x.clientId", aliases: ["x", "x_client_id"] }), F("clientSecret", "OAuth 2.0 Client Secret", { optional: true, name: "x.clientSecret", aliases: ["x_client_secret"] })] },
  { id: "telegram", group: "social", name: "Telegram", for: "Post to a channel or group through your own bot.",
    docs: "https://t.me/BotFather", fields: [F("key", "Bot token", { placeholder: "123456:ABC…", pattern: /^\d{5,}:[A-Za-z0-9_-]{30,}$/, aliases: ["telegram.botToken", "telegram_bot_token"] })],
    check: (k) => ({ method: "GET", url: `https://api.telegram.org/bot${k("key")}/getMe`, headers: {} }) },
  { id: "discord", group: "social", name: "Discord", for: "Post to a channel with a webhook, or with your own bot.",
    docs: "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
    fields: [F("webhook", "Webhook URL", { optional: true, placeholder: "https://discord.com/api/webhooks/…", name: "discord.webhook", pattern: /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/, aliases: ["discord_webhook"] }),
      F("bot", "Bot token (optional)", { optional: true, name: "discord", aliases: ["discord.botToken", "discord_bot_token"] })],
    check: (k) => (k("webhook") ? { method: "GET", url: k("webhook"), headers: {} } : k("bot") ? { method: "GET", url: "https://discord.com/api/v10/users/@me", headers: { Authorization: `Bot ${k("bot")}` } } : null) },
  { id: "bluesky", group: "social", name: "Bluesky", for: "Post and read mentions with an app password (not your main password).",
    docs: "https://bsky.app/settings/app-passwords",
    fields: [F("handle", "Handle", { secret: false, placeholder: "you.bsky.social", name: "bluesky.handle", aliases: ["bluesky_handle", "bluesky.identifier"] }), F("appPassword", "App password", { placeholder: "xxxx-xxxx-xxxx-xxxx", name: "bluesky", aliases: ["bluesky.appPassword", "bluesky_app_password"] }),
      F("service", "Server (optional)", { secret: false, optional: true, placeholder: "https://bsky.social", name: "bluesky.service" })],
    check: (k) => ({ method: "POST", url: `${(k("service") || "https://bsky.social").replace(/\/+$/, "")}/xrpc/com.atproto.server.createSession`, headers: { "Content-Type": "application/json" }, body: { identifier: k("handle"), password: k("appPassword") } }) },
  { id: "mastodon", group: "social", name: "Mastodon", for: "Post and read mentions on your Mastodon server.",
    docs: "https://docs.joinmastodon.org/client/token/",
    fields: [F("instance", "Server", { secret: false, placeholder: "mastodon.social", name: "mastodon.instance", aliases: ["mastodon_instance", "mastodon.server"] }), F("token", "Access token (optional)", { optional: true, name: "mastodon", aliases: ["mastodon.token", "mastodon_token"] })],
    check: (k) => ({ method: "GET", url: `https://${String(k("instance") || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "")}/api/v1/accounts/verify_credentials`, headers: { Authorization: `Bearer ${k("token")}` } }) },
  { id: "neynar", group: "social", name: "Farcaster (Neynar)", for: "Cast and read mentions on Farcaster through your Neynar app.",
    docs: "https://dev.neynar.com",
    fields: [F("key", "API key"), F("signerUuid", "Signer UUID", { secret: false, name: "neynar.signerUuid", aliases: ["neynar-signer", "neynar_signer_uuid", "farcaster.signerUuid"] })] },
  { id: "nostr", group: "social", name: "Nostr", for: "Post notes to Nostr relays with your own key.",
    docs: "https://nostr.how/en/get-started", fields: [F("key", "Secret key (nsec)", { placeholder: "nsec1…", pattern: /^nsec1[0-9a-z]{50,}$/ })] },
  { id: "linkedin", group: "social", name: "LinkedIn", for: "Post to your profile. Uses your own LinkedIn app; sign-ins last 60 days.",
    docs: "https://www.linkedin.com/developers/apps",
    fields: [F("clientId", "Client ID", { secret: false, name: "linkedin.clientId", aliases: ["linkedin", "linkedin_client_id"] }), F("clientSecret", "Client secret", { name: "linkedin.clientSecret", aliases: ["linkedin_client_secret"] })] },
  { id: "youtube", group: "social", name: "YouTube (Google OAuth client)", for: "Upload videos and Shorts. Uses your own Google Cloud OAuth client (Desktop app type).",
    docs: "https://console.cloud.google.com/apis/credentials",
    fields: [F("clientId", "OAuth client ID", { secret: false, name: "youtube.clientId", aliases: ["youtube", "google.clientId", "youtube_client_id"] }), F("clientSecret", "OAuth client secret", { name: "youtube.clientSecret", aliases: ["google.clientSecret", "youtube_client_secret"] })] },

  // ── posting services (one key reaches several networks) ─────────────────
  { id: "buffer", group: "service", name: "Buffer", for: "Post to the channels you already connected in Buffer.", docs: "https://buffer.com/developers/api", fields: [F("key", "Access token")] },
  { id: "zernio", group: "service", name: "Zernio", for: "Post to the networks connected in your Zernio account.", docs: "https://zernio.com", fields: [F("key", "API key")] },
  { id: "upload-post", group: "service", name: "Upload-Post", for: "Post videos and images to TikTok, Instagram and more through Upload-Post.", docs: "https://app.upload-post.com/", fields: [F("key", "API key", { aliases: ["uploadpost", "upload_post"] })] },

  // ── developer apps (networks that need your own app review) ─────────────
  { id: "meta", group: "app", name: "Meta (Instagram, Facebook, Threads)", for: "Your own Meta app. Instagram and Threads need a Business or Creator account.",
    docs: "https://developers.facebook.com/apps",
    fields: [F("appId", "App ID", { secret: false, name: "meta.appId", aliases: ["meta", "instagram.appId", "facebook.appId", "threads.appId"] }), F("appSecret", "App secret", { name: "meta.appSecret", aliases: ["instagram.appSecret", "facebook.appSecret", "threads.appSecret"] })] },
  { id: "tiktok", group: "app", name: "TikTok", for: "Your own TikTok developer app (Content Posting API).", docs: "https://developers.tiktok.com/apps",
    fields: [F("clientKey", "Client key", { secret: false, name: "tiktok.clientKey", aliases: ["tiktok", "tiktok.clientId"] }), F("clientSecret", "Client secret", { name: "tiktok.clientSecret" })] },
  { id: "pinterest", group: "app", name: "Pinterest", for: "Your own Pinterest app.", docs: "https://developers.pinterest.com/apps/",
    fields: [F("appId", "App ID", { secret: false, name: "pinterest.appId", aliases: ["pinterest", "pinterest.clientId"] }), F("appSecret", "App secret", { name: "pinterest.appSecret", aliases: ["pinterest.clientSecret"] })] },
];

export const GROUPS = [
  { id: "media", label: "Media generation", about: "Images, video, voice, music and avatars in the Generate studio." },
  { id: "chat", label: "Chat models", about: "The model your agent thinks with. Pick which one under Chat model." },
  { id: "social", label: "Social networks", about: "Direct connections. Some need your own developer app; the steps are on Socials → Connections." },
  { id: "service", label: "Posting services", about: "One key that reaches the networks you connected inside that service." },
  { id: "app", label: "Developer apps", about: "Networks that only work with your own reviewed app." },
];

export const BY_ID = new Map(PROVIDERS.map(p => [p.id, p]));

/** The vault name a field is stored under. */
export const fieldName = (p, f, i = p.fields.indexOf(f)) => f.name || (i === 0 ? p.id : `${p.id}.${f.id}`);

// Lookup table: every name or alias a package might ask for → { provider, field }.
const NAME_INDEX = new Map();
const norm = (s) => String(s || "").trim().toLowerCase().replace(/[_\s]+/g, ".");
for (const p of PROVIDERS) p.fields.forEach((f, i) => {
  for (const n of [fieldName(p, f, i), ...(f.aliases || [])]) if (!NAME_INDEX.has(norm(n))) NAME_INDEX.set(norm(n), { p, f });
});

// ── chat presets (Settings → Chat model) ───────────────────────────────────
// Each is an OpenAI-compatible /chat/completions endpoint. `key` is the provider id above.
// `usage`: how to ask for token counts in the stream ("openrouter" | "openai" | null).
export const CHAT_PRESETS = [
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", key: "openrouter", usage: "openrouter", modelHint: "provider/model, e.g. anthropic/claude-sonnet-4.5" },
  { id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1", key: "xai", usage: "openai", modelHint: "e.g. grok-4" },
  { id: "qwen", name: "Qwen", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", key: "qwen", usage: "openai", modelHint: "e.g. qwen-plus" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", key: "deepseek", usage: "openai", modelHint: "e.g. deepseek-chat" },
  { id: "kimi", name: "Kimi", baseUrl: "https://api.moonshot.ai/v1", key: "kimi", usage: "openai", modelHint: "e.g. kimi-k2-0905-preview" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", key: "openai", usage: "openai", modelHint: "e.g. gpt-5-mini" },
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", key: "anthropic", usage: null, modelHint: "e.g. claude-sonnet-4-5" },
  { id: "custom", name: "Other (OpenAI-compatible)", baseUrl: "", key: "chat-custom", usage: "openai", modelHint: "the model id your server expects" },
];
export const CHAT_BY_ID = new Map(CHAT_PRESETS.map(c => [c.id, c]));

// ── reading keys ───────────────────────────────────────────────────────────

function readField(p, f) {
  if (f.vaultField) return vault.isUnlocked() ? vault.get(f.vaultField) || null : null;
  return vault.getKey(fieldName(p, f));
}

/** Value of a provider's field by id ("x", "clientSecret"), or null. */
export function providerValue(providerId, fieldId) {
  const p = BY_ID.get(providerId);
  const f = p?.fields.find(x => x.id === fieldId) || p?.fields[0];
  return p && f ? readField(p, f) : null;
}

/**
 * Names @useclaudia/social asks for that aren't a single field here (see its KEY_NAMES):
 *   developer apps ("x", "linkedin", "youtube", "tiktok", "pinterest", "instagram", "facebook", "threads")
 *   come as JSON {"clientId","clientSecret"}; "discord" is the webhook URL or bot token; "social-vault" is
 *   the key the package seals its token file (social/accounts.json) with, made once and kept in our vault.
 */
const appCreds = (pid, idField, secretField) => () => {
  const clientId = providerValue(pid, idField), clientSecret = providerValue(pid, secretField);
  return clientId ? JSON.stringify(clientSecret ? { clientId, clientSecret } : { clientId }) : null;
};
const PACKAGE_NAMES = {
  x: appCreds("x", "clientId", "clientSecret"),
  linkedin: appCreds("linkedin", "clientId", "clientSecret"),
  youtube: appCreds("youtube", "clientId", "clientSecret"),
  tiktok: appCreds("tiktok", "clientKey", "clientSecret"),
  pinterest: appCreds("pinterest", "appId", "appSecret"),
  instagram: appCreds("meta", "appId", "appSecret"),
  facebook: appCreds("meta", "appId", "appSecret"),
  threads: appCreds("meta", "appId", "appSecret"),
  discord: () => providerValue("discord", "webhook") || providerValue("discord", "bot"),
  "social-vault": () => {
    if (!vault.isUnlocked()) return null;
    let v = vault.getKey("social-vault", "tokens");
    if (!v) { v = randomBytes(32).toString("base64url"); vault.setKeys({ "social-vault": v }, "tokens"); }
    return v;
  },
};

/** Connect params the social package wants that live in Settings (non-secret fields). Yours win. */
export function connectDefaults(network) {
  const d = {
    bluesky: { handle: providerValue("bluesky", "handle"), service: providerValue("bluesky", "service") },
    mastodon: { instance: providerValue("mastodon", "instance") },
  }[network] || {};
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v));
}

/**
 * The KeyProvider handed to @useclaudia/media and @useclaudia/social.
 *   get(name)  → the key, or null when unknown, not set or the app is locked
 *   set / delete (optional extension) → let a package keep OAuth tokens in the vault instead of on disk
 */
export function createKeyProvider() {
  return {
    get(name) {
      const special = PACKAGE_NAMES[String(name)];
      if (special) return special();
      const hit = NAME_INDEX.get(norm(name));
      if (hit) return readField(hit.p, hit.f);
      return vault.getKey(String(name), "tokens"); // something a package stored itself
    },
    set(name, value) {
      if (!vault.isUnlocked()) return false;
      vault.setKeys({ [String(name).toLowerCase().slice(0, 64)]: value == null ? null : String(value) }, "tokens");
      return true;
    },
    delete(name) {
      if (!vault.isUnlocked()) return false;
      vault.setKeys({ [String(name).toLowerCase().slice(0, 64)]: null }, "tokens");
      return true;
    },
  };
}

// ── Settings rows ──────────────────────────────────────────────────────────
export function publicProvider(p) {
  const fields = p.fields.map((f, i) => {
    const v = readField(p, f);
    return { id: f.id, label: f.label, secret: f.secret !== false, optional: !!f.optional, placeholder: f.placeholder || "", name: fieldName(p, f, i),
      set: !!v, hint: !v ? "" : f.secret === false ? v : v.length > 16 ? "…" + v.slice(-4) : "" };
  });
  const configured = fields.filter(f => !f.optional).every(f => f.set) && fields.some(f => f.set);
  return { id: p.id, group: p.group, name: p.name, for: p.for, docs: p.docs, fields, configured, canCheck: !!p.check };
}

export function listProviders() {
  return PROVIDERS.map(publicProvider);
}

/** Save a provider's fields: { fieldId: "value" | null }. Unknown fields are ignored. */
export function saveProvider(id, values) {
  const p = BY_ID.get(id);
  if (!p) throw Object.assign(new Error("Unknown provider."), { status: 404 });
  const patch = {}, legacy = {};
  for (const [i, f] of p.fields.entries()) {
    if (!(f.id in (values || {}))) continue;
    const raw = values[f.id];
    const v = raw === null || raw === undefined ? null : String(raw).trim();
    if (v && /\s/.test(v)) throw Object.assign(new Error(`${f.label} can't contain spaces.`), { status: 400 });
    if (v && v.length > 4096) throw Object.assign(new Error(`${f.label} is too long.`), { status: 400 });
    if (f.vaultField) legacy[f.vaultField] = v || null;
    else patch[fieldName(p, f, i)] = v || null;
  }
  if (Object.keys(legacy).length) vault.set(legacy);
  if (Object.keys(patch).length) vault.setKeys(patch);
  return publicProvider(p);
}

export function removeProvider(id) {
  const p = BY_ID.get(id);
  if (!p) throw Object.assign(new Error("Unknown provider."), { status: 404 });
  return saveProvider(id, Object.fromEntries(p.fields.map(f => [f.id, null])));
}

// ── test: format check + a dry run of the check request ────────────────────
const SECRET_HEADERS = /^(authorization|x-api-key|xi-api-key|x-goog-api-key|api-key|x-key)$/i;

/** Replace every secret value by *** in a request (headers, URL, body). */
export function redact(req, secrets) {
  const vals = secrets.filter(s => s && s.length >= 4).sort((a, b) => b.length - a.length);
  const scrub = (s) => vals.reduce((acc, v) => acc.split(v).join("***"), String(s));
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) headers[k] = SECRET_HEADERS.test(k) ? (String(v).match(/^(Bearer|Bot|Basic) /)?.[0] || "") + "***" : scrub(v);
  let body = req.body;
  if (body !== undefined) body = JSON.parse(scrub(JSON.stringify(body)));
  return { method: req.method, url: scrub(req.url), headers, ...(body !== undefined ? { body } : {}) };
}

export async function testProvider(id, { live = false } = {}) {
  const p = BY_ID.get(id);
  if (!p) throw Object.assign(new Error("Unknown provider."), { status: 404 });
  const get = (fid) => { const f = p.fields.find(x => x.id === fid); return f ? readField(p, f) : null; };
  const issues = [];
  for (const f of p.fields) {
    const v = get(f.id);
    if (!v) { if (!f.optional) issues.push(`${f.label} isn't set.`); continue; }
    if (f.pattern && !f.pattern.test(v)) issues.push(`${f.label} doesn't look like the usual format. Check you copied all of it.`);
  }
  if (p.id === "discord" && !get("webhook") && !get("bot")) issues.push("Add a webhook URL or a bot token.");
  const secrets = p.fields.filter(f => f.secret !== false).map(f => get(f.id)).filter(Boolean);
  const req = p.check && !issues.some(i => i.endsWith("isn't set.")) ? p.check(get) : null;
  const missing = issues.some(i => i.endsWith("isn't set.") || i.startsWith("Add "));
  const note = req ? "" : missing ? "Add the key first." : p.check ? "" : "There's no read-only check for this one. Connecting (Socials → Connections) or a dry-run generation shows the real request.";
  const out = { ok: !issues.length, issues, dryRun: req ? redact(req, secrets) : null, note };
  if (live && req) {
    try {
      const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body ? JSON.stringify(req.body) : undefined, signal: AbortSignal.timeout(12_000), redirect: "error" });
      await r.arrayBuffer().catch(() => {});
      out.live = { status: r.status, ok: r.ok, message: r.ok ? "The provider accepted the key." : r.status === 401 || r.status === 403 ? "The provider refused the key." : `The provider answered ${r.status}.` };
      out.ok = out.ok && r.ok;
    } catch (e) {
      out.live = { status: 0, ok: false, message: `Couldn't reach the provider: ${e.message}` };
      out.ok = false;
    }
  }
  return out;
}

/** Model ids from a chat provider's own /models list (a read-only request with your key, only when you ask). */
export async function listChatModels(presetId) {
  const preset = CHAT_BY_ID.get(presetId);
  const p = preset && BY_ID.get(preset.key);
  if (!p?.check) throw Object.assign(new Error("This provider has no model list. Type the model id."), { status: 400 });
  const get = (fid) => { const f = p.fields.find(x => x.id === fid); return f ? readField(p, f) : null; };
  if (!get("key")) throw Object.assign(new Error(`Add your ${p.name} key first.`), { status: 409 });
  const req = p.check(get);
  const r = await fetch(req.url, { method: req.method, headers: req.headers, signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!r.ok) throw Object.assign(new Error(`${p.name} answered ${r.status}.`), { status: 502 });
  const j = await r.json();
  return (j.data || j.models || []).map(m => ({ id: String(m.id || m.name || "").replace(/^models\//, ""), name: String(m.display_name || m.name || m.id || "") })).filter(m => m.id).slice(0, 500);
}
