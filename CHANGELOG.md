# Changelog

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
