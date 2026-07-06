# Eclipse — Security Review

Consolidated results of a full security review of the Eclipse confidential dark
pool: contracts, TEE matching engine, untrusted relay, and web frontend, plus
supply-chain and secrets hygiene. Findings are marked **Fixed**, **Mitigated**
(partial fix + residual), **Residual** (accepted, with recommendation), or
**By design** (inherent to the trust model).

The review was conducted per component with an adversarial lens; every **Fixed**
item ships with a regression test where the layer supports one (Foundry fork
tests for contracts, vitest for TEE/relay).

## Trust model (context)

- The chain trusts the **build, not the operator**: `settleBatch` only accepts a
  signature that recovers to a signer bound to a whitelisted, reproducible-build
  code-hash in `EclipseRegistry`.
- Custody is **escrow-only and always redeemable**: idle escrow is withdrawable
  any time; a committed leg self-releases after its expiry.
- Fairness is **publicly checkable**: the clearing price is bounded by the FTSO
  XRP/USD value read in the settle tx.
- The **relay is untrusted**: it holds no custody and no settlement-signing
  authority. It can censor or delay, but cannot move funds or forge a settlement.

---

## Contracts (`contracts/src`)

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| C1 | Medium | `settleBatch` gated accounts only on `openLegBatch == batchId` (expiry-agnostic) while `withdraw` uses the expiry-aware `_hasOpenLeg`. With `s.expiry > commit.expiry`, a trader could withdraw backing after leg expiry, then a later settlement reverts the whole batch (griefing all counterparties). | **Fixed** — settle loop reverts once `block.timestamp > openLegExpiry[a]`; fork test `test_settle_after_leg_expiry_reverts`. |
| C2 | Low | No FTSO staleness check. | **Residual (infeasible)** — verified on a fork that `getFeedById`'s timestamp equals the *current block* timestamp (block-latency feed), so `block.timestamp − feedTs ≈ 0` always and a staleness guard can never fire. A frozen feed is not observable through this interface. Recommendation: if Flare later exposes a last-value-update time, add a max-staleness bound. |
| C3 | Low | Strictly-increasing (`>`) commit/settle nonces are permissionlessly submittable, so reordering two engine-signed messages permanently strands the lower nonce. Liveness only (engine re-signs higher). | **Residual (accepted)** — trivial to recover; per-batchId consumption would be the fix if strict ordering ever matters. |
| C4 | Info | `currentXrpUsdPrice()` is `nonpayable` yet forwards the FTSO fee; breaks (reverts) if the fee ever becomes non-zero. Read-only helper only; not a fund path. | **Residual (accepted)** — documented in-code. |
| — | Info | **Signer-compromise blast radius**: any authorized signer can reassign balances among *any* escrowed accounts (bounded by conservation + per-account sufficiency). | **By design** — the "trust the attested build" model; a trader's protection is to withdraw before being committed. Reproducible builds + code-hash whitelisting are what constrain who can sign. |

Verified sound (no action): reentrancy (nonReentrant + CEI, fee-on-transfer-safe
deposit), EIP-712/ECDSA (OZ `recover` rejects malleable-`s`, never returns
`address(0)`), conservation + overflow (0.8.25 checked math), access control
(`Ownable2Step`, guardian can only pause matching — never touch custody), no
owner/guardian seize path.

---

## TEE matching engine (`tee/src`)

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| T1 | High | **Order replay across restart**: the `consumed` replay guard is in-memory only and the settlement carries no order identity, so after an engine restart the untrusted relay (which holds all ciphertexts) could resubmit a filled order within its validity window → double-charge. | **Mitigated** — the engine now rejects orders whose expiry exceeds `now + 4×batchTTL`, capping the replay window regardless of what a client signs. **Residual / recommended full fix**: track per-account order nonces on-chain (in the settlement/commit) or persist `consumed` to durable sealed storage. |
| T2 | High | **Consume-before-confirm + unauthenticated `/batch`**: an unauthenticated caller could drive a batch, receive the signed settlement, discard it, and leave observed orders permanently consumed (griefing). | **Fixed** (auth) — `/batch` now requires `x-operator-token` (or loopback-only + 127.0.0.1 bind), with a body-size cap; `EngineClient` forwards the token. **Residual**: the engine still consumes optimistically on fill without an on-chain settlement confirmation; the auth restricts this to the trusted relay. |
| T3 | Medium | **Wash / self-cross price manipulation**: an account on both sides could inflate crossed volume at a band edge to drag the uniform price. | **Fixed** — self-crossing accounts are dropped before price discovery; test `excludes a self-crossing (wash) account`. |
| T4 | Medium | **No affordability check**: the engine has no escrow view, so an underfunded matched order makes the on-chain settlement revert (batch-wide griefing). No theft (the contract's per-account sufficiency check reverts the debit). | **Residual (accepted)** — recommend giving the engine a read-only escrow view to drop unbacked orders pre-match. |
| T5 | Low | Rounding remainder always lands on the last fill; reproducible-hash folds in the Node runtime version; order `limitPrice` scale not pinned to feed decimals. | **Residual (accepted / documented)** — economically microscopic; pin the Node version alongside the published code-hash. |

Verified sound: order EIP-712 signature is verified and bound to `account`
(case-insensitive), sealed-box decryption fails closed and never logs the secret
key, clearing price is hard-clamped into the FTSO band, per-token conservation is
exact, and the auction is deterministic (preserving the code-hash).

---

## Untrusted relay (`relay/src`)

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| R1 | High | **Permissionless `/orders` flood** → anonymity-set shrink (an attacker fills a batch with junk so any honest order is isolated) and intake DoS. | **Mitigated** — pool now dedups repeated submissionId/ciphertext (idempotent) and the cap was lowered; ciphertext is length-bounded (R3). **Residual**: a flood of *distinct* junk envelopes still needs per-IP/connection **rate limiting at the edge** (reverse proxy) — the relay can't rate-limit per account (it can't read orders). Deploy behind a rate-limiting proxy; consider a minimum batch size + random close jitter. |
| R2 | Medium | **Overlapping scheduler ticks** → two concurrent `closeBatch` → concurrent on-chain sends collide on the sender nonce. | **Fixed** — `closeBatch` is serialized (each waits for the prior). |
| R3 | Medium | **Unbounded ciphertext** → ~GB memory DoS from valid envelopes. | **Fixed** — `SealedOrderSchema` caps ciphertext at 2 KB, enginePublicKey at 128 chars. |
| R4 | Low–Med | `createRelayServer` is exported; the loopback close-auth is safe only by the 127.0.0.1 bind chosen in `main()`. A caller binding it to 0.0.0.0 without a token, or a loopback reverse proxy, makes `/batch/close` world-triggerable. | **Residual (documented)** — operators must set `RELAY_OPERATOR_TOKEN` for any non-loopback deployment (the code already binds loopback-only without a token). |
| R5 | Low | Ciphertext **length** logged (plaintext-size side channel if plaintexts vary). | **Fixed** — only the opaque submissionId is logged now. |

