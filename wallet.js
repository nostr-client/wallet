/**
 * wallet.js — an in-browser bitcoin wallet for nostr tipping. TESTNET-FIRST.
 * No build step. Crypto from pinned CDN ESM (@scure/btc-signer, @noble/curves);
 * chain data from Esplora-compatible explorers (mempool.space, and mempool.guide
 * for the bitcoin blake chain). Keys never leave the browser.
 *
 * Part of https://github.com/nostr-client — one repo, one thing.
 * License: AGPL-3.0-or-later
 *
 * Exports:
 *   tipWallet()            — per-nostr-user wallet singleton (P2WPKH)
 *   <nostr-wallet>         — balance / receive QR / send / faucets card
 *   <btc-tip-button>       — instant on-chain tips on any note (presets in sats)
 *
 * The recipient's address is read from their kind-0 profile field `btc_test`
 * (mainnet later: `btc`) — same convention as the tip repo. Sending a tip
 * publishes a kind-1 receipt tagged ['t','onchain-tip'] with the txid, so
 * tips are visible social proof without any custodial receipt server.
 *
 * NETWORKS: bitcoin blake (txbt4, BLAKE2b fork of testnet4 — mined, no faucet)
 * is the DEFAULT; Core's testnet4, testnet3 and mainnet are also available. A
 * host page can override the starting network with globalThis.__nostrClientBtcNetwork
 * before importing; the user's own choice (setPreferredNetwork) always wins and
 * is persisted per browser.
 *
 * SECURITY: the key is a hot wallet in localStorage, scoped per nostr pubkey.
 * Treat it like pocket change. Testnet by default — sats are free.
 */

import { defaultPool } from 'https://nostr-client.github.io/pool/pool.js'
import { profiles } from 'https://nostr-client.github.io/note/note.js'

const SIGNER_URL = 'https://esm.sh/@scure/btc-signer@1.4.0'
const CURVES_URL = 'https://esm.sh/@noble/curves@1.6.0/secp256k1'
const UQR_URL = 'https://esm.sh/uqr@0.1.2'

export const NETWORKS = {
  // Bitcoin Knots' BLAKE2b fork of testnet4 ("bitcoin blake"): same tb1 addresses,
  // its own chain from height 150,308, followed by mempool.guide. (Block 150,307 is
  // identical on both chains; 150,308 is where they split.) Coins received here do
  // not exist on Core's testnet4, so spends cannot be replayed there. Coins come
  // from mining — there is no public faucet for this chain yet.
  txbt4: {
    label: 'bitcoin blake',
    blurb: "the BLAKE2b fork of testnet4, followed by mempool.guide",
    api: 'https://mempool.guide/testnet4/api',
    explorer: 'https://mempool.guide/testnet4',
    unit: 'tsat', coin: 'tXBT',
    profileField: 'xbt_test',
    faucets: [],
  },
  testnet4: {
    label: 'testnet4',
    blurb: "Bitcoin Core's test chain — coins come from public faucets",
    api: 'https://mempool.space/testnet4/api',
    explorer: 'https://mempool.space/testnet4',
    unit: 'tsat', coin: 'tBTC',
    profileField: 'btc_test',
    faucets: [
      { url: 'https://faucet.activetk.jp/', name: 'faucet.activetk.jp' },
      { url: 'https://coinfaucet.eu/en/btc-testnet4/', name: 'coinfaucet.eu' },
      { url: 'https://faucet.testnet4.dev/', name: 'faucet.testnet4.dev' },
    ],
  },
  testnet: {
    label: 'testnet3',
    blurb: 'the legacy test chain — still the best-stocked faucets',
    api: 'https://mempool.space/testnet/api',
    explorer: 'https://mempool.space/testnet',
    unit: 'tsat', coin: 'tBTC',
    profileField: 'btc_test',
    faucets: [
      { url: 'https://bitcoinfaucet.uo1.net/', name: 'bitcoinfaucet.uo1.net' },
      { url: 'https://coinfaucet.eu/en/btc-testnet/', name: 'coinfaucet.eu' },
      { url: 'https://testnet-faucet.com/btc-testnet/', name: 'testnet-faucet.com' },
    ],
  },
  mainnet: {
    label: 'mainnet',
    blurb: 'real bitcoin — a hot wallet in your browser, pocket change only',
    api: 'https://mempool.space/api',
    explorer: 'https://mempool.space',
    unit: 'sat', coin: 'BTC',
    profileField: 'btc',
    faucets: [],
  },
}

const storageKey = (network, scope) => `nostr-client:btc-wallet:${network}:${scope}`
const NET_PREF_KEY = 'nostr-client:btc-network'

/** The chain every nostr-client app starts on unless it says otherwise. */
export const DEFAULT_NETWORK = 'txbt4'

const NET_DEFAULT_GLOBAL = '__nostrClientBtcNetwork'

/**
 * The network an app starts on when the user has never chosen one. A host page
 * can override DEFAULT_NETWORK without touching anyone's saved preference,
 * the same way it composes a pool: set
 *   globalThis.__nostrClientBtcNetwork = 'txbt4'
 * BEFORE importing this module (components boot on import), or call
 * setDefaultNetwork() from a module that loads first.
 */
export function setDefaultNetwork(network) {
  if (!NETWORKS[network]) throw new Error('unknown network: ' + network)
  globalThis[NET_DEFAULT_GLOBAL] = network
}
const fallbackNetwork = () =>
  NETWORKS[globalThis[NET_DEFAULT_GLOBAL]] ? globalThis[NET_DEFAULT_GLOBAL] : DEFAULT_NETWORK

