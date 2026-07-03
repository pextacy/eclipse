# Eclipse — Product Requirements Document (PRD)

**Product:** Eclipse — a confidential dark pool for FXRP on Flare.
**Hackathon:** Flare Summer Signal. Bounties targeted: **Bounty 1 (Interoperable Asset Products)** and **Bounty 2 (Confidential Compute Apps)** — Eclipse is eligible for both.
**Status:** MVP for hackathon submission (deadline Aug 14).

---

## 1. Problem

Every trade on a public blockchain is visible before and after it executes. For a large FXRP order this is a direct, measurable cost:

- **Front-running / sandwiching.** A big buy sitting in the mempool tells bots exactly what to trade against. The originator gets a worse fill; the difference is extracted value.
- **Information leakage.** A fund's position changes are legible to competitors the moment they hit the book.

This is precisely the gap Flare's own institutional thesis names: institutions want to trade and lend XRP-backed assets **without exposing their activity**, and Confidential Compute exists to give them sealed execution environments. Eclipse turns that thesis into a usable product for the asset Flare already has live — FXRP.

## 2. Who it's for

- **Primary:** desks and funds moving size in FXRP (and, over time, other FAssets) who lose money to front-running on public AMMs/order books.
- **Secondary:** treasuries and OTC desks (e.g. corporate XRP treasuries) that want to rebalance without broadcasting intent.
- **Tertiary (roadmap):** any protocol that needs a private, oracle-fair settlement venue for FAssets.

## 3. What it does (one sentence)

Traders escrow FXRP and USDT0, submit **encrypted** limit orders to a matching engine running inside a Flare Confidential Compute TEE; the engine clears batches at a uniform, FTSO-bounded price and settles only the **net** result on Flare — the order book is never public.

## 4. Goals and non-goals

**Goals**
- Make large FXRP orders un-front-runnable while keeping settlement trustless and verifiable.
- Prove the fill was fair (uniform clearing price inside the FTSO XRP/USD band) without revealing individual orders.
- Ship something a judge can use on Coston2 end-to-end and verify on the explorer.

**Non-goals (MVP)**
- Not a full CLOB with continuous matching. Discrete batch auctions only.
- Not doing FXRP mint/redeem UX. Traders arrive already holding FXRP (Coston2 faucet provides it).
- No KYC gating yet (roadmap).

## 5. User stories

1. As a desk, I deposit FXRP into Eclipse and see my escrow balance, redeemable at any time when I have no open matched leg.
2. As a desk, I submit a sealed limit order (side, amount, limit price) that never appears in the mempool or a public book.
3. As a desk, at batch close I receive a fill at a single clearing price shared by everyone in that batch, and I can see the settlement tx on the explorer without any counterparty seeing my order.
4. As anyone, I can independently verify that (a) the settlement was signed by an attested, whitelisted TEE build, and (b) the clearing price was inside the FTSO band — without learning the order book.
5. As a skeptical judge, I can run the same large order on a normal public DEX and on Eclipse and see the front-running loss on one side and zero leakage on the other.

## 6. Functional requirements

| # | Requirement | Notes |
|---|-------------|-------|
| FR-1 | Deposit/withdraw FXRP and USDT0 into `EclipseSettlement` escrow | Real Coston2 tokens; withdraw blocked while an escrow has an open matched leg |
| FR-2 | Submit encrypted order to the TEE | Order encrypted to the TEE's attested public key; relay cannot read it |
| FR-3 | Batch auction inside the TEE | Fixed interval (e.g. 30s); computes a single uniform clearing price and net transfers |
| FR-4 | FTSO fairness band enforced on-chain | Batch clears only if clearing price is within ±`BAND_BPS` of FTSO XRP/USD, checked in the contract |
| FR-5 | Attested-signer settlement | `EclipseSettlement` accepts a settlement only if signed by a signer bound to a code-hash whitelisted in `TeeMachineRegistry`/`TeeExtensionRegistry` |
| FR-6 | Net-only on-chain settlement | Individual orders never posted; only net deltas per account are transferred |
| FR-7 | Public verifiability | Every settlement emits an event with batch id, clearing price, FTSO reference, and signer; all linkable on the explorer |
| FR-8 | Front-running comparison view | UI shows public-DEX sandwich vs Eclipse for the same order |

## 7. Non-functional requirements

- **Trust model:** the backend operator is untrusted; only the attested TEE build can authorize fund movement. Traders can always withdraw idle escrow.
- **Verifiability:** anyone can check the on-chain code-hash whitelist and the FTSO band without special access.
- **Latency:** batch interval configurable; 30s is fine for the demo.
- **Reproducibility:** TEE extension builds reproducibly so its code-hash matches the on-chain whitelist.
- **No gradients** in the UI; flat, high-contrast trading-terminal aesthetic.

## 8. Success metrics (for the submission)

- End-to-end batch settled on Coston2 with a verifiable explorer link. ✅ = primary success.
- Demonstrated: identical large order → measurable loss on public DEX, zero mempool leakage on Eclipse.
- Negative tests pass: settlement from a non-whitelisted code-hash reverts; out-of-band clearing price reverts.
- Clear write-up of what is new vs pre-existing (everything here is new; Flare protocols are the dependencies).

## 9. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| FCC extension tooling not fully available on Coston2 during build | Documented fallback: run the engine in a real Confidential VM (Intel TDX / AMD SEV-SNP) and register its attestation-bound signing key on-chain — same trust model, still no mock |
| On-chain full attestation verification is heavy | Use attested-key registration: verify attestation once at registration, then verify signatures against the registered key per settlement |
| Thin liquidity in a demo batch | Seed both sides with two funded demo desks; a batch of 2–4 orders is enough to show uniform clearing and net settlement |
| FTSO value staleness/volatility | Read block-latency feed at settlement; band check uses the value read on-chain in the same tx |

## 10. What's newly built vs pre-existing

- **Pre-existing (dependencies, not our work):** FXRP/FAssets, FTSOv2 feeds, FCC TEE framework, Coston2.
- **Newly built during the hackathon:** `EclipseSettlement` + `EclipseRegistry` contracts, the sealed-order encryption scheme, the TEE batch-auction matching engine and its signed-settlement output, the FTSO band enforcement, the untrusted relay, and the trader console + front-running comparison UI.
