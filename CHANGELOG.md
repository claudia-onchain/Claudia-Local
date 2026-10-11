# Changelog

## 0.3.0

Anyone can install Claudia Local and run a real agent on their own keys. Install with `npx claudia-local`, the install script, Docker or from source.

### Models & keys
- Bring your own key for every model: Anthropic (native Messages API with prompt caching), OpenAI, Google Gemini, OpenRouter, xAI, Groq, DeepSeek, Qwen, Kimi, Mistral, or any OpenAI-compatible server.
- Ollama and LM Studio on your computer show up by themselves and need no key.
- Models per role (chat, helpers, scheduled tasks), a fallback model, and an estimated monthly spend per provider with an optional cap.
- Keys page: every service in one list, with where to get the key, when it was last used and tested, a Test button, and Import from .env.
- There is no default model any more; Claudia Local never uses Claudia's own model keys.

### Setup
- A first-run wizard: what the app can do, your passphrase, a chat model (tested live), a template, connecting to Claudia, wallet limits and a health check. Run it again from Settings.
- One-click connect to Claudia: approve on useclaudia.xyz and the key comes back directly.
- `npx claudia-local`, `npm i -g claudia-local`, install scripts for macOS, Linux, WSL and Windows, `start.cmd` / `start.ps1`, and a Docker image.
- Health page and `claudia-local doctor`: network exposure, Node, lock, MCP, key tests, skill pins, risky settings and new releases, with one-click fixes that only make things stricter.
- The app locks itself after 30 idle minutes by default.

### Tasks & Telegram
- Tasks run your agent on a schedule, with their own tools, budgets and delivery (run history, Telegram or a workspace file). Starter tasks always begin paused.
- Watchers start a task when a coin moves, the Claudia thread gets a post, or something lands in your social inbox. A heartbeat checks in on its own if you switch it on.
- One Approvals queue for everything that waits for your yes, answerable from the dashboard or Telegram. Items expire after 24 hours.
- Daily limits on runs, tool calls, posts and tokens, plus Stop everything (or a STOP file in the data folder).
- Telegram: chat with your agent through your own bot, paired with a code. Long polling only, no open port.
- Templates: Influencer, Content creator, Music manager, Trader watcher and Blank.

### Skills & memory
- Install Agent Skills from Claudia's library, a folder, or a GitHub link after a full review. Skills are instructions only and never run; each is pinned and re-checked.
- Memory is now plain Markdown you can edit (MEMORY.md, USER.md and daily notes), searched with SQLite full-text search. Chats moved to SQLite too.
- Memory proposed after reading outside content waits for your approval.
- MCP servers for your agent (HTTP or a program on your computer), with Claudia Data and Claudia Trade built in and off until you switch them on.
- A Tools page to switch each agent tool on or off.

### Chains & money safety
- Solana first, Robinhood Chain in beta, BSC coming soon. Amounts always show in the chain's own coin.
- Caps per chain (0.05 SOL / 0.2 SOL a day; 0.01 ETH / 0.04 ETH a day by default). Sells count by value. A trade that would spend more than 5% over what you typed is refused, and token amounts are checked against the token's decimals.
- A Robinhood Chain wallet and optional hot wallets per chain, with sweep back to your main wallet.
- Market data on the Claudia page: holders, traders, dev history, scores, KOL and smart-money feeds, live prices.
- Outside content (thread posts, coin names, files, Telegram messages from others, MCP results, skills) is labelled for the model and can never start a trade, launch or post without you.

### Fixes
- The brand kit is now yours: Claudia's look is a preset you can load, not the default.
- The sidebar keeps Lock and the version on screen on shorter windows; task and skill rows fit on phones.
- Windows: skill installs, workspace paths, data-folder hints and atomic writes now work there.
- When Claudia doesn't report chain status, Robinhood Chain shows as view only instead of coming soon.
- Your 0.2 data (config, memory, chats, brand kit, wallet) moves over automatically, once.

## 0.2.0

Claudia Local becomes a creator studio. Bring your own keys for everything.

- **Keys and providers** (Settings): your own keys for Google, OpenAI, fal.ai, ElevenLabs, HeyGen, Runway, BytePlus, OpenRouter, xAI, Qwen, DeepSeek, Kimi, Anthropic, X, Telegram, Discord, Bluesky, Mastodon, Farcaster (Neynar), Nostr, LinkedIn, YouTube, Buffer, Zernio, Upload-Post, Meta, TikTok and Pinterest. Encrypted in the vault, masked in the dashboard, each with a dry-run test.
- **Chat model**: any OpenAI-compatible provider, with presets for OpenRouter, xAI, Qwen, DeepSeek, Kimi, OpenAI and Anthropic, or your own server.
- **Generate**: images, video, speech and music, avatars through `@useclaudia/media`. Live cost estimates, approvals above your line, dry runs, live job progress, a library with provenance, spending caps.
- **Socials** through `@useclaudia/social`: connections (key or OAuth, loopback or the useclaudia.xyz relay), a composer with live per-network previews, approvals, calendar, inbox, campaigns, analytics, and a kill switch. Scheduled posts run every 30 seconds.
- **Brand kit** (Claudia → Brand kit): reference portraits, voice, tone guide and banned phrases, used by Generate, Socials and chat.
- **Campaigns**: plan a set of posts and pictures; everything waits in Approvals.
- **Agent tools**: `generate_media`, `get_media_job`, `list_media`, `draft_post`, `preview_post`, `list_posts`, `inbox`. No publishing tool.
- **Local MCP** (off by default): the same tools on `http://127.0.0.1:3940/mcp` for Claude Code, Claude Desktop and Cursor, with a per-install token.
- **Safety**: action log export (JSONL), per-network daily caps, kill switch that can also stop drafting.
- `npm run check` now syntax-checks every server file.

## 0.1.0

First release: chat, helpers, memory, files, skills, Claudia (coins, thread, paper trading, your agent, trades and launches you confirm), activity, settings.