/** The user's chosen network (Settings), else the host page's default. */
export function preferredNetwork() {
  const saved = localStorage.getItem(NET_PREF_KEY)
  return NETWORKS[saved] ? saved : fallbackNetwork()
}
export function setPreferredNetwork(network) {
  if (!NETWORKS[network]) throw new Error('unknown network: ' + network)
  localStorage.setItem(NET_PREF_KEY, network)
}

/** Human label for a network id — 'testnet' is spelled 'testnet3' to users. */
export const networkLabel = (network) => NETWORKS[network]?.label ?? network

/** Coinbase outputs can't be spent until this many confirmations. */
const COINBASE_MATURITY = 100

/**
 * Bytes an output paying `address` adds to a transaction: 8 (value) + 1 (script
 * length) + the scriptPubKey. Outputs are never witness-discounted, so this is
 * vbytes too. A taproot output is 43 B — NOT the 31 B of a P2WPKH, which is what
 * this used to assume for every output. Underestimating here underpays the fee.
 */
function outputVbytes(btc, address, params) {
  try { return 9 + btc.OutScript.encode(btc.Address(params).decode(address)).length }
  catch { return 43 } // unknown/undecodable: assume the largest common output
}

/**
 * Bitcoin Core's dust threshold for an output paying `address`:
 * (serialized output + the cost of spending it) * 3 sat/vB dustRelayFee.
 * P2WPKH is 294, but taproot and P2WSH are 330 and P2PKH is 546 — so a single
 * hardcoded 294 silently builds dust outputs that the network rejects.
 */
function dustThreshold(btc, address, params) {
  try {
    const decoded = btc.Address(params).decode(address)
    const len = btc.OutScript.encode(decoded).length
    const witness = decoded.type === 'tr' || decoded.type === 'wpkh' || decoded.type === 'wsh'
    return (9 + len + (witness ? 67 : 148)) * 3
  } catch { return 330 }
}

/** Turn a node's terse broadcast rejection into something a person can act on. */
export function explainBroadcastError(raw) {
  const text = String(raw ?? '')
  const low = text.toLowerCase()
  const say = (msg) => msg + ' \u2014 ' + text
  if (low.includes('min relay fee') || low.includes('insufficient fee') || low.includes('min-relay'))
    return say('fee too low for this chain')
  if (low.includes('dust')) return say('one output is below the dust limit')
  if (low.includes('premature-spend-of-coinbase') || low.includes('immature'))
    return say(`those coins are freshly mined and need ${COINBASE_MATURITY} confirmations`)
  if (low.includes('missingorspent') || low.includes('missing inputs') || low.includes('txn-mempool-conflict'))
    return say('those coins were already spent — reload to refresh the wallet')
  if (low.includes('txn-already-known') || low.includes('already-in-chain') || low.includes('code\\":-27'))
    return say('this transaction was already broadcast')
  if (low.includes('non-mandatory-script-verify') || low.includes('script-verify'))
    return say('the signature was rejected')
  if (low.includes('too-long-mempool-chain')) return say('too many unconfirmed parents — wait for a block')
  if (low.includes('-26')) return say('the node rejected it under its mempool policy')
  return text
}

const hexToBytes = (hex) => new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)))

let libs = null
async function loadLibs() {
  if (!libs) {
    const [signer, { secp256k1 }] = await Promise.all([import(SIGNER_URL), import(CURVES_URL)])
    libs = { btc: signer, secp256k1 }
  }
  return libs
}

/**
 * THE KEY INSIGHT: a nostr pubkey IS a BIP-340 x-only secp256k1 key — exactly
 * what a taproot output wants. So every npub deterministically has a bitcoin
 * address, derivable by anyone from the pubkey alone, spendable by whoever
 * holds the nostr secret. Nobody needs to publish a tip address.
 */
export async function nostrAddress(nostrPubkeyHex, network = preferredNetwork()) {
  const { btc } = await loadLibs()
  const params = network === 'mainnet' ? btc.NETWORK : btc.TEST_NETWORK
  return btc.p2tr(hexToBytes(nostrPubkeyHex), undefined, params).address
}

export class BtcWallet {
  constructor({ network = preferredNetwork(), scope } = {}) {
    this.networkName = network
    this.net = NETWORKS[network]
    this.scope = scope ?? window.nostrPubkey ?? 'anon'
    this.address = null
    this._priv = null
  }

  get netParams() { return this.networkName === 'mainnet' ? libs.btc.NETWORK : libs.btc.TEST_NETWORK }

  /**
   * Load the key and derive the address. If the nostr signer exposes its
   * secret (guest/local/starter logins), the wallet IS the nostr key:
   * a taproot address derived from the npub — same one anyone can compute
   * to tip this user. Otherwise (NIP-07 extension) a per-user P2WPKH hot
   * key is created, since the extension never reveals the secret.
   */
  async init() {
    const { btc, secp256k1 } = await loadLibs()
    const nostrSecret = window.nostrSigner?.secretHex
    if (nostrSecret && this.scope === window.nostrPubkey) {
      this._priv = hexToBytes(nostrSecret)
      this._spend = btc.p2tr(hexToBytes(this.scope), undefined, this.netParams)
      this.taproot = true
      this.nostrNative = true
    } else {
      const key = storageKey(this.networkName, this.scope)
      let wif = localStorage.getItem(key)
      if (!wif) {
        const priv = crypto.getRandomValues(new Uint8Array(32))
        wif = btc.WIF(this.netParams).encode(priv)
        localStorage.setItem(key, wif)
      }
      this._priv = btc.WIF(this.netParams).decode(wif)
      const pub = secp256k1.getPublicKey(this._priv, true)
      this._spend = btc.p2wpkh(pub, this.netParams)
    }
    this.address = this._spend.address
    return this
  }

