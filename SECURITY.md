# Security

Claudia Local is a single-user app that runs on your computer. This page says what it protects, how, what never leaves your machine, and what it can't protect against.

## Reporting a problem

Please report security problems **privately** through a [GitHub security advisory](https://github.com/claudia-onchain/Claudia-Local/security/advisories/new). Don't open a public issue. Include the version (`claudia-local --version`), your OS and the steps to reproduce. We aim to answer within three working days and to ship a fix before anything is made public. Only the latest release gets security fixes.

In scope: anything that lets a web page, another user, outside content (a post, a file, a Telegram message, an MCP server, a skill) or the model itself read your secrets, move money, publish, change settings or run code without you. Out of scope: attacks that need your unlocked user account or your passphrase.

## Threat model

| Who | What they can do | What stops them |
|---|---|---|
| A web page you visit | Send requests to `127.0.0.1` | Host check (DNS rebinding), Origin check on every write and the WebSocket, `SameSite=Strict` session cookie, strict CSP |
| Someone on your network | Nothing: the server only listens on `127.0.0.1` | Loopback binding (see Docker below) |
| Outside content (Claudia thread, coin names, files, web pages, Telegram messages from others, MCP results, skills) | Put instructions in front of the model | Labelled as outside content, can't start trades, launches or posts, memory from it waits for you |
| The model | Ask for any tool it was given | Money and posting rules in server code, caps, confirm-first, tool switches, workspace sandbox |
| A skill | Put instructions in front of the model | Instructions only (never run), reviewed before install, pinned by hash |
| Malware on your account | Everything you can do | Out of scope. Lock the app when you step away |

## What never leaves this computer

- Your **passphrase** (it's never written anywhere, not even hashed).
- Your **vault**: every API key, the Claudia API key and device key, wallet secret keys and social sign-in tokens.
- Your **wallet secret keys**. Transactions are signed here; Claudia and RPCs only get signatures and signed transactions.
- Your **memory, chats, files, tasks and activity log**, unless you send them to your chat model as part of a conversation.

What does leave, and only when you use it: what you send to your own chat model provider, prompts and references to the media providers you add keys for, posts you approve to the networks you connect, and read requests to Claudia (useclaudia.xyz) and your RPCs. No analytics, no telemetry. **Model calls go straight from your computer to your provider with your own key. Claudia Local never uses Claudia's own model keys and has no model relay.**

## How

### Network

- The server binds to `127.0.0.1` only. There is no setting to change that outside Docker.
- Requests whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>` are refused with `421`, which stops DNS-rebinding pages.
- Writes (`POST`, `PUT`, `DELETE`) must carry our own `Origin`, or none at all (scripts on this computer). The WebSocket only accepts our own origin.
- A strict Content Security Policy: scripts, styles, fonts and connections only from the app itself. Images may come from `https:` hosts (coin pictures; switch them off in Settings → Privacy).
- `GET /oauth/callback` and `GET /oauth/claudia` are the only routes without the session cookie (browsers don't send `SameSite=Strict` cookies on the way back from a sign-in). They're protected by a one-time `state` and a PKCE verifier held in memory.
- The optional local MCP server (off by default) listens on `127.0.0.1` only, checks `Host` and `Origin`, and needs a bearer token. Only the token's SHA-256 is stored.
- Telegram uses outbound long polling only: no webhook, no open port.
- **Docker:** the image sets `CLAUDIA_LOCAL_DOCKER=1`, and only then does `CLAUDIA_LOCAL_HOST` let the server listen beyond loopback inside the container. `compose.yaml` publishes the port on the host's `127.0.0.1` only. The Health page and `claudia-local doctor` warn when the server listens beyond loopback.

### Lock and session

- The app starts locked. Unlocking sets a random session cookie (`HttpOnly`, `SameSite=Strict`), kept in memory only. Sessions end after 12 idle hours or 24 hours at most.
- Every API route except health, state, first-run setup and unlock needs that cookie, and so does the WebSocket.
- **Auto-lock** after 30 idle minutes by default. Locking or quitting drops the key from memory, ends every session and socket, stops tasks, closes MCP connections and stops the local MCP server.
- Unlock attempts are rate limited (8 per minute).

### Secrets at rest

- `vault.json` holds all secrets in one AES-256-GCM box. The key comes from your passphrase with scrypt (N=2^15, r=8, p=1, random 16-byte salt).
- The dashboard never receives a secret: only "set / not set", the last characters of API keys, and public addresses. Showing a wallet key for a backup asks for the passphrase again. Key tests show requests with every secret replaced by `***`.
- Data files are written atomically with mode `0600` in a `0700` folder (`~/.claudia-local`). On Windows the folder sits in your user profile, which only your account can read by default.

### Wallets and money

- **Solana first**, then **Robinhood Chain (beta)**. BSC is coming soon and every money action on it is refused.
- **Caps per chain, in the chain's own coin**: by default 0.05 SOL per trade and 0.2 SOL per day on Solana, 0.01 ETH per trade and 0.04 ETH per day on Robinhood Chain. Sells count by what they bring back. You can lower caps any time; Health offers a one-click reset to the defaults.
- **Live trading is off** by default.
- Every live buy, sell or launch: a dry run (quote, amounts checked against the token's decimals, signed locally, simulated on your RPC; nothing sent), then **your explicit confirm of that exact dry run within 60 seconds**, from the dashboard or a Telegram button. A dry run that would spend more than 5% over what you typed is refused.
- **The agent can't trade.** It can read, quote, paper trade and leave a suggestion. If you connect a Claudia agent, it must be active on Claudia for any money action.
- Optional **hot wallets** (one per chain) let you keep the main wallet empty. They follow the same caps.

### Outside content

Messages from Telegram (other than your own text as the paired owner), the Claudia thread, coin names, files, web pages, MCP servers, skills and provider responses are **outside content**:

- they reach the model inside labelled `<outside>` blocks, with a system rule to treat them as information only;
- they can never be the reason a trade, launch or post happens without you confirming it (`server/lib/untrusted.js`, checked in server code);
- memory the agent proposes after reading them waits under Memory → Waiting for you;
- replies render as plain Markdown: no HTML, no remote images, links only to `http(s)`.

### Posting

- Claudia thread posts ask you to approve the exact text first (default on).
- On social networks the agent, tasks and MCP apps only draft; drafts wait in Socials → Approvals. A task can be allowed to post on its own only if you switch that on for that task, inside a daily post limit, and never because of outside content. The kill switch stops all publishing and, optionally, drafting.

### Tasks and approvals

- Tasks, watchers and the heartbeat only run while the app is open and unlocked, inside daily limits on runs, tool calls, posts and tokens.
- A `STOP` file in the data folder (or the Stop button) pauses everything that runs on its own.
- Approvals persist, expire after 24 hours, and can be answered in the dashboard or on Telegram.

### Skills and MCP

- Skills are instructions only. Claudia Local never runs a script from a skill. A SKILL.md that tells anyone to pipe a download into a shell is refused.
- Library skills are checked against the library's SHA-256 before unpacking. GitHub and folder skills show every file (and any script in full) for review before install.
- Unpacking refuses `..`, absolute paths, symlinks and oversized archives. Each install is pinned by a hash; a skill that changes on disk is not loaded until you review it again.
- MCP servers you add for the agent: every result is outside content, every tool can be switched off, and stdio servers (which run a program as you) get a warning before you add them.

### The agent's files

No shell. File tools only see `~/.claudia-local/workspace`. Paths with `..`, `~`, other absolute paths, other drives, UNC paths, NUL bytes and symlinks are refused. Files are capped at 2 MB, the workspace at 200 MB.

## What it doesn't protect against

- **Malware or other people with access to your user account.** They can read memory, log keystrokes or wait for you to unlock. Use a strong passphrase and lock the app when you step away.
- **Your model provider** sees what you send in chat. Don't paste secrets into chat. Media providers see your prompts; social networks see what you publish.
- **Provider bills.** Caps count what Claudia Local started; the provider's dashboard is the final word.
- **Bad trades.** Caps limit losses per trade and per day; they don't make a trade good.
- **A lost passphrase.** There's no recovery. Back up wallet keys (Claudia → Your agent → Back up key) somewhere offline.
