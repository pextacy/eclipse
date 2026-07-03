# Eclipse — Build Phases (Full Detail)

Detailed, execution-ready phase plan to a **no-mock Coston2 demo** by the **Aug 14** submission deadline. This is the operational companion to `plan.md`: same milestones, expanded into concrete tasks, deliverables, on-chain proofs, risks, and exit gates — plus a section on **what makes Eclipse stand out** versus comparable products.

Read `CLAUDE.md` first — it is the source of truth for conventions. Where this file and `CLAUDE.md` disagree, `CLAUDE.md` wins and the conflict should be flagged.

**Guiding rule (unchanged):** every phase ends with something **deployed and clickable on the Coston2 explorer**. A local-only stub is never "done." No mocks in the settlement path.

---

## Legend

- **DoD** = Definition of Done for the phase (all must be true to exit).
- **On-chain proof** = the specific artifact a judge can click on the explorer.
- **Owner** = suggested track (Contracts / TEE / Frontend) for a 2–3 person team.
- 🔴 = critical-path / highest-risk item.

Global Definition of Done (per feature, from `CLAUDE.md §7`):
1. Deployed and **verified** on Coston2 with a public explorer link.
2. A test proving **both** the happy path and at least one abuse path is blocked.
3. Uses **registry lookups**, never hardcoded addresses.
4. No new mock in the settlement path.
5. Docs updated if behavior or config changed.

---

## Phase 0 — Foundations (Days 1–3)

**Goal:** wallet + repo + real assets actually moving on Coston2. Prove the plumbing before any product logic exists.

### Tasks
- **Repo scaffold** per `CLAUDE.md §4` layout (`/contracts /tee /relay /web /scripts /test /docs`). Monorepo with `pnpm` workspaces.
- **Toolchain pinning:** Foundry + Hardhat, Solidity `0.8.x`, EVM version **cancun** (required by Flare tooling). Commit `foundry.toml` / `hardhat.config.ts` with the network wired.
- **Network config:** Coston2 — chainId `114`, RPC `https://coston2-api.flare.network/ext/C/rpc`, explorer `https://coston2-explorer.flare.network`.
- **Fund the deployer** from the **Coston2 faucet**: C2FLR (gas) + FXRP + USDT0. Confirm balances on the explorer.
- **Registry resolver** (`scripts/resolveAddresses.ts`): read `FlareContractRegistry` at `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` and resolve `FtsoV2`, `FdcHub`, and the FAssets `AssetManager`; resolve FXRP via `AssetManager.fAsset()`. **No hardcoded protocol addresses anywhere.**
- **Env hygiene:** `.env.example` with placeholders only; real `.env` git-ignored. No secrets committed (`CLAUDE.md §2.7`).
- **CI baseline:** lint + `forge build` + `forge test` on every push (even if trivial).

### Deliverables
- Working monorepo, network config, resolver script, `.env.example`.

### On-chain proof
- A Coston2 tx moving **1 test FXRP** between two addresses you control (explorer link).

### Exit gate (DoD)
- `resolveAddresses.ts` prints live registry-resolved addresses (FtsoV2, AssetManager, FXRP, USDT0) and a real FXRP transfer confirms on Coston2.

**Owner:** Contracts. **Risk:** faucet rate-limits — request funds Day 1 so nothing waits on it later.

---

## Phase 1 — Settlement contract + escrow (Days 4–7)

**Goal:** trustless escrow with net settlement, gated by a **placeholder dev signer** (swapped for the real attested signer in Phase 3). This is where custody safety and FTSO fairness become real, on-chain.

### Tasks — `EclipseSettlement.sol`
- `deposit(address token, uint256 amount)` / `withdraw(address token, uint256 amount)` for FXRP + USDT0. `SafeERC20`, `ReentrancyGuard`, per-account escrow accounting, custom errors (no revert strings).
- `settleBatch(Settlement calldata s, bytes calldata signature)`:
  - `Settlement` carries `batchId, per-account net deltas (FXRP + USDT0), clearingPrice, ftsoRef, expiry, nonce`.
  - Verify signer is **authorized** via `EclipseRegistry` → else `UnattestedSigner()`.
  - Read FTSO XRP/USD **in the same tx**; require `|clearingPrice − ftsoRef| ≤ BAND_BPS` and `ftsoRef` matches the value read → else `PriceOutsideBand()`.
  - Per-token **conservation**: FXRP deltas and USDT0 deltas each net to zero across the batch → else `UnbalancedBatch()`.
  - `nonce` strictly increasing per engine → else `ReplayedBatch()`.
  - Each account's escrow covers its negative leg → else `InsufficientEscrow()`.
  - Apply net transfers; **emit an event for every state change**.