  exportWIF() {
    if (this.nostrNative) return null // the backup IS your nsec
    return localStorage.getItem(storageKey(this.networkName, this.scope))
  }

  async _api(path, options) {
    // an explorer that accepts the connection and never answers would otherwise
    // hang the balance poll forever, stacking one dead request every 30s
    const res = await fetch(this.net.api + path, { signal: AbortSignal.timeout(12_000), ...options })
    if (!res.ok) throw new Error(`${new URL(this.net.api).host} ${res.status}: ${(await res.text()).slice(0, 400)}`)
    return res
  }

  /** { confirmed, mempool, total } in sats */
  async balance() {
    const stats = await (await this._api('/address/' + this.address)).json()
    const confirmed = stats.chain_stats.funded_txo_sum - stats.chain_stats.spent_txo_sum
    const mempool = stats.mempool_stats.funded_txo_sum - stats.mempool_stats.spent_txo_sum
    return { confirmed, mempool, total: confirmed + mempool }
  }

  async utxos() { return (await this._api('/address/' + this.address + '/utxo')).json() }

  async _isCoinbase(txid) {
    this._coinbase ??= new Map()
    if (!this._coinbase.has(txid)) {
      const tx = await (await this._api('/tx/' + txid)).json()
      this._coinbase.set(txid, !!tx.vin?.[0]?.is_coinbase)
    }
    return this._coinbase.get(txid)
  }

  /**
   * UTXOs that can actually be spent right now. Coinbase outputs are unspendable
   * until COINBASE_MATURITY confirmations, and a chain whose coins come from
   * mining (bitcoin blake) hands out exactly those — the balance looks spendable
   * and every broadcast is rejected. Only shallow UTXOs cost an extra lookup.
   */
  async spendableUtxos() {
    const all = await this.utxos()
    if (!all.length) return { spendable: [], immature: 0 }
    const tip = Number(await (await this._api('/blocks/tip/height')).text())
    const spendable = []
    let immature = 0
    for (const utxo of all) {
      const height = utxo.status?.block_height
      const depth = height ? tip - height + 1 : 0
      if (depth < COINBASE_MATURITY && await this._isCoinbase(utxo.txid)) { immature += utxo.value; continue }
      spendable.push(utxo)
    }
    return { spendable, immature }
  }

  async history(limit = 12) {
    const txs = await (await this._api('/address/' + this.address + '/txs')).json()
    return txs.slice(0, limit).map((tx) => {
      let delta = 0
      for (const vin of tx.vin) if (vin.prevout?.scriptpubkey_address === this.address) delta -= vin.prevout.value
      for (const out of tx.vout) if (out.scriptpubkey_address === this.address) delta += out.value
      return { txid: tx.txid, delta, confirmed: tx.status.confirmed, time: tx.status.block_time }
    })
  }

  /** Largest amount send() can deliver right now (spendable UTXOs, minus fee). */
  async maxSendable({ feeRate } = {}) {
    const rate = feeRate ?? await this.feeRate()
    const { spendable } = await this.spendableUtxos()
    if (!spendable.length) return 0
    const inVb = this.taproot ? 57.5 : 68
    // two taproot outputs: the largest common case, so send() always fits
    const fee = Math.ceil(10.5 + inVb * spendable.length + 43 * 2) * rate
    return Math.max(0, spendable.reduce((sum, u) => sum + u.value, 0) - fee)
  }

  async feeRate() {
    try {
      const fees = await (await this._api('/v1/fees/recommended')).json()
      return Math.max(1, fees.hourFee ?? 1)
    } catch { return 2 }
  }

  /** Send sats to a bech32 address. Returns { txid, fee }. */
  async send(to, sats, { feeRate } = {}) {
    const { btc } = await loadLibs()
    sats = Math.floor(Number(sats))
    const params = this.netParams
    const minOut = dustThreshold(btc, to, params)
    if (!Number.isFinite(sats) || sats < minOut) {
      throw new Error(`amount below the dust limit for that address (${minOut} sats)`)
    }
    const rate = feeRate ?? await this.feeRate()
    const { spendable, immature } = await this.spendableUtxos()
    const utxos = spendable.sort((a, b) => b.value - a.value)
    if (!utxos.length) {
      throw new Error(immature
        ? `${immature.toLocaleString()} sats are freshly mined and need ${COINBASE_MATURITY} confirmations before they can be spent`
        : 'wallet is empty — hit a faucet first')
    }

    // Size every output by its real scriptPubKey. Taproot outputs are 43 vB;
    // assuming 31 (P2WPKH) here underpaid a taproot-to-taproot tip by ~24 vB,
    // which at a 1 sat/vB floor lands under min relay fee and is rejected (-26).
    const inVb = this.taproot ? 57.5 : 68
    const toVb = outputVbytes(btc, to, params)
    const changeVb = outputVbytes(btc, this.address, params)
    const vsize = (ins, withChange) => Math.ceil(10.5 + inVb * ins + toVb + (withChange ? changeVb : 0))
    const picked = []
    let inSum = 0, fee = 0
    for (const utxo of utxos) {
      picked.push(utxo)
      inSum += utxo.value
      fee = vsize(picked.length, true) * rate
      if (inSum >= sats + fee) break
    }
    if (inSum < sats + fee) {
      const short = `insufficient funds: have ${inSum.toLocaleString()}, need ${(sats + fee).toLocaleString()} (incl ~${fee} fee)`
      throw new Error(immature ? `${short}; another ${immature.toLocaleString()} sats are still maturing` : short)
    }

    const tx = new btc.Transaction()
    for (const utxo of picked) {
      const input = {
        txid: utxo.txid, index: utxo.vout,
        witnessUtxo: { script: this._spend.script, amount: BigInt(utxo.value) },
      }
      if (this.taproot) input.tapInternalKey = hexToBytes(this.scope)
      tx.addInput(input)
    }
    tx.addOutputAddress(to, BigInt(sats), params)
    // Change below its own dust threshold can't be created — it goes to the miner.
    const change = inSum - sats - fee
    if (change >= dustThreshold(btc, this.address, params)) {
      tx.addOutputAddress(this.address, BigInt(change), params)
    }
    tx.sign(this._priv)
    tx.finalize()

    let res
    try {
      res = await this._api('/tx', { method: 'POST', body: tx.hex })
    } catch (err) {
      throw new Error(explainBroadcastError(err.message || err))
    }
    const txid = (await res.text()).trim()
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(explainBroadcastError(txid))
    return { txid, fee: Number(tx.fee) }
  }

