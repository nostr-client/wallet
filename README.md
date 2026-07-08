# wallet

**An in-browser bitcoin wallet for nostr tipping.** Testnet-first. No build
step. One file: [`wallet.js`](wallet.js).

**Live demo:** https://nostr-client.github.io/wallet/ ·
**See it in a client:** [btcnostr](https://nostr-client.github.io/btcnostr/)

- `tipWallet()` — per-nostr-user P2WPKH hot wallet (key in localStorage,
  scoped by nostr pubkey); balance/UTXOs/history/broadcast via mempool.space;
  transactions built + signed in the browser with pinned
  [@scure/btc-signer](https://github.com/paulmillr/scure-btc-signer)
- `<nostr-wallet>` — balance, receive QR, send form, history, faucet links,
  **"Put address in my profile"** (merges `btc_test` into your kind-0)
- `<btc-tip-button>` — instant on-chain tips on any note with sat presets;
  recipient address from their profile; publishes a kind-1 receipt tagged
  `['t','onchain-tip']` with the txid — social proof with no receipt server.
  Any page that imports this module grows tip buttons on every note card.

**Security:** it's a hot wallet in localStorage — pocket change only.
Testnet by default; sats are free from the faucets. AGPL-3.0-or-later.
