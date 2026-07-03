# Eclipse — Implementation Plan

Milestone plan to a working, no-mock Coston2 demo by the **Aug 14** submission deadline. Ordered so that something is verifiable on-chain as early as possible, then hardened.

Guiding rule: **every milestone ends with something deployed and clickable on the Coston2 explorer.** No milestone is "done" as a local-only stub.

---

## Phase 0 — Foundations (Days 1–3)

**Goal:** wallet + repo + real assets moving on Coston2.

- Set up repo per `CLAUDE.md` layout. Foundry + Hardhat, EVM version `cancun`, Solidity `0.8.x`.
- Add Coston2 network config: chainId `114`, RPC `https://coston2-api.flare.network/ext/C/rpc`, explorer `https://coston2-explorer.flare.network`.
- Fund a wallet from the **Coston2 faucet** (C2FLR gas + FXRP + USDT0). Confirm balances on the explorer.
- Write `ContractRegistry` resolver script: fetch `FtsoV2`, `FdcHub`, and FAssets `AssetManager` addresses from `FlareContractRegistry` (`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`); resolve FXRP via `AssetManager.fAsset()`. **No hardcoded addresses.**

**Exit criteria:** a script prints live registry-resolved addresses and moves 1 test FXRP between two addresses on Coston2.

## Phase 1 — Settlement contract + escrow (Days 4–7)

**Goal:** trustless escrow with net settlement, gated by a placeholder signer (replaced with the real attested signer in Phase 3).

- `EclipseSettlement.sol`:
  - `deposit(token, amount)` / `withdraw(token, amount)` for FXRP + USDT0, `SafeERC20`, `ReentrancyGuard`, per-account escrow accounting.
  - `settleBatch(Settlement calldata s, bytes signature)` — verifies signer, checks the FTSO band, applies net deltas per account, emits `BatchSettled`.
  - Withdrawal blocked while an account has an open matched leg in an unsettled batch.
  - Custom errors, event on every state change.
- `EclipseRegistry.sol` (thin wrapper): holds the current authorized settlement signer + whitelisted code-hash set; owner can register/revoke (owner = governance/multisig in prod).
- FTSO integration: read XRP/USD (`FtsoV2Interface`, feed id `0x015852502f55534400000000000000000000000000`) and enforce `|clearingPrice − ftso| ≤ BAND_BPS`.

**Exit criteria:** deposit → `settleBatch` (signed by a dev key registered in `EclipseRegistry`) → net transfer executes on Coston2; out-of-band price reverts; withdraw-with-open-leg reverts. Tests green, contract verified on explorer.

## Phase 2 — Sealed orders + matching engine (Days 6–10, overlaps Phase 1)

**Goal:** the batch auction logic and the sealed-order transport, running as an ordinary service first, then moved into the TEE in Phase 3.

- Order schema: `{side, baseAmount (FXRP), limitPrice, account, nonce, expiry}`. Encrypt to the engine's public key (sealed box). Relay only ever sees ciphertext.
- Batch auction: collect orders for the interval, compute a **single uniform clearing price** that maximizes matched volume, clamp/validate against the FTSO band, compute **net** deltas per account, and produce a `Settlement` struct.
- Relay (`/relay`): stateless intake of encrypted orders, forwards to engine, relays the signed `Settlement` to `settleBatch`. Untrusted by design; zod-validate all input.

**Exit criteria:** submit 4 encrypted orders → engine returns one clearing price + net deltas → relay lands a real `settleBatch` tx on Coston2. Order contents never appear on-chain or in relay logs.

## Phase 3 — Move the engine into FCC (real attestation) (Days 9–13)

**Goal:** replace the dev signer with a **real attested TEE signer**. This is the milestone that makes Eclipse a Confidential Compute app, not just a private server.

- Scaffold the engine as an FCC extension from `fce-extension-scaffold`. Wire signing via the `fce-sign` pattern so the extension signs each `Settlement`.
- **Reproducible build:** pin `SOURCE_DATE_EPOCH` + toolchain so the extension's code-hash is deterministic.
- Register the code-hash in `TeeMachineRegistry`/`TeeExtensionRegistry`; point `EclipseRegistry` at the attested signer bound to that code-hash.
- `EclipseSettlement.settleBatch` now requires the signature to come from a signer bound to a whitelisted code-hash; anything else reverts.
- **Documented fallback (if FCC extension registration isn't live on Coston2 in time):** run the engine in a real Confidential VM (Intel TDX / AMD SEV-SNP, e.g. a confidential-compute VM), attest it, and register its attestation-bound signing key. Same trust model, still no mock. Decide by Day 11 which path ships.

**Exit criteria:** a settlement signed by the **attested** engine settles on Coston2; a settlement signed by any non-whitelisted build reverts. Verified on explorer.

## Phase 4 — Front-end + the winning demo (Days 12–16)

**Goal:** the side-by-side that wins the room.

- Trader console: escrow balances, submit sealed order, batch status, fills, every action linking to its Coston2 tx. Flat design, **no gradients**, monospace numbers.
- **Comparison view:** run the same large order on a normal public DEX (visible mempool → sandwich → show the loss as a number) vs Eclipse (nothing in the mempool → uniform fair fill). This is the headline screen.
- Public verifier panel: show the whitelisted code-hash, the attested signer, and the FTSO reference used for the latest batch — all read from chain.

**Exit criteria:** a non-technical person can drive the full flow and see the front-running contrast, with explorer links proving each step.

## Phase 5 — Harden, document, record (Days 15–17)

- Negative-path tests finalized (bad code-hash, out-of-band price, double-withdraw, replay via nonce).
- `docs.md` finalized: architecture, addresses, config, how to run.
- Record the demo video; write the submission per the hackathon template (project name, bounties, description, target user, demo link, repo, how it uses Flare, what's new vs pre-existing, deployed contract addresses on Coston2, roadmap).

**Exit criteria:** submission-ready package; contracts verified; video recorded; both bounties addressed in the write-up.

---

## Timeline summary (17 working days, buffer before Aug 14)

| Phase | Focus | Verifiable output |
|-------|-------|-------------------|
| 0 | Setup + real assets | FXRP moves on Coston2 |
| 1 | Settlement + escrow | Net settlement tx, band + withdraw guards |
| 2 | Sealed orders + matching | Encrypted orders → net settlement |
| 3 | FCC attestation | Attested-signer settlement; bad build reverts |
| 4 | Frontend + comparison | Front-running side-by-side |
| 5 | Harden + submit | Verified contracts, video, write-up |

## Team split (if 2–3 people)

- **Contracts/on-chain:** Phases 0,1, band enforcement, negative tests.
- **TEE/engine/relay:** Phases 2,3, reproducible build + attestation.
- **Frontend/demo/write-up:** Phase 4,5, comparison view, submission.

## Critical path

Phase 3 (real attestation) is the highest-risk, highest-value step and the thing judges will probe. Start `fce-extension-scaffold` exploration during Phase 2, and lock the ship-vs-fallback decision by Day 11 so Phase 3 can't slip the demo.
