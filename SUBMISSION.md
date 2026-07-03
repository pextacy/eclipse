# Eclipse — Flare Summer Signal submission

**Project:** Eclipse — a confidential dark pool for FXRP on Flare.
**Bounties:** **Bounty 1 — Interoperable Asset Products** *and* **Bounty 2 —
Confidential Compute Apps**. Eclipse is eligible for both.
**Network:** Coston2 (chainId 114).

## One-line description

Traders escrow FXRP + USDT0 and submit **encrypted** limit orders to a matching
engine running inside a Flare Confidential Compute TEE; the engine clears batches
at a single **FTSO-bounded** price and settles only the **net** result on Flare —
the order book is never public, so large orders can't be front-run.

## The problem

Every trade on a public chain is visible before it executes. A large FXRP order
sitting in the mempool tells bots exactly what to trade against — the originator
gets a worse fill and the difference is extracted (sandwiching). Funds also leak
their position changes to competitors. This is precisely the gap Flare's
institutional thesis names, and what Confidential Compute exists to close.

## Target user

Desks and funds moving size in FXRP (and, over time, other FAssets) who lose money
to front-running on public AMMs/order books; treasuries/OTC desks that want to
rebalance without broadcasting intent.

## How it uses Flare (three protocols, all load-bearing)

- **FAssets / FXRP** — the traded asset. Real Coston2 ERC-20, resolved dynamically
  via `AssetManager.fAsset()` (no hardcoded address).
- **Flare Confidential Compute (FCC)** — the matching engine runs as an attested
  TEE extension; the settlement is signed by the attested machine, and the chain
  only accepts a signature bound to a **whitelisted, reproducible-build code-hash**.
- **FTSOv2** — the XRP/USD block-latency feed is read *in the settlement tx* and
  enforces a fairness band on the clearing price: `|clearingPrice − FTSO| ≤ BAND_BPS`.

## What's new vs pre-existing

- **Pre-existing (dependencies, not our work):** FXRP/FAssets, FTSOv2, the FCC TEE
  framework, Coston2.
- **Newly built for the hackathon:** the `EclipseSettlement` + `EclipseRegistry`
  contracts, the sealed-order encryption scheme, the TEE batch-auction matching
  engine and its signed net-settlement output, the on-chain FTSO band enforcement,
  the untrusted relay, and the trader console + front-running comparison UI.

## Why it stands out

1. **Confidential *and* trustless** — a sealed order book inside an attested TEE,
   *and* on-chain proof the settlement came from a whitelisted build. Privacy
   without trusting the operator.
2. **The chain trusts the build, not the operator.** The relay has no custody and
   no signing authority; a modified engine has a different code-hash and is
   rejected. No "trusted sequencer" that can reorder/censor/extract.
3. **Publicly checkable fairness via FTSO** — verify the batch cleared at an
   oracle-fair price without ever seeing an order.
4. **Net-only settlement** — orders and per-order fills never touch the chain.
5. **Uniform-price batch auction** structurally removes the sandwich surface.
6. **Always-redeemable custody** — no admin seizure path; idle escrow withdrawable
   anytime, locked legs auto-release after expiry.
7. **The demo is the differentiator** — a public-DEX order visibly sandwiched (a
   real loss number) vs the same order through Eclipse with nothing leaking.

## Deployed addresses (Coston2)

Fill after `pnpm --filter @eclipse/scripts deploy` (written to
`deployments/coston2.json`):

| Contract | Address |
|----------|---------|
| EclipseSettlement | `0x…` |
| EclipseRegistry | `0x…` |
| FXRP (resolved) | `0x…` |
| USDT0 | `0x…` |

## Links

- **Repo:** this repository.
- **Demo video:** _add link_.
- **Live demo / how to run:** [`DEMO.md`](DEMO.md).
- **Architecture + integration:** [`docs/docs.md`](docs/docs.md).
- **Attestation + reproducible build:** [`tee/ATTESTATION.md`](tee/ATTESTATION.md).

## Verifiability (what a judge can check)

- An end-to-end batch settled on Coston2 with an explorer link (`demo:batch`).
- Identical large order → measurable loss on a public DEX vs zero leakage on
  Eclipse (comparison view).
- Negative tests: a non-whitelisted code-hash reverts (`UnattestedSigner`); an
  out-of-band clearing price reverts (`PriceOutsideBand`). Local suite:
  `pnpm --filter @eclipse/contracts test` (15 passing, happy + every abuse path).

## Roadmap

Verified-counterparty (KYC-gated) pools; direct FXRP entry via Smart Accounts
(XRPL Payment → deposit, no Flare gas for the trader); multi-asset as more FAssets
go live; continuous confidential matching; Songbird → Flare mainnet as FCC rolls out.