Verified sound: `secretEqual` is timing-safe; `/batch/status` and `/orders`
never leak pool size; body intake streams with a hard cap; errors don't leak
ethers/RPC internals; the relay genuinely can't move funds.

---

## Web frontend (`web/src`)

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| W1 | High | The order form sealed to a public key the **relay supplies**, with no attestation/registry binding, while the UI asserted "the relay only sees ciphertext". Under an http MITM or a hostile Settings relay URL, the key can be swapped and the order decrypted. | **Fixed (as far as the client can)** — sealing/claims are now gated on (a) a secure relay connection (https/loopback) and (b) the engine signer being `registry.isAuthorized`; otherwise a prominent warning shows and the reassurance copy is replaced with an honest caveat. **Residual**: full binding of the *sealbox* key to the attested signer requires carrying it inside the attestation quote (server/attestation-side, out of the browser's reach). |
| W2 | High | `relayUrl` Settings override was unvalidated (enabled W1, mixed-content, credential smuggling). | **Fixed** — validated on save and on read: https only (http restricted to localhost), no embedded credentials, no `javascript:`/`data:`. |
| W3 | Medium | CSV export did RFC-4180 quoting but no **formula-injection** neutralization (token `symbol` comes from an on-chain string). | **Fixed** — cells starting with `= + - @` / tab / CR are quote-prefixed. |
| W4 | Medium | `orders.ts` trusted localStorage shape (blind cast) → a malformed entry white-screens the Trader Console. | **Fixed** — per-field validation drops bad rows. |
| W5 | Low/Info | `currentXrpUsdPrice` declared `view` in the hand-written ABI (degrades to `—` if a fee is ever charged); `Number(bigint)` P&L precision above 2^53; `Date.now()` in render (hydration warning). | **Residual (accepted)** — cosmetic for the 6-dp Coston2 tokens; documented in-code. |

Verified sound: no `dangerouslySetInnerHTML`/`innerHTML`/`eval`; all chain/user
values render as escaped React text or into fixed-base explorer hrefs; only the
sealed ciphertext leaves the browser; no secrets logged; localStorage access is
SSR-guarded; Toast/ids are deterministic (SSR-safe).

---

## Supply chain & secrets

- **Secrets**: no private keys or secrets committed. `.env.example` holds only
  empty placeholders; real `.env` is git-ignored; CI has a secret-scan gate.
  forge-std matches are library test fixtures (well-known Anvil keys), not ours.
- **Dependencies** (`pnpm audit --prod`): advisories are in **Next.js 14.2.35**
  (SSRF/DoS/middleware — largely mitigated here because the app is a **static
  export** with no Next server runtime) and **transitive** `axios`/`ws`
  (**no direct import** anywhere in our source; pulled by wallet/build tooling).
  **Recommendation**: bump Next to ≥ 15.5.16 when convenient (major upgrade —
  test the App Router) and re-run `pnpm audit` before each release. Not a
  runtime risk for the current static deployment.
- **Scripts** (`scripts/`): keys are read from env; the dev-signer path is gated
  behind `ALLOW_DEV_SIGNER=true` with a warning and a clearly-labeled placeholder
  code-hash; `registerCodeHash` validates the hash format.

---

## Top recommendations (not yet implemented)

1. **On-chain (or durable) per-order nonces** to fully close order-replay across
   engine restart (T1) — the most impactful remaining hardening.
2. **Edge rate-limiting** in front of the relay `/orders` intake (R1).
3. **Escrow-aware order admission** in the engine to prevent batch-revert
   griefing (T4).
4. Carry the **sealbox public key inside the attestation quote** so the client
   can cryptographically bind it to the attested signer (W1 residual).
