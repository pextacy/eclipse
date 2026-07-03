# CLAUDE.md

Engineering context and rules for the **Eclipse** repository. Read this before writing any code. This file is the source of truth for conventions; if a request conflicts with it, flag the conflict instead of silently overriding.

> File name note: this is the standard `CLAUDE.md` (uppercase) that Claude Code and other agents auto-load. It is the "claude.md" referenced in the project brief.

---

## 1. What Eclipse is

Eclipse is a **confidential dark pool for FXRP** on Flare. Institutions submit large FXRP buy/sell orders that are matched inside a Trusted Execution Environment (TEE) via Flare Confidential Compute (FCC). The order book is never public. Only the **net** settlement is executed on-chain, so large orders cannot be front-run or sandwiched.

Three Flare protocols are used together, none of them superficially:

- **FAssets / FXRP** — the traded asset (real ERC-20 on Coston2/Flare).
- **Flare Confidential Compute (FCC)** — the matching engine runs as an attested TEE extension; settlement is signed by the attested machine.
- **FTSO v2** — the XRP/USD block-latency feed used as a fairness band on the clearing price.

## 2. Hard rules (do not break)

1. **No mocks anywhere — the settlement path uses real Coston2 contracts.** Real testnet FXRP (FAssets), a real quote ERC-20 for `USDT0_ADDRESS` (note: there is **no canonical USDT0 on Coston2** — USDT0 is a Flare *mainnet* token, so the operator supplies the quote token), the real FTSOv2 XRP/USD feed, and a real attested TEE signer. The contract test suite is Foundry fork tests against the live Coston2 deployment. "It works on the demo" must mean it works against Coston2, not against a stub.
   - The only permitted simulation is FCC's own local `MODE=0` / simulated attestation for *local unit tests*. It must never be used in the deployed Coston2 demo. The deployed matching engine runs as a real FCC extension (or, as documented fallback, a real Confidential VM whose attested signing key is registered on-chain). Either way the on-chain contract verifies a real attestation-bound signer.
2. **Never hardcode Flare contract addresses.** Resolve everything through `FlareContractRegistry` at `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` (same address on all Flare networks). FXRP address is resolved dynamically via the FAssets `AssetManager.fAsset()`; the legacy hardcoded FXRP address is deprecated.
3. **The contract trusts the TEE, not the operator.** `EclipseSettlement` only accepts settlement instructions signed by a signer key that is bound to a whitelisted code-hash in `TeeMachineRegistry`/`TeeExtensionRegistry`. If the code-hash is not registered, settlement reverts. The backend operator must have no path to move user funds.
4. **Custody is escrow-only and always redeemable.** Funds a trader deposits into `EclipseSettlement` can always be withdrawn by that trader when they have no open matched leg. No admin key can seize balances.
5. **Clearing price must sit inside the FTSO band.** A batch clears only if the uniform clearing price is within `±BAND_BPS` of the current FTSO XRP/USD value. This is checked on-chain at settlement, not just inside the TEE.
6. **Reproducible builds for the TEE extension.** The extension binary must build reproducibly (pin `SOURCE_DATE_EPOCH`, pinned toolchain) so its code-hash matches the value whitelisted on-chain. A non-reproducible build breaks attestation and is a release blocker.
7. **No secrets in the repo.** No private keys, API keys, or `.env` committed. Use `.env.example` with placeholders only.

## 3. Tech stack (fixed unless discussed)

- **Contracts:** Solidity `0.8.x`, EVM version **cancun** (required by Flare tooling). Foundry preferred for tests; Hardhat acceptable for scripts/deploy. Use `@flarenetwork/flare-periphery-contracts/coston2/*` for interfaces (`ContractRegistry`, `FtsoV2Interface`, `IFeeCalculator`) and `@flarelabs/fasset` (`IAssetManager`) for FAssets.
- **TEE extension:** TypeScript or Rust, scaffolded from `fce-extension-scaffold`; signing follows the `fce-sign` example. Deployed via the Coston2 FCC extension lifecycle.
- **Backend relay:** Node.js + TypeScript. Stateless where possible; it only forwards encrypted orders to the TEE and relays signed settlements on-chain. It is untrusted by design.
- **Frontend:** React + TypeScript + Vite, wagmi/viem for wallet + contract calls, ethers only if a lib requires it. Tailwind for styling.
- **Networks:** Coston2 (chainId `114`, RPC `https://coston2-api.flare.network/ext/C/rpc`, explorer `https://coston2-explorer.flare.network`). Songbird is a stretch target once FCC lands there.

## 4. Repo layout

```
/contracts        Solidity: EclipseSettlement.sol, EclipseRegistry.sol, interfaces
/tee              FCC extension: matching engine, batch auction, signer
/relay            Untrusted backend: order intake, TEE transport, on-chain relay
/web              React frontend (trader console + public settlement view)
/scripts          Deploy + config scripts (registry lookups, whitelisting code-hash)
/test             Foundry/Hardhat tests, incl. attestation-signer negative tests
/docs             Architecture + integration docs (see docs.md)
```

## 5. Design / UI conventions

- **Flat design. No gradients anywhere** — solid fills only, in the whole UI (backgrounds, buttons, charts). This is a hard visual rule.
- High-contrast, dense "trading terminal" feel. Monospace for numbers/addresses.
- The winning demo screen is a **side-by-side**: a normal public DEX order getting sandwiched (visible loss in a number) vs the same order through Eclipse with nothing leaking in the mempool. Keep that comparison first-class in the UI, not an afterthought.
- Every on-chain action shows its Coston2 explorer tx link. Judges must be able to click through and verify.

## 6. Coding conventions

- Solidity: custom errors (not revert strings), checks-effects-interactions, `ReentrancyGuard` on any external transfer path, `SafeERC20`. No `*` imports.
- Emit an event for every state change (deposit, withdraw, batch settled, code-hash registered/revoked).
- TypeScript: strict mode on, no `any` in committed code, zod-validate all external input to the relay.
- Tests must include the negative cases that matter: settlement signed by a non-whitelisted code-hash must revert; clearing price outside the FTSO band must revert; withdrawal of an escrow that has an open matched leg must revert.

## 7. Definition of done (per feature)

- Deployed and verified on Coston2 with a public explorer link.
- Has a test proving both the happy path and at least one abuse path is blocked.
- Uses registry lookups, not hardcoded addresses.
- No new mock introduced in the settlement path.
- Docs updated if behavior or config changed.

## 8. Out of scope for the hackathon MVP

- Cross-chain redemption UX (mint/redeem FXRP↔XRP is out; assume the trader already holds FXRP, which the faucet provides on Coston2).
- Continuous (per-tick) matching. MVP is discrete batch auctions.
- KYC / verified-counterparty gating (this is the first roadmap item, not MVP).
- Multi-asset pools beyond FXRP/USDT0.
