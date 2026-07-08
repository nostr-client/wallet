/**
 * wallet.js — an in-browser bitcoin wallet for nostr tipping. TESTNET-FIRST.
 * No build step. Crypto from pinned CDN ESM (@scure/btc-signer, @noble/curves);
 * chain data from mempool.space. Keys never leave the browser.
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
 * SECURITY: the key is a hot wallet in localStorage, scoped per nostr pubkey.
 * Treat it like pocket change. Testnet by default — sats from a faucet.
 */

import { defaultPool } from 'https://nostr-client.github.io/pool/pool.js'
import { profiles } from 'https://nostr-client.github.io/note/note.js'

const SIGNER_URL = 'https://esm.sh/@scure/btc-signer@1.4.0'
const CURVES_URL = 'https://esm.sh/@noble/curves@1.6.0/secp256k1'
const UQR_URL = 'https://esm.sh/uqr@0.1.2'

export const NETWORKS = {
  testnet4: {
    api: 'https://mempool.space/testnet4/api',
    explorer: 'https://mempool.space/testnet4',
    unit: 'tsat', coin: 'tBTC',
    profileField: 'btc_test',
    faucets: [
      'https://coinfaucet.eu/en/btc-testnet4/',
      'https://faucet.testnet4.dev/',
    ],
  },
  testnet: {
    api: 'https://mempool.space/testnet/api',
    explorer: 'https://mempool.space/testnet',
    unit: 'tsat', coin: 'tBTC',
    profileField: 'btc_test',
    faucets: [
      'https://bitcoinfaucet.uo1.net/',
      'https://coinfaucet.eu/en/btc-testnet/',
      'https://testnet-faucet.com/btc-testnet/',
    ],
  },
  mainnet: {
    api: 'https://mempool.space/api',
    explorer: 'https://mempool.space',
    unit: 'sat', coin: 'BTC',
    profileField: 'btc',
    faucets: [],
  },
}

const storageKey = (network, scope) => `nostr-client:btc-wallet:${network}:${scope}`
const NET_PREF_KEY = 'nostr-client:btc-network'

