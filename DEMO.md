# Eclipse — live Coston2 demo runbook

Every step ends with something clickable on the
[Coston2 explorer](https://coston2-explorer.flare.network). Nothing here is a
local-only stub.

## 0. Prerequisites

```bash
pnpm install
pnpm --filter @eclipse/shared build
cp .env.example .env      # then fill in the keys below
```

Fill `.env`:
- `DEPLOYER_PRIVATE_KEY` — desk A + gas payer. **Fund it** with C2FLR (Coston2 faucet),
  FXRP (FAssets), and the quote ERC-20 you use for `USDT0_ADDRESS`. Confirm on the explorer.
- `DEMO_DESK_B_PRIVATE_KEY` — desk B (the other side of the demo batch), also funded.
- `ENGINE_SIGNER_PRIVATE_KEY` — the engine's settlement signing key (dev key for
  Phase 1–2; the attested FCC signer for Phase 3). Set `ALLOW_DEV_SIGNER=true` to let
  `deploy` auto-register the dev signer under a placeholder code-hash (dev only).
- `USDT0_ADDRESS` — the quote ERC-20. **No canonical USDT0 exists on Coston2** (it's a Flare
  *mainnet* token), so supply your own quote token here (a deployed test stablecoin, or WNat).
- `ASSET_MANAGER_ADDRESS` — the FXRP AssetManager (used to resolve FXRP via
  `fAsset()`); only needed if the registry's `AssetManagerController` lookup can't
  find it automatically.

## 1. Phase 0 — plumbing

```bash
pnpm --filter @eclipse/scripts resolve         # prints LIVE registry-resolved addresses
TO_ADDRESS=0x... pnpm --filter @eclipse/scripts transfer:fxrp   # moves 1 FXRP → explorer link
```

## 2. Phase 1 — deploy contracts

```bash
pnpm --filter @eclipse/contracts build
pnpm --filter @eclipse/scripts deploy          # → deployments/coston2.json + explorer links
```

Verify the source on the Blockscout explorer:

```bash
pnpm --filter @eclipse/contracts exec hardhat verify --network coston2 \
  <eclipseSettlement> <flareRegistry> <eclipseRegistry> <fxrp> <usdt0> <feedId> <bandBps>
```

## 3. Phase 3 — attested signer (do before the real demo batch)

```bash
# Reproducible build → deterministic code-hash
SOURCE_DATE_EPOCH=1700000000 pnpm --filter @eclipse/tee build:reproducible

# Whitelist the attested signer bound to that code-hash
ENGINE_CODE_HASH=<hash> ENGINE_SIGNER_ADDRESS=<attested signer> \
  pnpm --filter @eclipse/scripts register:codehash
```

(For the Phase 1–2 dev path, the deploy script can register a dev signer if
`ENGINE_SIGNER_PRIVATE_KEY` is set. See `tee/ATTESTATION.md` for the full
attestation flow and the Confidential-VM fallback.)

## 4. Phase 2 — end-to-end sealed batch

```bash
pnpm --filter @eclipse/scripts demo:batch
# 4 sealed orders → one clearing price + net deltas → REAL commitBatch + settleBatch
# prints the two explorer tx links
```

Prove nothing leaked: the order contents never appear on-chain (only net deltas)
and never appear in relay logs.

## 5. Phase 4 — the winning screen

```bash
# optional: run engine + relay so the console can seal/submit live
pnpm --filter @eclipse/tee start        # engine (publishes sealed public key)
pnpm --filter @eclipse/relay start      # untrusted relay
pnpm --filter @eclipse/web dev          # trader console + comparison + verifier
```

Drive it end to end:
1. **Trader console** — deposit escrow, submit a sealed order, watch the batch settle (explorer links).
2. **Comparison view** — the same large order on a public DEX (sandwiched, a
   concrete loss number) vs Eclipse (nothing in the mempool, uniform FTSO-fair fill).
3. **Verifier panel** — anyone reads the whitelisted code-hash, the attested
   signer, and the FTSO reference for the latest batch, straight from chain.

## Negative paths a judge can trigger

- Settlement from a **non-whitelisted** build → `UnattestedSigner()` (revert).
- Clearing price outside the FTSO band → `PriceOutsideBand()`.
- Withdraw with an open matched leg → `OpenMatchedLeg()`; idle escrow always withdrawable.
- Reused nonce → `ReplayedBatch()`; non-conserving deltas → `UnbalancedBatch()`.

All of these are covered by the local test suite (`pnpm --filter @eclipse/contracts test`).