  /** Publish/merge this wallet's address into the user's kind-0 profile. */
  async publishAddressToProfile() {
    const signer = window.nostrSigner
    if (!signer) throw new Error('log in first')
    const me = window.nostrPubkey
    const existing = await defaultPool().get({ kinds: [0], authors: [me] })
    let content = {}
    if (existing) { try { content = JSON.parse(existing.content) } catch {} }
    content[this.net.profileField] = this.address
    const event = await signer.signEvent({
      kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [],
      content: JSON.stringify(content),
    })
    const results = await defaultPool().publish(event)
    if (!results.some((r) => r.ok)) throw new Error('no relay accepted the profile update')
    globalThis.__nostrClientProfiles?.cache?.set(me, content)
    return event
  }
}

/** Per-user singleton (re-created when the nostr login changes). */
export async function tipWallet(network = preferredNetwork()) {
  const scope = window.nostrPubkey ?? 'anon'
  const cache = (globalThis.__nostrClientBtcWallet ??= {})
  if (!cache.wallet || cache.scope !== scope || cache.network !== network) {
    cache.scope = scope
    cache.network = network
    cache.wallet = await new BtcWallet({ network, scope }).init()
  }
  return cache.wallet
}

/** BTC spot price (Coinbase), cached 5 min. Returns null offline. */
let _usd = null, _usdAt = 0, _usdInflight = null
export async function btcUsd() {
  if (_usd && Date.now() - _usdAt < 300_000) return _usd
  // every note card has a tip button and every tip button asks for the price,
  // so without in-flight dedup one feed paint fires ~30 parallel requests and
  // Coinbase rate-limits the lot
  _usdInflight ??= fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { signal: AbortSignal.timeout(8000) })
    .then((res) => res.json())
    .then((body) => { _usd = Number(body.data.amount); _usdAt = Date.now(); return _usd })
    .catch(() => _usd)
    .finally(() => { _usdInflight = null })
  return _usdInflight
}
export const satsToUsd = (sats, price) => price ? (sats / 1e8) * price : null

/** Compact relative time for a unix seconds stamp: "3m", "5h", "2d". */
export function ago(unixSeconds) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - (unixSeconds ?? 0))
  if (secs < 60) return secs + 's'
  if (secs < 3600) return Math.floor(secs / 60) + 'm'
  if (secs < 86_400) return Math.floor(secs / 3600) + 'h'
  return Math.floor(secs / 86_400) + 'd'
}

export const formatSats = (sats) =>
  sats >= 100_000_000 ? (sats / 100_000_000).toFixed(4) + ' BTC' : sats.toLocaleString() + ' sats'

/**
 * A balance at a glance, for somewhere with no room for the real number —
 * a nav item, a chip. 840 / 1.2k / 12M / 1.23 ₿. Deliberately rough: the
 * exact figure lives on the wallet card.
 */
export function formatSatsShort(sats) {
  const n = Math.max(0, Math.floor(Number(sats) || 0))
  const trim = (v, digits) => String(Number(v.toFixed(digits)))
  if (n >= 100_000_000) return trim(n / 100_000_000, 2) + '\u20bf'
  if (n >= 1_000_000) return trim(n / 1_000_000, 1) + 'M'
  if (n >= 100_000) return trim(n / 1_000, 0) + 'k'   // 209k, not 209.4k
  if (n >= 1_000) return trim(n / 1_000, 1) + 'k'
  return String(n)
}

// ------------------------------------------------------------ <nostr-wallet>

