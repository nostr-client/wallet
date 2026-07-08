# wallet

**An in-browser bitcoin wallet for nostr tipping.** Testnet-first. No build
step. One file: [`wallet.js`](wallet.js).

**Live demo:** https://nostr-client.github.io/wallet/ ·
**See it in a client:** [btcnostr](https://nostr-client.github.io/btcnostr/)

**The key insight: your npub IS a bitcoin address.** A nostr pubkey is a
BIP-340 x-only secp256k1 key — exactly what a taproot output wants. So
`nostrAddress(pubkey)` derives a `tb1p…` address for *any* npub, computable
by anyone, spendable by whoever holds the nostr secret. Nobody has to
publish a tip address; everybody is tippable from day zero.

- `tipWallet()` — when your login exposes the key (guest/starter/pasted),
  **the wallet IS your nostr key** (taproot key-path); NIP-07 extension users
  get a per-user P2WPKH hot key instead (extensions never reveal secrets).
  Balance/UTXOs/history/broadcast via mempool.space; transactions built +
  signed in the browser with pinned
  [@scure/btc-signer](https://github.com/paulmillr/scure-btc-signer)
- `nostrAddress(pubkeyHex, network)` — anyone's npub → their bitcoin address
- tip resolution order: profile `btc_test`/`btc` field if published,
  otherwise the address derived from their nostr key
- `<nostr-wallet>` — balance, receive QR, send form, history, faucet links,
  **"Put address in my profile"** (merges `btc_test` into your kind-0)
- `<btc-tip-button>` — instant on-chain tips on any note with sat presets;
  recipient address from their profile; publishes a kind-1 receipt tagged
  `['t','onchain-tip']` with the txid — social proof with no receipt server.
  Any page that imports this module grows tip buttons on every note card.

**Security:** it's a hot wallet in localStorage — pocket change only.
Testnet by default; sats are free from the faucets. AGPL-3.0-or-later.
