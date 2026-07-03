# Eclipse — Phase status map

Maps each phase in `phases.md` to what is implemented in the repo and to the
on-chain proof that still needs a funded Coston2 key to execute.

| Phase | Built (in repo, tested locally) | On-chain proof (needs funded key) |
|-------|----------------------------------|-----------------------------------|
| **0 — Foundations** | pnpm monorepo, Hardhat cancun config, `.env.example`, CI, `scripts/resolveAddresses.ts` (registry lookups, FXRP via `AssetManager.fAsset()`), `scripts/transferFxrp.ts` | `pnpm --filter @eclipse/scripts resolve` prints live addresses; `transfer:fxrp` moves 1 FXRP |
| **1 — Settlement + escrow** | `EclipseSettlement.sol` + `EclipseRegistry.sol`; FTSO band, conservation, nonce/replay, escrow-cover, custody guard, auto-release; **16 Foundry Coston2-fork tests green — NO MOCKS** (happy + every abuse path, against the real registry/FTSO/FXRP) | `deploy` publishes + verify; a signed `settleBatch` net transfer |
| **2 — Sealed orders + engine + relay** | sealed-box orders (`tweetnacl`), uniform-price batch auction (exact conservation), engine signer (EIP-712), untrusted relay (zod, no plaintext logs); **9 engine + 4 relay tests green** | `demo:batch`: 4 sealed orders → one clearing price → real `settleBatch` |
| **3 — FCC attestation** | FCC extension wrapper (`fce-sign` shape), reproducible build → deterministic code-hash (`build:reproducible`), attested-key registration model, `registerCodeHash.ts`; **6 code-hash/attestation tests green**; `tee/ATTESTATION.md` + CVM fallback + Day-11 decision | `register:codehash` whitelists the attested signer; non-whitelisted build reverts |
| **4 — Frontend + demo** | React+Vite+wagmi/viem+Tailwind, flat/no-gradient terminal UI: trader console, **front-running comparison (concrete loss number)**, public verifier panel | drive the full flow; explorer links on every action |
| **5 — Harden + submit** | all negative-path tests finalized (incl. double-withdraw); `README.md`, `DEMO.md`, `SUBMISSION.md`, this map; `docs.md` run steps updated | verified contracts + recorded video for submission |

## Test summary

```
contracts   16 passing   FOUNDRY COSTON2 FORK — NO MOCKS. Forks Coston2 at a pinned block and
                         runs against the REAL FlareContractRegistry, FtsoV2 (live XRP/USD value),
                         FeeCalculator, FXRP FAsset, and WNat. Balances are real: FXRP transferred
                         from a real holder, WNat minted 1:1 from native. Covers deposit/withdraw,
                         double-withdraw, happy settle, UnattestedSigner, PriceOutsideBand, band-edge,
                         UnbalancedBatch, ReplayedBatch, InsufficientEscrow, NotCommitted, custody
                         guard, auto-release, registry auth/revoke.
                         Run: cd contracts && forge test   (needs Coston2 RPC access)
tee         19 passing   (auction cross/volume/tie-break/conservation/band, STRADDLING cross at the
                         FTSO ref, dust-cross rejection, sealed-box round-trip, engine end-to-end
                         signature recovery + replay guard, reproducible code-hash w/ pinned manifests,
                         attestation registration requiring hardware-quote verification)
relay        4 passing   (malformed envelope rejected, no plaintext in logs, no-cross, empty batch)
web         builds clean (vite production build + strict typecheck; flat/no-gradient verified)
```

There are **no mock contracts anywhere in the repo** — the settlement suite exercises
the real Coston2 protocol contracts by forking.

## What needs the user

Funding the deployer from the Coston2 faucet (C2FLR) plus FXRP (FAssets) and a quote
ERC-20 for the `USDT0_ADDRESS` slot — note there is **no canonical USDT0 on Coston2**
(USDT0 is a Flare *mainnet* token), so the operator supplies the quote token. Then run
the deploy + demo commands with `.env` filled in. Real FCC extension registration (or the
documented Confidential-VM fallback) for the attested signer. Everything is deploy-ready;
see `DEMO.md`.