const WALLET_TEMPLATE = /* html */ `
<style>
  :host { display: block;
    font-family: var(--nc-font, ui-sans-serif, system-ui, sans-serif);
    font-size: .95rem; color: var(--nc-ink, #201d26); max-width: 26rem; }
  .card { background: var(--nc-surface, #fff); border: 1px solid var(--nc-line, #e9e6e0);
    border-radius: var(--nc-radius, 14px); box-shadow: var(--nc-shadow, 0 1px 2px rgb(32 27 51 / 6%));
    padding: 1.1rem 1.2rem; display: grid; gap: .8rem; }
  .head { display: flex; justify-content: space-between; align-items: baseline; }
  .head strong { font-size: 1.02rem; }
  .net { font-size: .68rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
    padding: .25em .8em; border-radius: 999px; background: #e5f3e9; color: #1d7a3f; }
  .net { text-decoration: none; }
  .net:hover { filter: brightness(.96); }
  .net.mainnet { background: #fdeaea; color: #c93a3a; }
  .balance { font-size: 1.9rem; font-weight: 800; letter-spacing: -0.02em; }
  .balance small { font-size: .85rem; font-weight: 500; color: var(--nc-soft, #6d6a76); }
  .addr { font-family: var(--nc-mono, ui-monospace, monospace); font-size: .72rem;
    overflow-wrap: anywhere; background: var(--nc-inset, #f4f2ee); padding: .55em .7em;
    border-radius: 8px; cursor: pointer; }
  .addr:hover { outline: 1px solid #f7931a; }
  canvas { width: 9rem; image-rendering: pixelated; border: 1px solid var(--nc-line, #e9e6e0);
    border-radius: 8px; justify-self: center; }
  form { display: grid; gap: .5rem; grid-template-columns: 1fr auto auto; }
  input { font: inherit; font-size: .82rem; font-family: var(--nc-mono, ui-monospace, monospace);
    padding: .5em .7em; border-radius: 8px; border: 1px solid var(--nc-line, #e9e6e0);
    background: var(--nc-inset, #f4f2ee); color: inherit; min-width: 0; }
  input[name=to] { grid-column: 1 / -1; }
  button { font: inherit; cursor: pointer; border: none; border-radius: 999px;
    padding: .5em 1.2em; font-weight: 700; background: #f7931a; color: #fff; }
  button:disabled { opacity: .45; cursor: default; }
  button.ghost { background: transparent; color: inherit; font-weight: 500;
    border: 1px solid var(--nc-line, #e9e6e0); font-size: .82rem; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  .status { font-size: .8rem; color: var(--nc-soft, #6d6a76); white-space: pre-wrap; overflow-wrap: anywhere; }
  .status a { color: #f7931a; }
  .hist { display: grid; gap: .3rem; font-size: .8rem; }
  .hist a { display: flex; justify-content: space-between; text-decoration: none;
    color: var(--nc-soft, #6d6a76); }
  .hist .in { color: var(--nc-ok, #17864f); font-weight: 600; }
  .hist .out { color: var(--nc-danger, #c93a3a); font-weight: 600; }
  .faucets { font-size: .78rem; color: var(--nc-faint, #a8a4b0); }
  .faucets a { color: #f7931a; }
</style>
<div class="card" id="card">loading wallet…</div>
`

class NostrWallet extends HTMLElement {
  constructor() {
    super()
    this.attachShadow({ mode: 'open' }).innerHTML = WALLET_TEMPLATE
    this.card = this.shadowRoot.getElementById('card')
    this._onAuth = () => this._boot()
    this._visible = false
    this._onVisible = () => { if (document.visibilityState === 'visible' && this._visible) this._refresh() }
  }

