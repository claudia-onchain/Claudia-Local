## What this changes

<!-- One or two sentences, from the user's side. -->

## How you checked it

- [ ] `npm run check` and `npm run build` pass
- [ ] `npm run smoke` passes
- [ ] Clicked through the pages this touches (desktop and phone width)

## Safety rules (see CONTRIBUTING.md)

- [ ] The server still listens on 127.0.0.1 only, and the Host / Origin checks are untouched
- [ ] No secret leaves the vault, shows unmasked, or lands in a log
- [ ] Trades, launches and posts still need a person to confirm, inside the caps, and outside content can't start them
- [ ] Model calls go straight to the user's own provider (no relay, no Claudia key)
- [ ] 0.2 / 0.3 data still loads (any storage change migrates once, automatically)
- [ ] Copy: plain and short, Solana first, no decorative icons
