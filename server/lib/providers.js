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
 * the field sets `name`. Packages may ask for other spellings: list them in `aliases`. `env` lists the
 * .env variable names that "Import from .env" maps to that field.
 *
 * key-meta.json keeps when each provider's key was last used and last tested (dates only, no secrets).
 */
import { randomBytes } from "node:crypto";
import * as vault from "./vault.js";
import { P } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./store.js";

/** Field: { id, label, secret = true, placeholder, optional, pattern (soft check), name, aliases } */
const F = (id, label, extra = {}) => ({ id, label, secret: true, ...extra });

export const PROVIDERS = [
  // ── media generation ────────────────────────────────────────────────────
  { id: "google", group: "media", name: "Google AI (Gemini)", for: "Chat with Gemini, images with Nano Banana, video with Gemini Omni, Lyria music and Gemini voices.",
    docs: "https://aistudio.google.com/apikey", fields: [F("key", "API key", { placeholder: "AIza…", pattern: /^AIza[0-9A-Za-z_-]{30,}$/, env: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] })],
    check: (k) => ({ method: "GET", url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: { "x-goog-api-key": k("key") } }) },
  { id: "openai", group: "media", name: "OpenAI", for: "Images (gpt-image), speech, and chat if you pick OpenAI as the chat provider.",
    docs: "https://platform.openai.com/api-keys", fields: [F("key", "API key", { placeholder: "sk-…", pattern: /^sk-[A-Za-z0-9_-]{20,}$/, env: ["OPENAI_API_KEY"] })],
    check: (k) => ({ method: "GET", url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "fal", group: "media", name: "fal.ai", for: "Many image and video models (Flux, Kling, Seedance and more) behind one key.",
    docs: "https://fal.ai/dashboard/keys", fields: [F("key", "API key", { placeholder: "key-id:key-secret", pattern: /^[^\s:]{8,}:[^\s]{16,}$/, env: ["FAL_KEY", "FAL_API_KEY"] })] },
  { id: "elevenlabs", group: "media", name: "ElevenLabs", for: "Speech in your brand voice, music and sound effects.",
    docs: "https://elevenlabs.io/app/settings/api-keys", fields: [F("key", "API key", { placeholder: "sk_…", env: ["ELEVENLABS_API_KEY", "ELEVEN_API_KEY", "XI_API_KEY"] })],
    check: (k) => ({ method: "GET", url: "https://api.elevenlabs.io/v1/user", headers: { "xi-api-key": k("key") } }) },
  { id: "heygen", group: "media", name: "HeyGen", for: "Talking-avatar videos.",
    docs: "https://app.heygen.com/settings?nav=API", fields: [F("key", "API key", { env: ["HEYGEN_API_KEY"] })],
    check: (k) => ({ method: "GET", url: "https://api.heygen.com/v2/user/remaining_quota", headers: { "X-Api-Key": k("key") } }) },
  { id: "runway", group: "media", name: "Runway", for: "Video generation (Gen-4 and newer).",
    docs: "https://dev.runwayml.com/", fields: [F("key", "API key", { placeholder: "key_…", env: ["RUNWAYML_API_SECRET", "RUNWAY_API_KEY"] })],
    check: (k) => ({ method: "GET", url: "https://api.dev.runwayml.com/v1/organization", headers: { Authorization: `Bearer ${k("key")}`, "X-Runway-Version": "2024-11-06" } }) },
  { id: "byteplus", group: "media", name: "BytePlus ModelArk", for: "Seedream images and Seedance video, direct from BytePlus.",
    docs: "https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey", fields: [F("key", "API key", { env: ["BYTEPLUS_API_KEY", "ARK_API_KEY"] })] },

  // ── chat models (see CHAT_PRESETS) ─────────────────────────────────────
  { id: "anthropic", group: "chat", name: "Anthropic", for: "Chat with Claude models (Anthropic's own Messages API).", docs: "https://console.anthropic.com/settings/keys",
    fields: [F("key", "API key", { placeholder: "sk-ant-…", pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/, env: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"] })],
    check: (k) => ({ method: "GET", url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": k("key"), "anthropic-version": "2023-06-01" } }) },
  { id: "openrouter", group: "chat", name: "OpenRouter", for: "Chat with hundreds of models through one key.",
    docs: "https://openrouter.ai/keys", fields: [F("key", "API key", { placeholder: "sk-or-…", vaultField: "openrouterKey", pattern: /^sk-or-[A-Za-z0-9_-]{10,200}$/, env: ["OPENROUTER_API_KEY"] })],
    check: (k) => ({ method: "GET", url: "https://openrouter.ai/api/v1/key", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "xai", group: "chat", name: "xAI", for: "Chat with Grok models.", docs: "https://console.x.ai",
    fields: [F("key", "API key", { placeholder: "xai-…", pattern: /^xai-[A-Za-z0-9_-]{20,}$/, env: ["XAI_API_KEY", "GROK_API_KEY"] })],
    check: (k) => ({ method: "GET", url: "https://api.x.ai/v1/models", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "groq", group: "chat", name: "Groq", for: "Fast chat with open models (Llama, Qwen, GPT-OSS), and transcribing Telegram voice notes (Whisper).", docs: "https://console.groq.com/keys",
    fields: [F("key", "API key", { placeholder: "gsk_…", pattern: /^gsk_[A-Za-z0-9]{20,}$/, env: ["GROQ_API_KEY"] })],
    check: (k) => ({ method: "GET", url: "https://api.groq.com/openai/v1/models", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "deepseek", group: "chat", name: "DeepSeek", for: "Chat with DeepSeek models.", docs: "https://platform.deepseek.com/api_keys",
    fields: [F("key", "API key", { placeholder: "sk-…", env: ["DEEPSEEK_API_KEY"] })],
    check: (k) => ({ method: "GET", url: "https://api.deepseek.com/models", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "qwen", group: "chat", name: "Qwen (Alibaba Cloud Model Studio)", for: "Chat with Qwen models.", docs: "https://www.alibabacloud.com/help/en/model-studio/get-api-key",
    fields: [F("key", "API key", { placeholder: "sk-…", env: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"] })],
    check: (k) => ({ method: "GET", url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "kimi", group: "chat", name: "Kimi (Moonshot AI)", for: "Chat with Kimi models.", docs: "https://platform.moonshot.ai/console/api-keys",
    fields: [F("key", "API key", { placeholder: "sk-…", env: ["MOONSHOT_API_KEY", "KIMI_API_KEY"] })],
    check: (k) => ({ method: "GET", url: "https://api.moonshot.ai/v1/models", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "mistral", group: "chat", name: "Mistral", for: "Chat with Mistral models.", docs: "https://console.mistral.ai/api-keys",
    fields: [F("key", "API key", { env: ["MISTRAL_API_KEY"] })],
    check: (k) => ({ method: "GET", url: "https://api.mistral.ai/v1/models", headers: { Authorization: `Bearer ${k("key")}` } }) },
  { id: "chat-custom", group: "chat", name: "Other OpenAI-compatible server", for: "Any server that speaks the OpenAI chat API (set its address under Chat model).",
    docs: "https://platform.openai.com/docs/api-reference/chat", fields: [F("key", "API key", { optional: true })] },

  // ── Claudia ─────────────────────────────────────────────────────────────
  { id: "claudia", group: "claudia", name: "Claudia agent key", for: "Your agent's API key on Claudia. Set and changed on the Claudia page.", docs: "https://useclaudia.xyz/agents",
    readonly: true, fields: [F("key", "Agent API key", { placeholder: "ck_live_…", vaultField: "claudiaApiKey" })] },
  { id: "claudia-trade", group: "claudia", name: "Claudia Trade (MCP)", for: "Lets the agent prepare trades and launches through Claudia's Trade MCP server. It only prepares; you confirm.", docs: "https://useclaudia.xyz/agents",
    fields: [F("key", "MCP key", { placeholder: "cmk_…", pattern: /^cmk_[A-Za-z0-9_-]{16,}$/, env: ["CLAUDIA_MCP_KEY", "CLAUDIA_TRADE_KEY"] })] },

  // ── social networks (direct) ────────────────────────────────────────────
  { id: "x", group: "social", name: "X", for: "Post, reply and read mentions. Uses your own X developer app (OAuth 2.0). X bills your developer account per request.",
    docs: "https://developer.x.com/en/portal/dashboard",
    fields: [F("clientId", "OAuth 2.0 Client ID", { secret: false, name: "x.clientId", aliases: ["x", "x_client_id"], env: ["X_CLIENT_ID", "TWITTER_CLIENT_ID"] }), F("clientSecret", "OAuth 2.0 Client Secret", { optional: true, name: "x.clientSecret", aliases: ["x_client_secret"], env: ["X_CLIENT_SECRET", "TWITTER_CLIENT_SECRET"] })] },
  { id: "telegram", group: "social", name: "Telegram", for: "Post to a channel or group through your own bot.",
    docs: "https://t.me/BotFather", fields: [F("key", "Bot token", { placeholder: "123456:ABC…", pattern: /^\d{5,}:[A-Za-z0-9_-]{30,}$/, aliases: ["telegram.botToken", "telegram_bot_token"], env: ["TELEGRAM_BOT_TOKEN"] })],
    check: (k) => ({ method: "GET", url: `https://api.telegram.org/bot${k("key")}/getMe`, headers: {} }) },
  { id: "telegram-chat", group: "social", name: "Telegram chat bot", for: "Chat with your agent, get task results and approve things from Telegram (Settings → Channels). Use a separate bot from the one that posts.",
    docs: "https://t.me/BotFather", fields: [F("key", "Bot token", { placeholder: "123456:ABC…", pattern: /^\d{5,}:[A-Za-z0-9_-]{30,}$/, env: ["TELEGRAM_CHAT_BOT_TOKEN"] })],
    check: (k) => ({ method: "GET", url: `https://api.telegram.org/bot${k("key")}/getMe`, headers: {} }) },
  { id: "discord", group: "social", name: "Discord", for: "Post to a channel with a webhook, or with your own bot.",
    docs: "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
    fields: [F("webhook", "Webhook URL", { optional: true, placeholder: "https://discord.com/api/webhooks/…", name: "discord.webhook", pattern: /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/, aliases: ["discord_webhook"], env: ["DISCORD_WEBHOOK_URL"] }),
      F("bot", "Bot token (optional)", { optional: true, name: "discord", aliases: ["discord.botToken", "discord_bot_token"], env: ["DISCORD_BOT_TOKEN"] })],
    check: (k) => (k("webhook") ? { method: "GET", url: k("webhook"), headers: {} } : k("bot") ? { method: "GET", url: "https://discord.com/api/v10/users/@me", headers: { Authorization: `Bot ${k("bot")}` } } : null) },
  { id: "bluesky", group: "social", name: "Bluesky", for: "Post and read mentions with an app password (not your main password).",
    docs: "https://bsky.app/settings/app-passwords",
    fields: [F("handle", "Handle", { secret: false, placeholder: "you.bsky.social", name: "bluesky.handle", aliases: ["bluesky_handle", "bluesky.identifier"], env: ["BLUESKY_HANDLE"] }), F("appPassword", "App password", { placeholder: "xxxx-xxxx-xxxx-xxxx", name: "bluesky", aliases: ["bluesky.appPassword", "bluesky_app_password"], env: ["BLUESKY_APP_PASSWORD"] }),
      F("service", "Server (optional)", { secret: false, optional: true, placeholder: "https://bsky.social", name: "bluesky.service" })],
    check: (k) => ({ method: "POST", url: `${(k("service") || "https://bsky.social").replace(/\/+$/, "")}/xrpc/com.atproto.server.createSession`, headers: { "Content-Type": "application/json" }, body: { identifier: k("handle"), password: k("appPassword") } }) },
  { id: "mastodon", group: "social", name: "Mastodon", for: "Post and read mentions on your Mastodon server.",
    docs: "https://docs.joinmastodon.org/client/token/",
    fields: [F("instance", "Server", { secret: false, placeholder: "mastodon.social", name: "mastodon.instance", aliases: ["mastodon_instance", "mastodon.server"], env: ["MASTODON_INSTANCE", "MASTODON_SERVER"] }), F("token", "Access token (optional)", { optional: true, name: "mastodon", aliases: ["mastodon.token", "mastodon_token"], env: ["MASTODON_ACCESS_TOKEN", "MASTODON_TOKEN"] })],
    check: (k) => ({ method: "GET", url: `https://${String(k("instance") || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "")}/api/v1/accounts/verify_credentials`, headers: { Authorization: `Bearer ${k("token")}` } }) },
  { id: "neynar", group: "social", name: "Farcaster (Neynar)", for: "Cast and read mentions on Farcaster through your Neynar app.",
    docs: "https://dev.neynar.com",
    fields: [F("key", "API key", { env: ["NEYNAR_API_KEY"] }), F("signerUuid", "Signer UUID", { secret: false, name: "neynar.signerUuid", aliases: ["neynar-signer", "neynar_signer_uuid", "farcaster.signerUuid"], env: ["NEYNAR_SIGNER_UUID"] })] },
  { id: "nostr", group: "social", name: "Nostr", for: "Post notes to Nostr relays with your own key.",
    docs: "https://nostr.how/en/get-started", fields: [F("key", "Secret key (nsec)", { placeholder: "nsec1…", pattern: /^nsec1[0-9a-z]{50,}$/, env: ["NOSTR_NSEC", "NOSTR_SECRET_KEY"] })] },
  { id: "linkedin", group: "social", name: "LinkedIn", for: "Post to your profile. Uses your own LinkedIn app; sign-ins last 60 days.",
    docs: "https://www.linkedin.com/developers/apps",
    fields: [F("clientId", "Client ID", { secret: false, name: "linkedin.clientId", aliases: ["linkedin", "linkedin_client_id"], env: ["LINKEDIN_CLIENT_ID"] }), F("clientSecret", "Client secret", { name: "linkedin.clientSecret", aliases: ["linkedin_client_secret"], env: ["LINKEDIN_CLIENT_SECRET"] })] },
  { id: "youtube", group: "social", name: "YouTube (Google OAuth client)", for: "Upload videos and Shorts. Uses your own Google Cloud OAuth client (Desktop app type).",
    docs: "https://console.cloud.google.com/apis/credentials",
    fields: [F("clientId", "OAuth client ID", { secret: false, name: "youtube.clientId", aliases: ["youtube", "google.clientId", "youtube_client_id"], env: ["YOUTUBE_CLIENT_ID"] }), F("clientSecret", "OAuth client secret", { name: "youtube.clientSecret", aliases: ["google.clientSecret", "youtube_client_secret"], env: ["YOUTUBE_CLIENT_SECRET"] })] },

  // ── posting services (one key reaches several networks) ─────────────────
  { id: "buffer", group: "service", name: "Buffer", for: "Post to the channels you already connected in Buffer.", docs: "https://buffer.com/developers/api", fields: [F("key", "Access token", { env: ["BUFFER_ACCESS_TOKEN"] })] },
  { id: "zernio", group: "service", name: "Zernio", for: "Post to the networks connected in your Zernio account.", docs: "https://zernio.com", fields: [F("key", "API key", { env: ["ZERNIO_API_KEY"] })] },
  { id: "upload-post", group: "service", name: "Upload-Post", for: "Post videos and images to TikTok, Instagram and more through Upload-Post.", docs: "https://app.upload-post.com/", fields: [F("key", "API key", { aliases: ["uploadpost", "upload_post"], env: ["UPLOAD_POST_API_KEY"] })] },

  // ── developer apps (networks that need your own app review) ─────────────
  { id: "meta", group: "app", name: "Meta (Instagram, Facebook, Threads)", for: "Your own Meta app. Instagram and Threads need a Business or Creator account.",
    docs: "https://developers.facebook.com/apps",
    fields: [F("appId", "App ID", { secret: false, name: "meta.appId", aliases: ["meta", "instagram.appId", "facebook.appId", "threads.appId"], env: ["META_APP_ID", "FACEBOOK_APP_ID"] }), F("appSecret", "App secret", { name: "meta.appSecret", aliases: ["instagram.appSecret", "facebook.appSecret", "threads.appSecret"], env: ["META_APP_SECRET", "FACEBOOK_APP_SECRET"] })] },
  { id: "tiktok", group: "app", name: "TikTok", for: "Your own TikTok developer app (Content Posting API).", docs: "https://developers.tiktok.com/apps",
    fields: [F("clientKey", "Client key", { secret: false, name: "tiktok.clientKey", aliases: ["tiktok", "tiktok.clientId"], env: ["TIKTOK_CLIENT_KEY"] }), F("clientSecret", "Client secret", { name: "tiktok.clientSecret", env: ["TIKTOK_CLIENT_SECRET"] })] },
  { id: "pinterest", group: "app", name: "Pinterest", for: "Your own Pinterest app.", docs: "https://developers.pinterest.com/apps/",
    fields: [F("appId", "App ID", { secret: false, name: "pinterest.appId", aliases: ["pinterest", "pinterest.clientId"], env: ["PINTEREST_APP_ID"] }), F("appSecret", "App secret", { name: "pinterest.appSecret", aliases: ["pinterest.clientSecret"], env: ["PINTEREST_APP_SECRET"] })] },
];

// `section` is the heading Settings → Keys files a group under: Chat, Media, Social, Claudia.
export const GROUPS = [
  { id: "chat", section: "Chat", label: "Chat models", about: "The model your agent thinks with. Pick which one under Chat model." },
  { id: "media", section: "Media", label: "Media generation", about: "Images, video, voice, music and avatars in the Generate studio." },
  { id: "social", section: "Social", label: "Social networks", about: "Direct connections. Some need your own developer app; the steps are on Socials → Connections." },
  { id: "service", section: "Social", label: "Posting services", about: "One key that reaches the networks you connected inside that service." },
  { id: "app", section: "Social", label: "Developer apps", about: "Networks that only work with your own reviewed app." },
  { id: "claudia", section: "Claudia", label: "Claudia", about: "Your agent on useclaudia.xyz and Claudia's MCP servers." },
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
// kind: "anthropic" = native Messages API · "openai" = OpenAI-compatible /chat/completions · "local" = a
// server on this computer (no key). `key` is the provider id above. `usage`: how to ask for token counts in
// the stream ("openrouter" | "openai" | null). `models` is the list shown when the provider has no model
// endpoint or it can't be reached. `vision`: which model ids can see images (a RegExp, or true for all).
const M = (id, name, extra = {}) => ({ id, name, ...extra });
export const CHAT_PRESETS = [
  { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", key: "anthropic", usage: null, listModels: false, vision: true,
    models: [M("claude-haiku-5-5", "Claude Haiku 5.5", { recommended: true }), M("claude-sonnet-5-5", "Claude Sonnet 5.5"), M("claude-opus-5-5", "Claude Opus 5.5")], modelHint: "claude-haiku-5-5" },
  { id: "openai", name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", key: "openai", usage: "openai", vision: /^(gpt-4o|gpt-4\.1|gpt-5|o[134]|chatgpt)/,
    models: [M("gpt-5-mini", "GPT-5 mini", { recommended: true }), M("gpt-5", "GPT-5"), M("gpt-5-nano", "GPT-5 nano"), M("gpt-4.1", "GPT-4.1"), M("gpt-4.1-mini", "GPT-4.1 mini"), M("gpt-4o-mini", "GPT-4o mini")], modelHint: "e.g. gpt-5-mini" },
  { id: "gemini", name: "Google Gemini", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", key: "google", usage: "openai", vision: /^gemini/,
    models: [M("gemini-2.5-flash", "Gemini 2.5 Flash", { recommended: true }), M("gemini-2.5-pro", "Gemini 2.5 Pro"), M("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite")], modelHint: "e.g. gemini-2.5-flash" },
  { id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", key: "openrouter", usage: "openrouter", vision: /(claude|gpt-4o|gpt-4\.1|gpt-5|gemini|vision|-vl|pixtral|llava|grok-4)/i,
    models: [M("anthropic/claude-haiku-5.5", "Claude Haiku 5.5", { recommended: true }), M("anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"), M("openai/gpt-5-mini", "GPT-5 mini"), M("google/gemini-2.5-flash", "Gemini 2.5 Flash"), M("deepseek/deepseek-chat", "DeepSeek V3")], modelHint: "provider/model, e.g. openai/gpt-5-mini" },
  { id: "xai", name: "xAI", kind: "openai", baseUrl: "https://api.x.ai/v1", key: "xai", usage: "openai", vision: /^grok-(4|2-vision)/,
    models: [M("grok-4", "Grok 4"), M("grok-3-mini", "Grok 3 mini")], modelHint: "e.g. grok-4" },
  { id: "groq", name: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", key: "groq", usage: "openai", vision: /(llama-4|vision)/,
    models: [M("llama-3.3-70b-versatile", "Llama 3.3 70B"), M("openai/gpt-oss-120b", "GPT-OSS 120B"), M("qwen/qwen3-32b", "Qwen3 32B"), M("llama-3.1-8b-instant", "Llama 3.1 8B")], modelHint: "e.g. llama-3.3-70b-versatile" },
  { id: "deepseek", name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com/v1", key: "deepseek", usage: "openai", vision: false,
    models: [M("deepseek-chat", "DeepSeek Chat"), M("deepseek-reasoner", "DeepSeek Reasoner")], modelHint: "e.g. deepseek-chat" },
  { id: "qwen", name: "Qwen", kind: "openai", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", key: "qwen", usage: "openai", vision: /-vl/,
    models: [M("qwen-plus", "Qwen Plus"), M("qwen-max", "Qwen Max"), M("qwen-turbo", "Qwen Turbo"), M("qwen-vl-plus", "Qwen VL Plus")], modelHint: "e.g. qwen-plus" },
  { id: "kimi", name: "Kimi", kind: "openai", baseUrl: "https://api.moonshot.ai/v1", key: "kimi", usage: "openai", vision: /vision/,
    models: [M("kimi-k2-0905-preview", "Kimi K2"), M("kimi-k2-turbo-preview", "Kimi K2 Turbo")], modelHint: "e.g. kimi-k2-0905-preview" },
  { id: "mistral", name: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1", key: "mistral", usage: null, vision: /(pixtral|mistral-(medium|small))/,
    models: [M("mistral-medium-latest", "Mistral Medium"), M("mistral-large-latest", "Mistral Large"), M("mistral-small-latest", "Mistral Small"), M("pixtral-large-latest", "Pixtral Large")], modelHint: "e.g. mistral-medium-latest" },
  { id: "ollama", name: "Ollama (this computer)", kind: "local", baseUrl: "http://127.0.0.1:11434/v1", key: null, usage: "openai", vision: /(llava|vision|-vl|gemma3|llama4|minicpm-v|moondream)/, models: [], modelHint: "a model you pulled, e.g. llama3.2" },
  { id: "lmstudio", name: "LM Studio (this computer)", kind: "local", baseUrl: "http://127.0.0.1:1234/v1", key: null, usage: null, vision: /(llava|vision|-vl|gemma-3|pixtral)/, models: [], modelHint: "a model you loaded" },
  { id: "custom", name: "Other (OpenAI-compatible)", kind: "openai", baseUrl: "", key: "chat-custom", usage: "openai", vision: false, models: [], modelHint: "the model id your server expects" },
];
export const CHAT_BY_ID = new Map(CHAT_PRESETS.map(c => [c.id, c]));

/** Can this model take images? Only a hint from the model id; unknown models get text only. */
export function visionCapable(presetId, model) {
  const p = CHAT_BY_ID.get(presetId);
  if (!p || !model) return false;
  if (p.vision === true) return true;
  return p.vision instanceof RegExp ? p.vision.test(String(model)) : false;
}

/** A chat preset as the dashboard sees it (no secrets). */
export function publicPreset(c) {
  const p = c.key ? BY_ID.get(c.key) : null;
  return { id: c.id, name: c.name, kind: c.kind, baseUrl: c.baseUrl, key: c.key, modelHint: c.modelHint, models: c.models, listModels: c.listModels !== false,
    keySet: c.kind === "local" ? true : c.id === "custom" ? true : !!p && publicProvider(p).configured, keyProvider: p ? p.name : null, docs: p?.docs || "" };
}

// ── local servers (Ollama, LM Studio) ──────────────────────────────────────
let localCache = null;
/** Which local model servers are running right now: { ollama: { running, models }, lmstudio: {…} }. */
export async function detectLocal({ fresh = false } = {}) {
  if (!fresh && localCache && Date.now() - localCache.ts < 20_000) return localCache.data;
  const probe = async (url, pick) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(900), redirect: "error" });
      if (!r.ok) return { running: false, models: [] };
      return { running: true, models: pick(await r.json()).filter(Boolean).slice(0, 200) };
    } catch { return { running: false, models: [] }; }
  };
  const fromV1 = (j) => (j.data || []).map(m => ({ id: String(m.id), name: String(m.id) }));
  let ollama = await probe("http://127.0.0.1:11434/api/tags", (j) => (j.models || []).map(m => ({ id: String(m.name || m.model), name: String(m.name || m.model) })));
  if (!ollama.running) ollama = await probe("http://127.0.0.1:11434/v1/models", fromV1);
  const lmstudio = await probe("http://127.0.0.1:1234/v1/models", fromV1);
  const data = { ollama, lmstudio };
  localCache = { ts: Date.now(), data };
  return data;
}

// ── key meta: last used, last tested ───────────────────────────────────────
const META_THROTTLE = 60_000;
const lastWrite = new Map();
export const keyMeta = () => readJsonFile(P.keyMeta, {});

/** Notes that a provider's key was used (at most once a minute per provider). */
export function touchKey(providerId) {
  if (!providerId || !BY_ID.has(providerId)) return;
  const now = Date.now();
  if (now - (lastWrite.get(providerId) || 0) < META_THROTTLE) return;
  lastWrite.set(providerId, now);
  const m = keyMeta();
  writeJsonFile(P.keyMeta, { ...m, [providerId]: { ...(m[providerId] || {}), lastUsed: now } });
}

function noteTest(providerId, ok) {
  const m = keyMeta();
  writeJsonFile(P.keyMeta, { ...m, [providerId]: { ...(m[providerId] || {}), lastTested: Date.now(), testOk: !!ok } });
}

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
      if (hit) { const v = readField(hit.p, hit.f); if (v) touchKey(hit.p.id); return v; }
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
      set: !!v, hint: !v ? "" : f.secret === false ? v : v.length > 16 ? "…" + v.slice(-4) : "", env: f.env || [] };
  });
  const configured = fields.filter(f => !f.optional).every(f => f.set) && fields.some(f => f.set);
  const meta = keyMeta()[p.id] || {};
  return { id: p.id, group: p.group, name: p.name, for: p.for, docs: p.docs, fields, configured, canCheck: !!p.check, readonly: !!p.readonly,
    lastUsed: meta.lastUsed || null, lastTested: meta.lastTested || null, testOk: meta.testOk ?? null };
}

export function listProviders() {
  return PROVIDERS.map(publicProvider);
}

/** Save a provider's fields: { fieldId: "value" | null }. Unknown fields are ignored. */
export function saveProvider(id, values) {
  const p = BY_ID.get(id);
  if (!p) throw Object.assign(new Error("Unknown provider."), { status: 404 });
  if (p.readonly) throw Object.assign(new Error(`${p.name} is set on the Claudia page.`), { status: 400 });
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
    noteTest(p.id, out.ok);
  }
  return out;
}

/**
 * Models for a chat preset: { models: [{ id, name, recommended? }], live, error? }.
 * Asks the provider's own /models list (a read-only request with your key) when it has one, and falls
 * back to the preset's static list when it doesn't or can't be reached.
 */
export async function listChatModels(presetId, { baseUrl: customBase } = {}) {
  const c = CHAT_BY_ID.get(presetId);
  if (!c) throw Object.assign(new Error("Unknown chat provider."), { status: 404 });
  const fallback = (error) => ({ models: c.models, live: false, ...(error ? { error } : {}) });
  if (c.listModels === false) return fallback();
  if (c.kind === "local") {
    const d = (await detectLocal({ fresh: true }))[c.id];
    return d?.running ? { models: d.models, live: true } : fallback(`${c.name.replace(/ \(.*\)$/, "")} isn't running on this computer.`);
  }
  const p = c.key ? BY_ID.get(c.key) : null;
  const key = p ? readField(p, p.fields[0]) : null;
  const base = (c.id === "custom" ? customBase : c.id === "openrouter" ? openrouterBase() : c.baseUrl) || "";
  if (!base) return fallback("Set the server address first.");
  if (!key && c.id !== "openrouter" && c.id !== "custom") return fallback(`Add your ${p?.name || c.name} key to load the full list.`);
  try {
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    const r = await fetch(`${base.replace(/\/+$/, "")}/models`, { headers, signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!r.ok) return fallback(`${c.name} answered ${r.status}.`);
    if (key && p) touchKey(p.id);
    const j = await r.json();
    const rec = new Set(c.models.filter(m => m.recommended).map(m => m.id));
    const models = (j.data || j.models || []).map(m => {
      const id = String(m.id || m.name || "").replace(/^models\//, "");
      const price = m.pricing ? { promptPerM: Math.round(Number(m.pricing.prompt || 0) * 1e8) / 100, completionPerM: Math.round(Number(m.pricing.completion || 0) * 1e8) / 100 } : {};
      const tools = Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("tools") : null;
      const vision = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities.includes("image") : null;
      return { id, name: String(m.display_name || m.name || id).replace(/\s*\(free\)\s*$/i, ""), ...(rec.has(id) ? { recommended: true } : {}), ...price, ...(tools !== null ? { tools } : {}), ...(vision !== null ? { vision } : {}), context: m.context_length || null };
    }).filter(m => m.id).slice(0, 800);
    if (c.id === "openrouter") rememberPrices(models);
    return { models: models.length ? models : c.models, live: models.length > 0 };
  } catch (e) {
    return fallback(`Couldn't reach ${c.name}: ${e.message}`);
  }
}

// OpenRouter publishes prices per model; keep them for the spend estimate (model.js).
const orPrices = new Map();
function rememberPrices(models) { for (const m of models) if (m.promptPerM !== undefined) orPrices.set(m.id, { in: m.promptPerM, out: m.completionPerM, vision: m.vision }); }
export const openrouterPrice = (id) => orPrices.get(id) || null;

/** CLAUDIA_LOCAL_OPENROUTER_BASE (tests, a proxy): https:// or a loopback http:// address. */
export function openrouterBase() { return envBase("CLAUDIA_LOCAL_OPENROUTER_BASE") || "https://openrouter.ai/api/v1"; }
/** CLAUDIA_LOCAL_ANTHROPIC_BASE (tests, a proxy): https:// or a loopback http:// address. */
export function anthropicBase() { return envBase("CLAUDIA_LOCAL_ANTHROPIC_BASE") || "https://api.anthropic.com/v1"; }
function envBase(name) {
  const o = process.env[name]?.trim();
  if (!o) return "";
  let u;
  try { u = new URL(o); } catch { throw new Error(`${name} is not a URL`); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error(`${name} must be https:// or a local http:// address`);
  return o.replace(/\/+$/, "");
}

// ── import from a pasted .env file ─────────────────────────────────────────
/** KEY=value lines (export, quotes and comments allowed) → Map(name → value). */
export function parseEnv(text) {
  const out = new Map();
  for (const raw of String(text || "").slice(0, 200_000).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    if (v) out.set(m[1].toUpperCase(), v);
  }
  return out;
}

const ENV_INDEX = new Map();
for (const p of PROVIDERS) for (const f of p.fields) for (const e of f.env || []) if (!ENV_INDEX.has(e)) ENV_INDEX.set(e, { p, f });

/**
 * Preview (apply = false) or save the keys a .env file holds. Values never come back: rows show the
 * provider, the field and the last 4 characters. `only` limits saving to these variable names.
 */
export function importEnv(text, { apply = false, only = null } = {}) {
  const vars = parseEnv(text);
  const rows = [], unknown = [];
  const seen = new Set();
  for (const [name, value] of vars) {
    const hit = ENV_INDEX.get(name);
    if (!hit) { unknown.push(name); continue; }
    const target = `${hit.p.id}.${hit.f.id}`;
    const dup = seen.has(target);
    seen.add(target);
    const existing = readField(hit.p, hit.f);
    rows.push({ var: name, provider: hit.p.id, providerName: hit.p.name, field: hit.f.id, fieldLabel: hit.f.label, hint: value.length > 8 ? "…" + value.slice(-4) : "", replaces: !!existing && existing !== value, same: existing === value, duplicate: dup, readonly: !!hit.p.readonly });
  }
  if (!apply) return { rows, unknown: unknown.slice(0, 100) };
  const saved = [];
  const pick = only ? new Set(only.map(String)) : null;
  const byProvider = new Map();
  for (const r of rows) {
    if (r.duplicate || r.readonly || r.same || (pick && !pick.has(r.var))) continue;
    const v = byProvider.get(r.provider) || {};
    v[r.field] = vars.get(r.var);
    byProvider.set(r.provider, v);
    saved.push(r.var);
  }
  for (const [id, values] of byProvider) saveProvider(id, values);
  return { rows, unknown: unknown.slice(0, 100), saved };
}