  connectedCallback() {
    window.addEventListener('nostr:login', this._onAuth)
    window.addEventListener('nostr:logout', this._onAuth)
    document.addEventListener('visibilitychange', this._onVisible)
    // Host pages hide inactive views with display:none, which does NOT stop a
    // custom element booting. Without this, every visitor — logged out, never
    // opening the Wallet tab — imported ~250KB of signing libs and polled a
    // block explorer every 30s forever. Only wake when actually on screen.
    this._io = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting)
      if (visible === this._visible) return
      this._visible = visible
      if (visible) this._boot(); else this._sleep()
    })
    this._io.observe(this)
  }

  disconnectedCallback() {
    window.removeEventListener('nostr:login', this._onAuth)
    window.removeEventListener('nostr:logout', this._onAuth)
    document.removeEventListener('visibilitychange', this._onVisible)
    this._io?.disconnect()
    this._sleep()
  }

  _sleep() { clearInterval(this._timer); this._timer = null }

  async _boot() {
    this._sleep()
    if (!this._visible) return
    // never mint a throwaway key for a logged-out visitor
    if (!window.nostrPubkey) {
      this.card.textContent = 'Log in to use the tip wallet.'
      return
    }
    try {
      this.wallet = await tipWallet(this.getAttribute('network') || preferredNetwork())
    } catch (err) {
      this.card.textContent = '✗ wallet failed to load: ' + (err.message || err)
      return
    }
    this._render()
    this._refresh()
    this._timer = setInterval(() => {
      if (document.visibilityState === 'visible') this._refresh()
    }, 30_000)
  }

  _render() {
    const w = this.wallet
    this.card.innerHTML = ''
    const head = document.createElement('div')
    head.className = 'head'
    const title = document.createElement('strong')
    title.textContent = '₿ tip wallet'
    const net = document.createElement('a')
    net.className = 'net' + (w.networkName === 'mainnet' ? ' mainnet' : '')
    net.href = w.net.explorer
    net.target = '_blank'; net.rel = 'noopener'
    net.textContent = networkLabel(w.networkName)
    net.title = w.net.blurb + ' — open the explorer'
    head.append(title, net)

    this.balanceEl = document.createElement('div')
    this.balanceEl.className = 'balance'
    this.balanceEl.textContent = '…'

    const addr = document.createElement('div')
    addr.className = 'addr'
    addr.textContent = w.address
    addr.title = 'click to copy'
    addr.onclick = () => { navigator.clipboard?.writeText(w.address); this.status.textContent = '✓ address copied' }

    this.qr = document.createElement('canvas')
    import(UQR_URL).then(({ encode }) => {
      const qr = encode('bitcoin:' + w.address)
      const scale = 4, margin = 2
      this.qr.width = this.qr.height = (qr.size + margin * 2) * scale
      const ctx = this.qr.getContext('2d')
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, this.qr.width, this.qr.height)
      ctx.fillStyle = '#201d26'
      qr.data.forEach((row, y) => row.forEach((on, x) => {
        if (on) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale)
      }))
    }).catch(() => this.qr.remove())

    const form = document.createElement('form')
    const to = document.createElement('input')
    to.name = 'to'; to.placeholder = 'send to tb1…'; to.spellcheck = false
    const amount = document.createElement('input')
    amount.name = 'sats'; amount.placeholder = 'sats'; amount.inputMode = 'numeric'
    const send = document.createElement('button')
    send.textContent = 'Send'
    const maxBtn = document.createElement('button')
    maxBtn.type = 'button'
    maxBtn.className = 'ghost'
    maxBtn.textContent = 'Max'
    maxBtn.onclick = async () => {
      maxBtn.disabled = true
      try { amount.value = String(await w.maxSendable()) } catch {}
      maxBtn.disabled = false
    }
    form.append(to, amount, maxBtn, send)

    this.status = document.createElement('div')
    this.status.className = 'status'

    form.onsubmit = async (e) => {
      e.preventDefault()
      send.disabled = true
      this.status.textContent = 'building + broadcasting…'
      try {
        const { txid, fee } = await w.send(to.value.trim(), Number(amount.value))
        const a = `${w.net.explorer}/tx/${txid}`
        this.status.innerHTML = ''
        const link = document.createElement('a')
        link.href = a; link.target = '_blank'; link.rel = 'noopener'
        link.textContent = txid.slice(0, 16) + '…'
        this.status.append(`✓ sent (fee ${fee} sats) — `, link)
        to.value = ''; amount.value = ''
        this._refresh()
      } catch (err) {
        this.status.textContent = '✗ ' + (err.message || err)
      } finally { send.disabled = false }
    }

    const row = document.createElement('div')
    row.className = 'row'
    let publish = document.createElement('button')
    publish.className = 'ghost'
    publish.textContent = 'Put address in my profile'
    publish.onclick = async () => {
      publish.disabled = true
      this.status.textContent = 'updating profile…'
      try { await w.publishAddressToProfile(); this.status.textContent = '✓ profile updated — people can tip you now' }
      catch (err) { this.status.textContent = '✗ ' + (err.message || err) }
      finally { publish.disabled = false }
    }
    if (w.nostrNative) {
      // no "publish address" here: tippers derive this exact address from the
      // npub, so there is nothing to announce. (A cold-wallet override can
      // still be set via the profile-editor's btc fields.)
      const tag = document.createElement('span')
      tag.className = 'faucets'
      tag.textContent = '🔑 this wallet IS your nostr key — anyone can tip your npub, no setup needed'
      row.append(tag)
    } else {
      const backup = document.createElement('button')
      backup.className = 'ghost'
      backup.textContent = 'Backup key'
      backup.onclick = () => { navigator.clipboard?.writeText(w.exportWIF()); this.status.textContent = '✓ WIF copied — store it safely' }
      row.append(backup)
    }
    if (!w.nostrNative) row.prepend(publish)

    this.hist = document.createElement('div')
    this.hist.className = 'hist'

    const faucets = document.createElement('div')
    faucets.className = 'faucets'
    if (w.net.faucets.length) {
      faucets.append('free testnet sats: ')
      w.net.faucets.forEach(({ url, name }, i) => {
        const a = document.createElement('a')
        a.href = url; a.target = '_blank'; a.rel = 'noopener'
        a.textContent = name
        faucets.append(i ? ' · ' : '', a)
      })
    }

    this.card.append(head, this.balanceEl, this.qr, addr, form, row, this.status, this.hist, faucets)
  }

  async _refresh() {
    if (this._refreshing) return
    this._refreshing = true
    try {
      const wallet = this.wallet
      // allSettled, not all: one 429 on /txs must not blank the balance too
      const [balRes, priceRes, histRes, spendRes] = await Promise.allSettled([
        wallet.balance(), btcUsd(), wallet.history(6), wallet.spendableUtxos(),
      ])
      if (this.wallet !== wallet) return // a re-boot overtook us
      if (balRes.status === 'rejected') {
        this.status.textContent = '⚠ could not reach ' + new URL(wallet.net.api).host
        return
      }
      const { total, mempool } = balRes.value
      const price = priceRes.status === 'fulfilled' ? priceRes.value : null
      const history = histRes.status === 'fulfilled' ? histRes.value : []
      const spend = spendRes.status === 'fulfilled' ? spendRes.value : { immature: 0 }

      const usd = satsToUsd(total, price)
      const bits = []
      if (total === 0) {
        bits.push(wallet.net.faucets.length
          ? 'empty — grab free sats from a faucet below'
          : 'empty — no faucet on this chain, coins come from mining')
      }
      if (usd !== null && total > 0) bits.push('\u2248 $' + usd.toFixed(usd < 10 ? 2 : 0) + (wallet.networkName === 'mainnet' ? '' : ' at mainnet price'))
      if (mempool) bits.push(`${mempool > 0 ? '+' : ''}${mempool} unconfirmed`)
      // freshly mined coins show up in the balance long before they can move
      if (spend.immature > 0) bits.push(`${spend.immature.toLocaleString()} still maturing`)
      const small = document.createElement('small')
      small.textContent = bits.length ? ' (' + bits.join(' \u00b7 ') + ')' : ''

      this.balanceEl.replaceChildren(formatSats(total), small)
      this.dispatchEvent(new CustomEvent('nostr:wallet-balance', { detail: { total }, bubbles: true, composed: true }))
      this.hist.innerHTML = ''
      for (const tx of history) {
        const a = document.createElement('a')
        a.href = wallet.net.explorer + '/tx/' + tx.txid
        a.target = '_blank'; a.rel = 'noopener'
        const what = document.createElement('span')
        what.textContent = tx.confirmed ? ago(tx.time) : '⏳ pending'
        what.title = tx.txid
        const amt = document.createElement('span')
        amt.className = tx.delta >= 0 ? 'in' : 'out'
        amt.textContent = (tx.delta >= 0 ? '+' : '−') + Math.abs(tx.delta).toLocaleString() + ' sats'
        a.append(what, amt)
        this.hist.append(a)
      }
    } catch { /* offline / rate limited — keep last shown */ }
    finally { this._refreshing = false }
  }
}

