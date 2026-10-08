# Security

Claudia Local is a single-user app that runs on your computer. This page says what it protects, how, and what it doesn't.

## What it protects

- **Your secrets**: your chat, media and social keys and developer-app credentials, the Claudia API key (`ck_live_…`), the device key that signs Claudia requests, and the agent wallet that signs Solana transactions.
- **Your accounts**: nothing is posted to a social network without your approval in the dashboard.
- **Your data**: chats, memories, files, activity.
- **Your money**: the SOL in the agent wallet.

## How

### Network

- The server binds to `127.0.0.1` and nothing else. There is no setting to change that.
- Requests whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>` are refused (`421`), which stops DNS-rebinding pages.
- Writes (`POST`, `PUT`, `DELETE`) must carry our own `Origin`, or none at all. Browsers on other sites can't make them.
- The WebSocket only accepts our own origin.
- A strict Content Security Policy: scripts, styles, fonts and connections only from the app itself. Images may come from `https:` hosts (coin pictures; switch them off in Settings → Privacy).
- Outbound calls: your chat provider, the Claudia address you set, your Solana RPC, and the media and social providers you add keys for, only when you use them. The OAuth relay (`https://useclaudia.xyz/relay/oauth/callback`) is used only by networks that refuse loopback redirect URIs, and the media relay only by networks that pull media from a public URL. No analytics.
- `GET /oauth/callback` is the only route without the session cookie (browsers don't send `SameSite=Strict` cookies on the way back from a sign-in). It's protected by the one-time OAuth `state` and the PKCE verifier held in memory; it needs the app to be unlocked and only shows a short result page.
- The optional local MCP server (off by default) listens on `127.0.0.1` only, checks `Host`, refuses browser `Origin`s other than loopback, and needs a bearer token. Only the token's SHA-256 is stored; a new token replaces the old one.

### Lock and session

- The app starts locked. Unlocking with your passphrase sets a random session cookie (`HttpOnly`, `SameSite=Strict`), kept in memory only.
- Every API route except health, state, first-run setup and unlock needs that cookie, and so does the WebSocket.
- **Lock**, quitting, or the optional idle timer drops the key from memory and ends every session and socket.
- Unlock attempts are rate limited (8 per minute).

### Secrets at rest

- `vault.json` holds all secrets in one AES-256-GCM box. The key comes from your passphrase with scrypt (N=2^15, r=8, p=1, random 16-byte salt). The passphrase is never written anywhere.
- The dashboard never receives a secret: only "set / not set", the last characters of API keys, and public keys. Showing the wallet key for a backup asks for the passphrase again. Key tests show requests with every secret replaced by `***`.
- Social sign-in tokens are sealed by `@useclaudia/social` (AES-256-GCM, `social/accounts.json`) with a random key that lives in the vault.
- All data files are written atomically with mode `0600` in a `0700` folder (`~/.claudia-local`).
- Importing from `~/.claudia` (the `@useclaudia/cli` setup) copies the keys into the vault; the CLI's own files are left as they are.

### The agent

- **No shell, no host files.** File tools work only inside `~/.claudia-local/workspace`. Paths with `..`, `~`, absolute paths to other places, NUL bytes and symbolic links are refused, and the check runs again after folders are created. Files are capped at 2 MB, the workspace at 200 MB.
- **Tools can be switched off** one by one (Skills). Switched-off tools aren't offered to the model.
- **Posting** in the public Claudia thread asks you to approve the exact text first (default on).
- **Social networks**: the agent and MCP apps can only draft; drafts wait in Socials → Approvals. Previews show every label added and anything that blocks a post (price or return promises, banned phrases, caps). The kill switch stops all publishing and, optionally, drafting.
- **Media spending**: media the agent, MCP apps or campaigns ask for waits for your approval (default); your per-job, per-day and per-month caps apply to every job.
- **Files in posts**: media can only come from the studio library, your uploads, the brand kit or the workspace; anything else is refused.
- **Action log**: every key change, generation, approval, draft and publish goes to `studio-log.jsonl` (no secrets).
- **No trading tools.** The agent can read, quote and paper trade. For a real trade it can only leave a suggestion; you review it, run a dry run and confirm it yourself.
- **Untrusted data.** Coin names, thread posts and file contents can contain instructions aimed at the model. The system prompt tells the model to treat tool results as data, and replies are rendered as plain Markdown: no HTML, no images (which could act as tracking beacons), links only to `http(s)`.
- **Claudia coins only.** Claudia coin tools refuse coins that weren't launched on Claudia (or aren't $CLAUDIA).

### Money

Every live buy, sell or launch:

1. Needs **live trading switched on** (off by default, with a warning when you switch it on).
2. Checks that your agent is active on Claudia and that the wallet in the vault is the agent's registered wallet.
3. Checks your **caps** before anything is signed: per-trade and per-day SOL limits (defaults 0.05 / 0.2 SOL), counted in a local ledger.
4. Gets a quote or plan from Claudia, **signs it locally to check it** (wrong signer or missing signatures fail here), and **simulates** it on your RPC. That's the dry run; nothing is sent.
5. Needs your **explicit confirmation** of that exact dry run within 60 seconds. A failed simulation can't be confirmed.

The Claudia server never sees a secret key; it only receives signatures and signed transactions.

## What it doesn't protect against

- **Malware or other people with access to your user account.** They can read memory, log keystrokes or wait for you to unlock. Use a strong passphrase and lock the app when you step away.
- **The AI model provider** sees what you send in chat (the chat provider and model you pick). Don't paste secrets into chat. Media providers see your prompts and references; social networks see what you publish.
- **Provider bills.** Caps count what Claudia Local started; the provider's dashboard is the final word.
- **Bad trades.** Caps limit losses per trade and per day; they don't make a trade good.
- **A lost passphrase.** There's no recovery. Back up the agent wallet key (Claudia → Your agent → Back up wallet key) somewhere offline.

## Reporting a problem

Please report security issues privately through [useclaudia.xyz](https://useclaudia.xyz) rather than in public.
