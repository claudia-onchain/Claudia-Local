# Contributing

Thanks for helping. Claudia Local holds people's keys and wallets, so the bar is "small, clear, and safe". Read the safety rules at the end before you open a pull request.

## Dev setup

You need Node.js 22.13 or newer (it uses `node:sqlite`) and git.

```sh
git clone https://github.com/claudia-onchain/Claudia-Local.git
cd Claudia-Local
npm ci
npm run build                       # type-checks and builds the dashboard into dashboard/dist
CLAUDIA_LOCAL_HOME=./.dev-home npm start
```

Open http://127.0.0.1:3939. Use a throwaway data folder (`CLAUDIA_LOCAL_HOME`) so you never touch your real `~/.claudia-local`. `.claudia-local/` and `.dev-home` style folders are git-ignored; keep data out of the repo.

For dashboard work, run the server as above and `npm run dev` in a second terminal (Vite on http://127.0.0.1:5173, proxying `/api` and `/ws`).

Before you push:

```sh
npm run check    # dashboard types + node --check on every server file
npm run build
npm run smoke    # boots the server with a temp home, checks health, setup and the Host check
```

There is no formal test suite. CI runs those three on Linux, macOS and Windows with Node 22 and 24. For anything with a UI, click through it at desktop and phone width.

## How the code is laid out

```
bin/claudia-local.js     the CLI: start + open the browser, `doctor`, `--version`
server/index.js          boot, auto-lock, routes, static dashboard, WebSocket
server/agent.js          the agent loop and the TOOLS list (exports TOOLS, toolEnabled, toolList, HELPERS, createAgent)
server/identity.md       the agent's base prompt
server/lib/
  paths.js               where data lives (~/.claudia-local, or CLAUDIA_LOCAL_HOME)
  http.js                Host / Origin checks, session cookies, security headers
  vault.js               the passphrase vault (scrypt + AES-256-GCM)
  store.js  db.js        JSON config and SQLite (chats, memory search); 0.2 data migrates here
  model.js  providers.js the model client (Anthropic native, OpenAI-compatible, local) and every key you can add
  memory.js              Markdown memory and the quarantine for memory from outside content
  skills.js  unzip.js    installing, reviewing and pinning Agent Skills
  untrusted.js           labels for outside content; mayAct() gates money and posts
  policy.js              money rules: caps per chain, overspend, decimals, preview expiry
  claudia.js  evm.js  wallets.js  connect-claudia.js   Claudia, Solana and Robinhood Chain
  tasks.js  cron.js  watchers.js  approvals.js  runner.js  telegram.js   things that run on their own
  studio*.js  campaigns.js   media and social (via @useclaudia/media and @useclaudia/social)
  mcp.js  mcp-client.js  the local MCP server, and MCP servers the agent can use
  health.js              the checks behind the Health page and `doctor`
  routes-*.js            HTTP routes per area
dashboard/src/           React 19 + Vite, plain CSS tokens in styles.css
scripts/                 check, smoke, install scripts
```

Server code is plain JavaScript ESM with no build step. Match the code around you: the file header comment that says what the file is for, small helpers, no new frameworks. Add a dependency only when it clearly earns its place, and say why in the commit.

## Adding a provider

Keys for media, social and chat services live in one list, `PROVIDERS` in `server/lib/providers.js` (its header explains each field). Add one entry with an `id`, `group`, `name`, a one-line `for`, the `docs` link where people get the key, the `fields` to paste, and, if the service has one, a `check`: a read-only request that costs nothing, used by the Test button.

For a **chat model** provider, also add an entry to `CHAT_PRESETS` in the same file: `kind` (`anthropic`, `openai` for OpenAI-compatible, or `local`), the `baseUrl`, the `key` (the provider id), a short built-in `models` list with one `recommended`, and a `vision` pattern. Rules:

- the user's own key only, sent straight to the provider; never a relay and never one of Claudia's keys;
- no model is described as costing nothing, anywhere a user can read;
- local servers (`kind: "local"`) must be loopback addresses.

## Adding a skill

Skills are folders with a `SKILL.md` (the [Agent Skills](https://agentskills.io) format). To try one, put it in a folder and use Skills → Add from GitHub or a folder. Skills for everyone live in the Claudia skill library, not in this repo: open a [skill request](https://github.com/claudia-onchain/Claudia-Local/issues/new?template=skill.yml). A skill must be instructions only (Claudia Local never runs its scripts), must not tell anyone to pipe a download into a shell, and must not ask the agent to trade, launch or post without the person confirming.

Templates (`server/lib/templates.js`) refer to library skills by slug.

## Safety rules every PR must keep

1. **Loopback only.** The server listens on `127.0.0.1` (Docker is the single, opt-in exception). Don't weaken the Host, Origin, cookie or CSP checks in `http.js`.
2. **Secrets stay in the vault.** Never send a secret to the dashboard, a log, the activity feed, the model or a remote service other than the one it belongs to.
3. **Bring your own keys.** Model calls go from this computer to the user's provider with the user's key. No relay, no proxy, no Claudia keys.
4. **Money and posts need a person.** Trades, launches and posts are never agent tools. They need a dry run and an explicit confirm, inside the caps per chain, with live trading on. The rules live in server code (`policy.js`, `untrusted.js`), where the model can't change them.
5. **Outside content can't act.** Anything that isn't the person at the keyboard goes through `untrusted.wrap()`, can't pass `mayAct()`, and memory from it waits for approval.
6. **The agent's files stay in the workspace.** No shell, no paths outside `~/.claudia-local/workspace`.
7. **Skills are never run.** Only read, after review, pinned by hash.
8. **Old data keeps working.** A storage change migrates the old files automatically, once.
9. **Copy:** plain, short, active voice, from the user's side. Solana first, then Robinhood Chain (beta), then BSC (coming soon). No decorative icons. Never describe models or AI as costing nothing.

Found a security problem? Don't open an issue or a PR; see [SECURITY.md](SECURITY.md).

By contributing you agree that your work is released under the [MIT License](LICENSE) and that you'll follow the [Code of Conduct](CODE_OF_CONDUCT.md).
