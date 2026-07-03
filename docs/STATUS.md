# Eclipse — Phase status map

Maps each phase in `phases.md` to what is implemented in the repo and to the
on-chain proof that still needs a funded Coston2 key to execute.

| Phase | Built (in repo, tested locally) | On-chain proof (needs funded key) |
|-------|----------------------------------|-----------------------------------|
| **0 — Foundations** | pnpm monorepo, Hardhat cancun config, `.env.example`, CI, `scripts/resolveAddresses.ts` (registry lookups, FXRP via `AssetManager.fAsset()`), `scripts/transferFxrp.ts` | `pnpm --filter @eclipse/scripts resolve` prints live addresses; `transfer:fxrp` moves 1 FXRP |
| **1 — Settlement + escrow** | `EclipseSettlement.sol` + `EclipseRegistry.sol`; FTSO band, conservation, nonce/replay, escrow-cover, custody guard, auto-release; **15 Hardhat tests green** (happy + every abuse path) | `deploy` publishes + verify; a signed `settleBatch` net transfer |
| **2 — Sealed orders + engine + relay** | sealed-box orders (`tweetnacl`), uniform-price batch auction (exact conservation), engine signer (EIP-712), untrusted relay (zod, no plaintext logs); **9 engine + 4 relay tests green** | `demo:batch`: 4 sealed orders → one clearing price → real `settleBatch` |
| **3 — FCC attestation** | FCC extension wrapper (`fce-sign` shape), reproducible build → deterministic code-hash (`build:reproducible`), attested-key registration model, `registerCodeHash.ts`; **6 code-hash/attestation tests green**; `tee/ATTESTATION.md` + CVM fallback + Day-11 decision | `register:codehash` whitelists the attested signer; non-whitelisted build reverts |
| **4 — Frontend + demo** | React+Vite+wagmi/viem+Tailwind, flat/no-gradient terminal UI: trader console, **front-running comparison (concrete loss number)**, public verifier panel | drive the full flow; explorer links on every action |
| **5 — Harden + submit** | all negative-path tests finalized (incl. double-withdraw); `README.md`, `DEMO.md`, `SUBMISSION.md`, this map; `docs.md` run steps updated | verified contracts + recorded video for submission |

## Test summary (local, no network)

```
contracts   16 passing   (deposit/withdraw, double-withdraw, happy settle, UnattestedSigner,
                           PriceOutsideBand, band-edge, UnbalancedBatch, ReplayedBatch,
                           InsufficientEscrow, NotCommitted, custody guard, auto-release,
                           registry auth/revoke)
tee         15 passing   (auction cross/volume/tie-break/conservation/band, sealed-box round-trip,
                           engine end-to-end signature recovery, reproducible code-hash, attestation)
relay        4 passing   (malformed envelope rejected, no plaintext in logs, no-cross, empty batch)
web         builds clean (vite production build + strict typecheck; flat/no-gradient verified)
```

## What needs the user

Funding the deployer from the Coston2 faucet (C2FLR + FXRP + USDT0), then running
the deploy + demo commands with `.env` filled in. Real FCC extension registration
(or the documented Confidential-VM fallback) for the attested signer. Everything
is deploy-ready; see `DEMO.md`.