// --------------------------------------------------------- <btc-tip-button>

const TIP_TEMPLATE = /* html */ `
<style>
  :host { display: inline-block; position: relative;
    font-family: var(--nc-font, ui-sans-serif, system-ui, sans-serif); font-size: .8rem; }
  .btn { font: inherit; cursor: pointer; display: inline-flex; gap: .35em; align-items: center;
    background: none; color: var(--nc-soft, #6d6a76); border: 1px solid transparent;
    border-radius: 999px; padding: .25em .7em; }
  .btn:hover { background: #fff3e2; color: #b26205; }
  .menu { position: absolute; bottom: 120%; left: 0; z-index: 30; display: none;
    background: var(--nc-surface, #fff); border: 1px solid var(--nc-line, #e9e6e0);
    border-radius: 12px; box-shadow: var(--nc-shadow-pop, 0 8px 30px rgb(32 27 51 / 16%));
    padding: .6rem; width: 15rem; }
  .menu.open { display: block; }
  .presets { display: grid; grid-template-columns: repeat(3, 1fr); gap: .35rem; }
  .presets button { font: inherit; cursor: pointer; border: 1px solid var(--nc-line, #e9e6e0);
    background: none; color: inherit; border-radius: 8px; padding: .45em 0; font-weight: 600; }
  .presets button:hover { border-color: #f7931a; color: #b26205; background: #fff7ec; }
  .note { font-size: .72rem; color: var(--nc-faint, #a8a4b0); margin-top: .5rem; line-height: 1.35; }
  .note a { color: #f7931a; }
  .net { font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
    color: #1d7a3f; background: #e5f3e9; border-radius: 999px; padding: .15em .6em; }
  .net.real { color: #c93a3a; background: #fdeaea; }
  .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: .5rem; }
  .head b { font-size: .78rem; }
  .confirm { display: none; }
  .confirm.open { display: block; }
  .presets.hide { display: none; }
  .rows { display: grid; gap: .25rem; font-size: .74rem; margin-bottom: .6rem; }
  .rows div { display: flex; justify-content: space-between; gap: .6rem; }
  .rows span:first-child { color: var(--nc-faint, #a8a4b0); }
  .rows b { font-weight: 650; text-align: right; overflow-wrap: anywhere; }
  .warn { font-size: .72rem; color: #b26205; background: #fff7ec; border-radius: 8px;
    padding: .4em .6em; margin-bottom: .6rem; line-height: 1.35; }
  .warn.real { color: #c93a3a; background: #fdeaea; }
  .acts { display: grid; grid-template-columns: 1fr 1fr; gap: .4rem; }
  .acts button { font: inherit; font-size: .78rem; font-weight: 700; cursor: pointer;
    border-radius: 8px; padding: .5em 0; border: 1px solid var(--nc-line, #e9e6e0); background: none; color: inherit; }
  .acts .go { background: #f7931a; color: #fff; border-color: #f7931a; }
  .acts button:disabled { opacity: .5; cursor: default; }
</style>
<button class="btn" id="btn"><span>₿</span><span id="label">tip</span></button>
<div class="menu" id="menu">
  <div class="head"><b>Send a tip</b><span class="net" id="net"></span></div>
  <div class="presets" id="presets"></div>
  <div class="confirm" id="confirm">
    <div class="rows">
      <div><span>amount</span><b id="c-amt"></b></div>
      <div><span>network fee</span><b id="c-fee">…</b></div>
      <div><span>to</span><b id="c-to"></b></div>
    </div>
    <div class="warn" id="c-warn"></div>
    <div class="acts"><button id="c-cancel">Cancel</button><button class="go" id="c-go">Send</button></div>
  </div>
  <div class="note" id="note">on-chain sats, sent from your tip wallet</div>
</div>
`

const PRESETS = [500, 1000, 2100, 5000, 10000, 21000]

class BtcTipButton extends HTMLElement {
  constructor() {
    super()
    this.attachShadow({ mode: 'open' }).innerHTML = TIP_TEMPLATE
    this.$ = (id) => this.shadowRoot.getElementById(id)
    this._outside = (e) => { if (!e.composedPath().includes(this)) this.$('menu').classList.remove('open') }
  }