- **Custody guard:** block `withdraw` while an account has an **open matched leg** in an unsettled batch; idle escrow always withdrawable regardless of the signer set / owner.

### Tasks — `EclipseRegistry.sol` (thin wrapper)
- Holds the current authorized settlement signer + whitelisted code-hash set.
- `registerCodeHash(bytes32, address signer)` / `revokeCodeHash(bytes32)` (`onlyOwner`, owner = governance/multisig in prod), `isAuthorized(address) view`.
- Events: `CodeHashRegistered`, `CodeHashRevoked`.

### Tasks — FTSO integration
- `FtsoV2Interface` via `ContractRegistry.getFtsoV2()`, feed id `0x015852502f55534400000000000000000000000000` (XRP/USD, crypto cat `01`). `getFeedById` is `payable`, fee currently `0` — route through `IFeeCalculator` to stay future-proof.

### Tests (required, in `/test`)
- Happy path: deposit → `settleBatch` (dev key registered in `EclipseRegistry`) → correct net balances, single clearing price.
- `PriceOutsideBand()` when clearing price leaves the band.
- Withdraw-with-open-leg reverts; idle-escrow withdraw succeeds.
- `ReplayedBatch()` on nonce reuse; `UnbalancedBatch()` on non-conserving deltas.

### On-chain proof
- A real `settleBatch` net-transfer tx on Coston2; contract **verified** on the explorer.

### Exit gate (DoD)
- Deposit → signed `settleBatch` net transfer executes on Coston2; out-of-band price reverts; withdraw-with-open-leg reverts. Tests green, contract verified.

**Owner:** Contracts. **Risk:** FTSO read semantics/fee — validate against a live feed read in Phase 0's resolver, not assumptions.

---

## Phase 2 — Sealed orders + matching engine (Days 6–10, overlaps Phase 1)

**Goal:** the batch-auction logic and the sealed-order transport, running first as an ordinary service, then lifted into the TEE in Phase 3. Nothing about the order book may leak to the relay or the chain.

### Tasks — order schema + sealing
- Order: `{side, baseAmount (FXRP), limitPrice, account, nonce, expiry}`.
- Encrypt each order to the engine's public key (**sealed box** / libsodium-style). The relay only ever holds ciphertext; it validates the *envelope shape* with zod, never the contents (it can't read them).

### Tasks — batch auction
- Collect orders for the interval (default `BATCH_INTERVAL_SECONDS=30`).
- Compute a **single uniform clearing price** that **maximizes matched base volume** (classic call-auction cross): sort bids desc / asks asc, find the price level maximizing crossed volume, break ties deterministically.
- Clamp/validate the clearing price against the FTSO band **before** producing output (defense in depth; the contract re-checks).
- Compute **net** per-account deltas in FXRP and USDT0. Only nets leave the enclave — never individual fills or the book.
- Produce a `Settlement` struct ready for signing.

### Tasks — relay (`/relay`, untrusted)
- Stateless HTTPS intake of encrypted orders → forward to engine → relay the signed `Settlement` to `settleBatch`.
- Holds **no custody and no signing authority**. Worst-case compromise = withhold service; cannot move funds or read orders. zod-validate all external input (`CLAUDE.md §6`).

### Tests
- Engine unit tests (allowed to use FCC `MODE=0` **local** simulated attestation here only): clearing-price correctness, tie-breaking, conservation of nets, band clamp.
- Relay: rejects malformed envelopes; logs never contain plaintext order fields.

### On-chain proof
- 4 encrypted orders → one clearing price + net deltas → a real `settleBatch` tx on Coston2.

### Exit gate (DoD)
- Submit 4 encrypted orders → engine returns one clearing price + net deltas → relay lands a real `settleBatch` on Coston2. **Order contents never appear on-chain or in relay logs** (grep the logs to prove it).

**Owner:** TEE/engine/relay. 🔴 Start `fce-extension-scaffold` exploration **now** so Phase 3 can't slip.

---

## Phase 3 — Move the engine into FCC (real attestation) 🔴 (Days 9–13)

**Goal:** replace the dev signer with a **real attested TEE signer**. This is the milestone that makes Eclipse a *Confidential Compute app*, not just a private server — and the thing judges will probe hardest.

