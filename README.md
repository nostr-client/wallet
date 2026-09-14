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
  Balance/UTXOs/history/broadcast via an Esplora API; transactions built +
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

## Networks

| id | label | chain | explorer | coins from |
|---|---|---|---|---|
| `txbt4` **(default)** | bitcoin blake | BLAKE2b fork of testnet4, split at block 150,308 | [mempool.guide](https://mempool.guide/testnet4) | mining (no public faucet) |
| `testnet4` | testnet4 | Bitcoin Core's test chain | mempool.space | faucets |
| `testnet` | testnet3 | the legacy test chain | mempool.space | faucets |
| `mainnet` | mainnet | real bitcoin | mempool.space | ⚠ your own |

Addresses are identical across the test chains (`tb1…`), but the UTXO sets are
not — coins received on bitcoin blake do not exist on Core's testnet4, so a
spend on one cannot be replayed on the other. Each network keeps its own key
and balance.

Every app starts on `txbt4` (`DEFAULT_NETWORK`). A host page can override which
network it *starts* on — set
`globalThis.__nostrClientBtcNetwork = 'txbt4'` **before** importing (the custom
elements boot on import), or call `setDefaultNetwork()` from a module that
loads first. The user's own choice via `setPreferredNetwork()` always wins and
is persisted in `localStorage` under `nostr-client:btc-network`.

**Security:** it's a hot wallet in localStorage — pocket change only.
Testnet by default; test coins are free. AGPL-3.0-or-later.
