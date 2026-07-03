# Eclipse

**A confidential dark pool for FXRP on Flare.** Institutions submit large FXRP
buy/sell orders that are matched inside an attested TEE (Flare Confidential
Compute). The order book is never public; only the **net** settlement executes
on-chain — so large orders can't be front-run or sandwiched — and the clearing
price is provably fair against the FTSOv2 XRP/USD feed.

> Targets **Coston2** (chainId 114). No mocks in the settlement path: real faucet
> FXRP/USDT0, the real FTSOv2 feed, and a real attestation-bound signer.
> See [`docs/CLAUDE.md`](docs/CLAUDE.md) for the hard rules.

## Why it stands out

- **Confidential *and* trustless.** Sealed order book inside an attested TEE, but
  the chain verifies the settlement was signed by a **whitelisted, reproducible
  build** — privacy without trusting the operator.
- **The chain trusts the build, not the operator.** The relay has no custody and
  no signing authority; `settleBatch` only accepts a signature bound to an
  on-chain code-hash. A modified engine has a different code-hash and is rejected.
- **Publicly checkable fairness.** `|clearingPrice − FTSO XRP/USD| ≤ BAND_BPS` is
  enforced *in the settlement tx*, and the reference is emitted.
- **Net-only settlement.** Individual orders/fills never touch the chain.
- **Always-redeemable custody.** Idle escrow is withdrawable anytime; a locked
  leg auto-releases after expiry. No admin key can seize funds.

## Monorepo layout

```
contracts/   Solidity — EclipseSettlement.sol, EclipseRegistry.sol, Flare interfaces, mocks
tee/         Matching engine: sealed orders, batch auction, signer, FCC extension + reproducible build
relay/       Untrusted backend: order intake, engine transport, on-chain relay
web/         React trader console + front-running comparison + public verifier panel
scripts/     Registry resolver, deploy, code-hash registration, demo batch
shared/      Shared types: Order/Settlement schemas + the single EIP-712 type source
test/        Contract tests (Hardhat/TS) — happy path + every abuse path
docs/        CLAUDE.md, prd.md, plan.md, phases.md, docs.md
```

## Quick start

```bash
pnpm install
pnpm --filter @eclipse/shared build

# Contracts: compile + full happy/abuse test suite (local mocks — no network)
pnpm --filter @eclipse/contracts test

# Engine + relay unit tests
pnpm --filter @eclipse/tee test
pnpm --filter @eclipse/relay test

# Web (production build)
pnpm --filter @eclipse/web build
```

To deploy and run the live Coston2 demo (needs a faucet-funded key), see
[`DEMO.md`](DEMO.md) and [`docs/docs.md §8`](docs/docs.md).

## Status

All five build phases in [`docs/phases.md`](docs/phases.md) are implemented; the
local test suites are green. The on-chain "clickable proof" steps (deploy,
verify, FXRP transfer, demo batch, code-hash registration) are ready-to-run
commands that require a funded Coston2 deployer key — they are not executed in CI.
See [`docs/STATUS.md`](docs/STATUS.md) for the phase-by-phase map.

## Toolchain note

`CLAUDE.md §3` prefers Foundry for tests. Foundry/Rust is not part of this repo's
pinned Node toolchain, so the runnable, CI-backed contract suite is **Hardhat +
TypeScript** (explicitly permitted by §3). A `contracts/foundry.toml` is included
for contributors who have Foundry. This is the one deliberate, flagged deviation.