### Tasks
- Scaffold the engine as an **FCC extension** from `fce-extension-scaffold`; wire signing via the `fce-sign` pattern so the extension signs each `Settlement`.
- **Reproducible build** (`CLAUDE.md §2.6`): pin `SOURCE_DATE_EPOCH` + toolchain so the extension's code-hash is deterministic. A non-reproducible build breaks attestation and is a **release blocker**.
- Register the code-hash in `TeeMachineRegistry` / `TeeExtensionRegistry`, binding it to the extension's signer public key; point `EclipseRegistry` at that attested signer.
- `EclipseSettlement.settleBatch` now requires the signature to resolve to a signer bound to a **whitelisted** code-hash; anything else reverts (`UnattestedSigner()`).

### 🔴 Documented fallback (decide by **Day 11**)
If FCC extension registration isn't live on Coston2 in the build window: run the engine in a **real Confidential VM** (Intel TDX / AMD SEV-SNP), attest it, and register its attestation-bound signing key on-chain. **Same trust model, still no mock.** Lock ship-vs-fallback by Day 11 so Phase 3 cannot slip the demo.

### Tests (negative cases that matter — `CLAUDE.md §6`)
- Settlement signed by a **non-whitelisted** code-hash → `UnattestedSigner()` (revert).
- Attested-signer happy path settles correctly.
- Revoked code-hash can no longer settle.

### On-chain proof
- A settlement signed by the **attested** engine settles on Coston2; a settlement from any non-whitelisted build reverts. Both visible on the explorer.

### Exit gate (DoD)
- Attested-signer settlement succeeds on Coston2; non-whitelisted build reverts; verified on explorer.

**Owner:** TEE. This is the critical path — protect its schedule above everything else.

---

## Phase 4 — Front-end + the winning demo (Days 12–16)

**Goal:** the **side-by-side** that wins the room. Flat design, **no gradients anywhere** (`CLAUDE.md §5`), high-contrast trading-terminal feel, monospace numbers/addresses.

### Tasks — trader console
- React + TypeScript + Vite, wagmi/viem for wallet + contract calls, Tailwind.
- Escrow balances, submit sealed order, batch status, fills — **every action links to its Coston2 tx**.

### 🔴 Tasks — comparison view (headline screen)
- Run the **same large order** two ways:
  - **Public DEX:** visible in the mempool → sandwiched → show the **loss as a concrete number**.
  - **Eclipse:** nothing in the mempool → uniform, FTSO-fair fill.
- Keep this comparison **first-class**, not an afterthought (`CLAUDE.md §5`).

### Tasks — public verifier panel
- Read from chain: the whitelisted **code-hash**, the **attested signer**, and the **FTSO reference** used for the latest batch. Anyone can verify fairness + attestation without special access.

### Exit gate (DoD)
- A **non-technical** person can drive the full flow and see the front-running contrast, with explorer links proving each step.

**Owner:** Frontend. Consider `frontend-design` guidance for a distinctive, non-templated terminal aesthetic.

---

## Phase 5 — Harden, document, record (Days 15–17)

**Goal:** submission-ready package, contracts verified, video recorded, both bounties addressed.

### Tasks
- Finalize negative-path tests: bad code-hash, out-of-band price, double-withdraw, replay via nonce, unbalanced batch.
- Finalize `docs.md`: architecture, addresses, config, how to run.
- Record the demo video.
- Write the submission per the hackathon template: project name, bounties (**Bounty 1 Interoperable Asset Products** + **Bounty 2 Confidential Compute Apps**), description, target user, demo link, repo, how it uses Flare, **what's new vs pre-existing**, deployed Coston2 addresses, roadmap.

### Exit gate (DoD)
- Submission-ready package; contracts verified; video recorded; both bounties addressed in the write-up.

**Owner:** Frontend/write-up (with input from all tracks).

---

## Timeline summary (17 working days, buffer before Aug 14)

| Phase | Focus | Verifiable output | Owner |
|-------|-------|-------------------|-------|
| 0 | Setup + real assets | FXRP moves on Coston2 | Contracts |
| 1 | Settlement + escrow | Net settlement tx, band + withdraw guards | Contracts |
| 2 | Sealed orders + matching | Encrypted orders → net settlement | TEE/relay |
| 3 🔴 | FCC attestation | Attested-signer settlement; bad build reverts | TEE |
| 4 | Frontend + comparison | Front-running side-by-side | Frontend |
| 5 | Harden + submit | Verified contracts, video, write-up | All |

### Critical path
Phase 3 (real attestation) is the highest-risk, highest-value step. Start `fce-extension-scaffold` exploration during Phase 2; lock the **ship-vs-fallback** decision by **Day 11** so Phase 3 can't slip the demo.

### Team split (2–3 people)
- **Contracts/on-chain:** Phases 0, 1, band enforcement, negative tests.
- **TEE/engine/relay:** Phases 2, 3, reproducible build + attestation.
- **Frontend/demo/write-up:** Phases 4, 5, comparison view, submission.