/** The user's chosen network (Settings). Default: testnet4. */
export function preferredNetwork() {
  const saved = localStorage.getItem(NET_PREF_KEY)
  return NETWORKS[saved] ? saved : 'testnet4'
}
export function setPreferredNetwork(network) {
  if (!NETWORKS[network]) throw new Error('unknown network: ' + network)
  localStorage.setItem(NET_PREF_KEY, network)
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
    const res = await fetch(this.net.api + path, options)
    if (!res.ok) throw new Error(`mempool.space ${res.status}: ${(await res.text()).slice(0, 120)}`)
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

  async history(limit = 12) {
    const txs = await (await this._api('/address/' + this.address + '/txs')).json()
    return txs.slice(0, limit).map((tx) => {
      let delta = 0
      for (const vin of tx.vin) if (vin.prevout?.scriptpubkey_address === this.address) delta -= vin.prevout.value
      for (const out of tx.vout) if (out.scriptpubkey_address === this.address) delta += out.value
      return { txid: tx.txid, delta, confirmed: tx.status.confirmed, time: tx.status.block_time }
    })
  }

  /** Largest amount send() can deliver right now (all UTXOs, minus fee). */
  async maxSendable({ feeRate } = {}) {
    const rate = feeRate ?? await this.feeRate()
    const utxos = await this.utxos()
    if (!utxos.length) return 0
    const inVb = this.taproot ? 57.5 : 68
    const fee = Math.ceil(10.5 + inVb * utxos.length + 31 * 2) * rate
    return Math.max(0, utxos.reduce((sum, u) => sum + u.value, 0) - fee)
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
    if (!Number.isFinite(sats) || sats < 294) throw new Error('amount below dust limit (294 sats)')
    const rate = feeRate ?? await this.feeRate()
    const utxos = (await this.utxos()).sort((a, b) => b.value - a.value)
    if (!utxos.length) throw new Error('wallet is empty — hit a faucet first')

    const inVb = this.taproot ? 57.5 : 68
    const vsize = (ins, outs) => Math.ceil(10.5 + inVb * ins + 31 * outs)
    const picked = []
    let inSum = 0, fee = 0
    for (const utxo of utxos) {
      picked.push(utxo)
      inSum += utxo.value
      fee = vsize(picked.length, 2) * rate
      if (inSum >= sats + fee) break
    }
    if (inSum < sats + fee) throw new Error(`insufficient funds: have ${inSum}, need ${sats + fee} (incl ~${fee} fee)`)

    const tx = new btc.Transaction()
    for (const utxo of picked) {
      const input = {
        txid: utxo.txid, index: utxo.vout,
        witnessUtxo: { script: this._spend.script, amount: BigInt(utxo.value) },
      }
      if (this.taproot) input.tapInternalKey = hexToBytes(this.scope)
      tx.addInput(input)
    }
    tx.addOutputAddress(to, BigInt(sats), this.netParams)
    const change = inSum - sats - fee
    if (change >= 294) tx.addOutputAddress(this.address, BigInt(change), this.netParams)
    tx.sign(this._priv)
    tx.finalize()

    const res = await this._api('/tx', { method: 'POST', body: tx.hex })
    const txid = (await res.text()).trim()
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('broadcast failed: ' + txid.slice(0, 120))
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
let _usd = null, _usdAt = 0
export async function btcUsd() {
  if (_usd && Date.now() - _usdAt < 300_000) return _usd
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot')
    _usd = Number((await res.json()).data.amount)
    _usdAt = Date.now()
  } catch {}
  return _usd
}
export const satsToUsd = (sats, price) => price ? (sats / 1e8) * price : null

export const formatSats = (sats) =>
  sats >= 100_000_000 ? (sats / 100_000_000).toFixed(4) + ' BTC' : sats.toLocaleString() + ' sats'

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
  }

  connectedCallback() {
    window.addEventListener('nostr:login', this._onAuth)
    window.addEventListener('nostr:logout', this._onAuth)
    this._boot()
  }

  disconnectedCallback() {
    window.removeEventListener('nostr:login', this._onAuth)
    window.removeEventListener('nostr:logout', this._onAuth)
    clearInterval(this._timer)
  }

  async _boot() {
    clearInterval(this._timer)
    try {
      this.wallet = await tipWallet(this.getAttribute('network') || preferredNetwork())
    } catch (err) {
      this.card.textContent = '✗ wallet failed to load: ' + (err.message || err)
      return
    }
    this._render()
    this._refresh()
    this._timer = setInterval(() => this._refresh(), 30_000)
  }

  _render() {
    const w = this.wallet
    this.card.innerHTML = ''
    const head = document.createElement('div')
    head.className = 'head'
    const title = document.createElement('strong')
    title.textContent = '₿ tip wallet'
    const net = document.createElement('span')
    net.className = 'net' + (w.networkName === 'mainnet' ? ' mainnet' : '')
    net.textContent = w.networkName === 'testnet' ? 'testnet3' : w.networkName
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
      const tag = document.createElement('span')
      tag.className = 'faucets'
      tag.textContent = '🔑 this wallet IS your nostr key — anyone can tip your npub, your nsec spends it'
      row.append(tag)
    } else {
      const backup = document.createElement('button')
      backup.className = 'ghost'
      backup.textContent = 'Backup key'
      backup.onclick = () => { navigator.clipboard?.writeText(w.exportWIF()); this.status.textContent = '✓ WIF copied — store it safely' }
      row.append(backup)
    }
    row.prepend(publish)

    this.hist = document.createElement('div')
    this.hist.className = 'hist'

    const faucets = document.createElement('div')
    faucets.className = 'faucets'
    if (w.net.faucets.length) {
      faucets.append('free testnet sats: ')
      w.net.faucets.forEach((url, i) => {
        const a = document.createElement('a')
        a.href = url; a.target = '_blank'; a.rel = 'noopener'
        a.textContent = 'faucet ' + (i + 1)
        faucets.append(i ? ' · ' : '', a)
      })
    }

    this.card.append(head, this.balanceEl, this.qr, addr, form, row, this.status, this.hist, faucets)
  }

  async _refresh() {
    try {
      const { total, mempool } = await this.wallet.balance()
      this.balanceEl.innerHTML = ''
      this.balanceEl.append(formatSats(total))
      const small = document.createElement('small')
      const price = await btcUsd()
      const usd = satsToUsd(total, price)
      const bits = []
      if (total === 0 && this.wallet.net.faucets.length) bits.push('empty — grab free sats from a faucet below')
      if (usd !== null && total > 0) bits.push('\u2248 $' + usd.toFixed(usd < 10 ? 2 : 0) + (this.wallet.networkName === 'mainnet' ? '' : ' at mainnet price'))
      if (mempool) bits.push(`${mempool > 0 ? '+' : ''}${mempool} unconfirmed`)
      small.textContent = bits.length ? ' (' + bits.join(' \u00b7 ') + ')' : ''
      this.balanceEl.append(small)
      this.dispatchEvent(new CustomEvent('nostr:wallet-balance', { detail: { total }, bubbles: true, composed: true }))
      const history = await this.wallet.history(6)
      this.hist.innerHTML = ''
      for (const tx of history) {
        const a = document.createElement('a')
        a.href = this.wallet.net.explorer + '/tx/' + tx.txid
        a.target = '_blank'; a.rel = 'noopener'
        const what = document.createElement('span')
        what.textContent = (tx.confirmed ? '' : '⏳ ') + tx.txid.slice(0, 12) + '…'
        const amt = document.createElement('span')
        amt.className = tx.delta >= 0 ? 'in' : 'out'
        amt.textContent = (tx.delta >= 0 ? '+' : '') + tx.delta.toLocaleString()
        a.append(what, amt)
        this.hist.append(a)
      }
    } catch { /* offline / rate limited — keep last shown */ }
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
</style>
<button class="btn" id="btn"><span>₿</span><span id="label">tip</span></button>
<div class="menu" id="menu">
  <div class="presets" id="presets"></div>
  <div class="note" id="note">on-chain sats, sent instantly from your tip wallet</div>
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
      b.onclick = () => this._tip(sats)
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
    this.$('menu').classList.toggle('open')
    profiles().get(this._recipient, async (p) => {
      const network = this.getAttribute('network') || preferredNetwork()
      const field = NETWORKS[network].profileField
      this._address = p?.[field]
      if (!this._address) {
        // no published address? their npub IS an address (taproot key-path)
        this._address = await nostrAddress(this._recipient, network)
        this.$('note').textContent = 'sent to the address derived from their nostr key — spendable with their nsec'
      }
    })
    if (!this._address) {
      const network = this.getAttribute('network') || preferredNetwork()
      nostrAddress(this._recipient, network).then((addr) => { this._address ??= addr })
    }
  }

  async _tip(sats) {
    const label = this.$('label')
    this.$('menu').classList.remove('open')
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