  connectedCallback() {
    const presets = this.$('presets')
    for (const sats of PRESETS) {
      const b = document.createElement('button')
      b.textContent = sats >= 1000 ? (sats / 1000) + 'k' : sats
      b.title = sats + ' sats'
      b.onclick = () => this._stage(sats)
      presets.append(b)
    }
    btcUsd().then((price) => {
      if (!price) return
      let i = 0
      for (const b of presets.children) {
        const usd = satsToUsd(PRESETS[i++], price)
        const sub = document.createElement('div')
        sub.style.cssText = 'font-size:.62rem;font-weight:400;color:var(--nc-faint,#a8a4b0)'
        sub.textContent = '\u2248$' + (usd < 1 ? usd.toFixed(2) : usd.toFixed(usd < 10 ? 2 : 0))
        b.append(sub)
      }
    })
    this.$('btn').onclick = () => this._open()
    document.addEventListener('click', this._outside)
  }

  disconnectedCallback() { document.removeEventListener('click', this._outside) }

  get _recipient() { return (this.getAttribute('pubkey') || '').toLowerCase() }

  _open() {
    if (!window.nostrPubkey) { this.$('label').textContent = 'log in to tip'; return }
    if (this._recipient === window.nostrPubkey) return
    const open = !this.$('menu').classList.contains('open')
    this.$('menu').classList.toggle('open', open)
    if (!open) return
    // a cached address from a previous network/recipient would send to the wrong
    // chain — every test chain shares the same tb1 address format
    const network = this.getAttribute('network') || preferredNetwork()
    if (this._addressFor !== this._recipient + ':' + network) this._address = null
    this._addressFor = this._recipient + ':' + network
    this._showPresets()
    const net = this.$('net')
    net.textContent = networkLabel(network)
    net.classList.toggle('real', network === 'mainnet')
    profiles().get(this._recipient, async (p) => {
      const field = NETWORKS[network].profileField
      this._published = !!p?.[field]
      this._address = p?.[field]
      if (!this._address) {
        // no published address? their npub IS an address (taproot key-path)
        this._address = await nostrAddress(this._recipient, network)
        this.$('note').textContent = 'they have not published a tip address; this goes to the address derived from their nostr key'
      }
    })
    if (!this._address) {
      nostrAddress(this._recipient, network).then((addr) => { this._address ??= addr })
    }
  }

  _showPresets() {
    this.$('presets').classList.remove('hide')
    this.$('confirm').classList.remove('open')
  }

  /**
   * Stage a tip for confirmation. Broadcasting bitcoin is irreversible, and this
   * button sits on every note in a scrolling feed — so show what is about to
   * happen (amount, real fee, destination, chain) and make the user say yes.
   */
  async _stage(sats) {
    if (!this._address) { this.$('note').textContent = 'still resolving their address — try again in a second'; return }
    const network = this.getAttribute('network') || preferredNetwork()
    this.$('presets').classList.add('hide')
    this.$('confirm').classList.add('open')
    this.$('c-amt').textContent = formatSats(sats)
    this.$('c-to').textContent = this._address.slice(0, 10) + '…' + this._address.slice(-6)
    this.$('c-to').title = this._address
    this.$('c-fee').textContent = 'estimating…'
    const warn = this.$('c-warn')
    warn.classList.toggle('real', network === 'mainnet')
    warn.textContent = network === 'mainnet'
      ? '⚠ REAL bitcoin on mainnet. This cannot be undone.'
      : this._published
        ? 'On-chain and irreversible. Chain: ' + networkLabel(network) + '.'
        : 'They have not published a tip address. This goes to an address derived from their nostr key — only spendable with their nsec, so a browser-extension user may not be able to claim it.'
    const go = this.$('c-go')
    go.disabled = false
    this.$('c-cancel').onclick = () => this._showPresets()
    go.onclick = () => { go.disabled = true; this._tip(sats) }
    // show the real fee this transaction will pay, before they commit
    try {
      const wallet = await tipWallet(network)
      const rate = await wallet.feeRate()
      this.$('c-fee').textContent = `~${rate} sat/vB`
    } catch { this.$('c-fee').textContent = 'unavailable' }
  }

  async _tip(sats) {
    const label = this.$('label')
    this.$('menu').classList.remove('open')
    this._showPresets()
    if (!this._address) return
    label.textContent = 'sending…'
    try {
      const wallet = await tipWallet(this.getAttribute('network') || preferredNetwork())
      const { txid } = await wallet.send(this._address, sats)
      label.textContent = '✓ ' + formatSats(sats)
      // social proof receipt
      const signer = window.nostrSigner
      if (signer) {
        const tags = [['p', this._recipient], ['t', 'onchain-tip'], ['t', wallet.networkName], ['amount', String(sats)], ['tx', txid]]
        const eventId = this.getAttribute('event-id')
        if (/^[0-9a-f]{64}$/.test(eventId ?? '')) tags.push(['e', eventId])
        const event = await signer.signEvent({
          kind: 1, created_at: Math.floor(Date.now() / 1000), tags,
          content: `₿ tipped ${sats} sats (${wallet.networkName})\n${wallet.net.explorer}/tx/${txid}`,
        })
        defaultPool().publish(event)
      }
      setTimeout(() => { label.textContent = 'tip' }, 4000)
    } catch (err) {
      label.textContent = 'tip'
      this.$('note').textContent = '✗ ' + (err.message || err)
      this.$('menu').classList.add('open')
    }
  }
}

if (!customElements.get('nostr-wallet')) customElements.define('nostr-wallet', NostrWallet)
if (!customElements.get('btc-tip-button')) customElements.define('btc-tip-button', BtcTipButton)