---

## Cross-phase risk register

| Risk | Phase | Mitigation |
|------|-------|------------|
| FCC extension tooling not fully live on Coston2 | 3 | Confidential-VM fallback (TDX / SEV-SNP), attestation-bound key registered on-chain — same trust model, no mock. Decide by Day 11. |
| On-chain full attestation verification is heavy | 3 | Attested-**key registration**: verify attestation once at registration, then verify signatures against the registered key per settlement. |
| Non-reproducible TEE build → code-hash mismatch | 3 | Pin `SOURCE_DATE_EPOCH` + toolchain; treat a non-reproducible build as a release blocker. |
| Thin liquidity in a demo batch | 2/4 | Seed both sides with two funded demo desks; 2–4 orders is enough to show uniform clearing + net settlement. |
| FTSO value staleness/volatility | 1 | Read the block-latency feed at settlement; band check uses the value read on-chain **in the same tx**. |
| Faucet rate limits | 0 | Fund the deployer Day 1. |
| Secret leakage | all | `.env.example` placeholders only; CI check for committed keys. |

---

## What makes Eclipse stand out (vs. comparable products)

Eclipse combines things that existing products only do in parts. The differentiators, mapped to where they're built:

### 1. Confidentiality **and** trustless settlement — not one or the other
- **Traditional dark pools (TradFi):** confidential, but you must trust the operator's matching and custody. There's no public proof the fill was fair.
- **Public DEXs / AMMs:** trustless, but fully transparent → every large order is front-run/sandwiched.
- **Eclipse:** the order book lives inside an **attested TEE** (confidential) *and* the chain verifies the settlement was signed by a **whitelisted, reproducible build** (trustless). You get privacy without trusting the operator. *(Phases 1, 3)*

### 2. The chain trusts the **build**, not the operator
- The relay/operator has **no custody and no signing authority**. `settleBatch` only accepts a signature bound to a code-hash whitelisted on-chain. A modified engine produces a different code-hash and is **rejected**. Compromising settlement requires forging hardware attestation for a modified build. *(Phases 1, 3)*
- Contrast with "trusted sequencer" designs (many private orderflow/MEV products) where a single operator can reorder, censor, or extract — here that path doesn't exist.

### 3. **Publicly checkable fairness** via FTSO — privacy that's still provable
- Most privacy venues ask you to *trust* that the internal price was fair. Eclipse enforces `|clearingPrice − FTSO XRP/USD| ≤ BAND_BPS` **on-chain, in the settlement tx**, and emits the reference. Anyone can verify the batch cleared at an oracle-fair price **without ever seeing an order**. *(Phase 1)*
- This is the rare combination: **sealed order book + open, verifiable fairness**.

### 4. **Net-only settlement** — minimal footprint, maximal privacy
- Individual orders and per-order fills never touch the chain; only per-account **net deltas** settle. Less leakage, lower gas, and no reconstructable trade history. *(Phases 2, 3)*

### 5. Uniform-price **batch auction** kills the front-running surface
- Everyone in a batch clears at the **same** price, and nothing sits in a public mempool to trade against. This structurally removes sandwiching — similar in spirit to CoW/batch-auction DEXs, but with the order book *encrypted inside a TEE* rather than merely batched in the open. *(Phase 2)*

### 6. Deep, non-superficial use of **three** Flare protocols together
- **FAssets/FXRP** (the traded asset), **FCC** (the matching TEE + attested signer), and **FTSOv2** (the fairness band) are each load-bearing, not decorative. Eligible for **both** hackathon bounties (Interoperable Asset Products **and** Confidential Compute Apps). *(All phases)*

### 7. **Always-redeemable custody** — no admin seizure path
- A trader's idle escrow is withdrawable at any time, independent of governance and the signer set. No admin key can move user funds. *(Phase 1)*

### 8. **The demo itself is the differentiator**
- The side-by-side — a public-DEX order visibly sandwiched (a real loss number) vs. the same order through Eclipse with nothing leaking in the mempool — makes the value legible to a non-technical judge in seconds. Most privacy protocols can't *show* their benefit; Eclipse can. *(Phase 4)*

### Roadmap edges (beyond MVP, from `docs.md §11`)
- **Verified-counterparty pools** (KYC/attestation-gated batches) — an institutional-grade venue.
- **Direct FXRP entry via Smart Accounts** — enter the pool straight from an XRPL Payment, no Flare gas needed by the trader. A UX moat XRPL-native funds don't get elsewhere.
- **Multi-asset** as more FAssets go live; **continuous** confidential matching beyond discrete batches; **Songbird → Flare mainnet** as FCC rolls out.
