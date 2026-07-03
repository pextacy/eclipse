# Eclipse — Technical Documentation

Confidential dark pool for FXRP on Flare. This document covers architecture, the on-chain contracts, the TEE matching engine, Flare integration details, configuration, and how to run it. Everything here targets a real Coston2 deployment — no mocked components in the settlement path.

---

## 1. Architecture overview

```
 Trader (desk)
   │  1. deposit FXRP / USDT0  ────────────────────────►  EclipseSettlement (Coston2)
   │                                                          ▲   escrow balances
   │  2. encrypted sealed order (to TEE pubkey)               │
   ▼                                                          │
 Relay (untrusted)  ──►  FCC Matching Engine (TEE)            │
                          - batch auction, uniform price      │
                          - reads FTSO XRP/USD band           │
                          - computes NET deltas               │
                          - signs Settlement (fce-sign) ──────┘  5. settleBatch(settlement, sig)
                                                                    - verify signer bound to
                                                                      whitelisted code-hash
                                                                    - verify price ∈ FTSO band
                                                                    - apply NET transfers
                                                                    - emit BatchSettled
```

Key properties:

- **The order book never leaves the TEE.** Orders are encrypted to the engine's attested public key; the relay only ever holds ciphertext; the chain only ever sees net deltas.
- **The chain trusts the build, not the operator.** `settleBatch` only accepts a signature from a signer bound to a code-hash whitelisted on-chain. A modified engine produces a different code-hash and is rejected.
- **Fairness is publicly checkable.** The uniform clearing price must be within a band of the FTSO XRP/USD feed, enforced in the contract, and the reference is emitted for anyone to verify.

## 2. Network + core addresses

| Item | Value |
|------|-------|
| Network | Flare Testnet **Coston2** |
| Chain ID | `114` |
| RPC | `https://coston2-api.flare.network/ext/C/rpc` |
| Explorer | `https://coston2-explorer.flare.network` |
| Faucet | Coston2 faucet — provides **C2FLR**, **FXRP**, and **USDT0** |
| `FlareContractRegistry` | `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` (same on all Flare networks) |

**Never hardcode protocol addresses.** Resolve at runtime:

```solidity
// Solidity, via periphery ContractRegistry
import {ContractRegistry} from "@flarenetwork/flare-periphery-contracts/coston2/ContractRegistry.sol";
import {FtsoV2Interface} from "@flarenetwork/flare-periphery-contracts/coston2/FtsoV2Interface.sol";

FtsoV2Interface ftsoV2 = ContractRegistry.getFtsoV2();
// FAssets AssetManager is resolved via the FAssets registry;
// FXRP token address = IAssetManager(assetManager).fAsset()
```

FXRP is a standard ERC-20 once resolved. USDT0 is the quote token, also an ERC-20 from the faucet.

## 3. Flare integration details

### 3.1 FAssets / FXRP (the traded asset)
- FXRP is the ERC-20 representation of XRP on Flare, minted/redeemed through the FAssets `AssetManager` with FDC-proved XRPL payments. For the MVP we do **not** run mint/redeem; traders arrive holding FXRP (the Coston2 faucet supplies it), keeping the demo focused on confidential matching.
- FXRP address is always resolved dynamically via `AssetManager.fAsset()`; the legacy hardcoded address is deprecated.
- Roadmap: accept direct FXRP deposits via Flare Smart Accounts (XRPL Payment → memo instruction → deposit into Eclipse) so an XRPL user can enter the pool without touching Flare gas.

### 3.2 FTSO v2 (fairness band)
- Feed: **XRP/USD**, category `01` (crypto). Feed id: `0x015852502f55534400000000000000000000000000`.
- Block-latency feed updates roughly every 1.8s; `getFeedById` is `payable` but currently fee `0` (use `IFeeCalculator` to be future-proof).
- Usage: at `settleBatch`, the contract reads the current XRP/USD value and requires `|clearingPrice − ftso| ≤ BAND_BPS`. This proves the TEE didn't clear at a manipulated price, without revealing any order.

### 3.3 Flare Confidential Compute (the matching engine)
- The engine runs as an **FCC extension** inside a TEE. Relevant FCC primitives: `TeeMachineRegistry` / `TeeExtensionRegistry` (which builds/machines are trusted), the `InstructionSender` pattern (how an attested extension pushes an instruction on-chain), and **code-hash whitelisting** via reproducible builds.
- Signing uses the `fce-sign` pattern; scaffold from `fce-extension-scaffold`.
- **Attestation flow (attested-key registration):**
  1. Build the extension reproducibly (`SOURCE_DATE_EPOCH` pinned) → deterministic code-hash.
  2. Register that code-hash as trusted in `TeeMachineRegistry`/`TeeExtensionRegistry`, binding it to the extension's signer public key.
  3. `EclipseRegistry` records the current trusted signer.
  4. `EclipseSettlement.settleBatch` verifies each settlement signature resolves to a signer bound to a whitelisted code-hash. Anything else reverts.
- **Local dev only:** FCC's simulated/`MODE=0` attestation is allowed for unit tests. It is never used in the deployed Coston2 demo.
- **Documented fallback:** if FCC extension registration is not yet available on Coston2 during the build window, run the engine in a real Confidential VM (Intel TDX / AMD SEV-SNP), attest it, and register its attestation-bound signing key on-chain. Same trust guarantee; still no mock.

## 4. Contracts

### 4.1 `EclipseSettlement.sol`
Escrow + net settlement. Core surface:

```solidity
// Deposit/withdraw real FXRP or USDT0 into per-account escrow.
function deposit(address token, uint256 amount) external;
function withdraw(address token, uint256 amount) external; // reverts if account has an open matched leg

// Settle one batch. `s` carries batchId, per-account net deltas, clearingPrice, ftsoRef, expiry, nonce.
// `signature` must resolve to a signer bound to a whitelisted TEE code-hash.
function settleBatch(Settlement calldata s, bytes calldata signature) external;

event Deposited(address indexed account, address indexed token, uint256 amount);
event Withdrawn(address indexed account, address indexed token, uint256 amount);
event BatchSettled(uint256 indexed batchId, uint256 clearingPrice, uint256 ftsoRef, address signer);
```

Settlement rules enforced on-chain:
- Signer must be bound to a whitelisted code-hash (via `EclipseRegistry`) → else `UnattestedSigner()`.
- `|clearingPrice − ftsoRef| ≤ BAND_BPS` and `ftsoRef` matches the value read this tx → else `PriceOutsideBand()`.
- Net deltas per account must conserve value (sum of FXRP deltas and USDT0 deltas each net to zero across the batch) → else `UnbalancedBatch()`.
- `nonce` strictly increasing per engine to prevent replay → else `ReplayedBatch()`.
- Each account must have sufficient escrow to cover its negative leg → else `InsufficientEscrow()`.
- `ReentrancyGuard` + `SafeERC20` on all transfers.

### 4.2 `EclipseRegistry.sol`
Holds the trusted settlement signer and the whitelisted code-hash set.

```solidity
function registerCodeHash(bytes32 codeHash, address signer) external onlyOwner;
function revokeCodeHash(bytes32 codeHash) external onlyOwner;
function isAuthorized(address signer) external view returns (bool);

event CodeHashRegistered(bytes32 indexed codeHash, address indexed signer);
event CodeHashRevoked(bytes32 indexed codeHash);
```

`owner` is a governance/multisig in production. Traders never depend on the owner for custody — idle escrow is always withdrawable regardless of the signer set.

## 5. TEE matching engine

- **Input:** encrypted orders `{side, baseAmount, limitPrice, account, nonce, expiry}` (sealed to the engine's attested public key).
- **Batch auction:** every interval (default 30s), decrypt orders in-enclave, find the single uniform clearing price that maximizes matched base volume, clamp/validate against the FTSO band, and compute **net** per-account deltas in FXRP and USDT0.
- **Output:** a `Settlement` struct signed with the enclave key (`fce-sign`), pushed on-chain by the relay via `settleBatch`.
- **What never leaves the enclave:** individual orders, the book, and per-order fills. Only net deltas + clearing price + FTSO reference are revealed.

## 6. Relay (untrusted)

- Accepts encrypted orders over HTTPS, zod-validates envelope shape (not contents — it can't read them), forwards to the engine, and relays the signed `Settlement` on-chain.
- Holds no custody and no signing authority over funds. If the relay is fully compromised, the worst it can do is withhold service; it cannot move user funds or read orders.

## 7. Configuration

`.env` (see `.env.example`; never commit secrets):

```
COSTON2_RPC=https://coston2-api.flare.network/ext/C/rpc
CHAIN_ID=114
FLARE_CONTRACT_REGISTRY=0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019
XRP_USD_FEED_ID=0x015852502f55534400000000000000000000000000
BAND_BPS=50                 # ±0.5% fairness band vs FTSO
BATCH_INTERVAL_SECONDS=30
DEPLOYER_PRIVATE_KEY=       # local only, never commit
```

Everything else (FtsoV2, AssetManager, FXRP, USDT0) is resolved at runtime from the registry.

## 8. Running it

```bash
# 1. Install + build shared types
pnpm install
pnpm --filter @eclipse/shared build

# 2. Fund the deployer from the Coston2 faucet (C2FLR + FXRP + USDT0), confirm on explorer
cp .env.example .env       # then fill in the keys

# 3. Resolve live addresses (no hardcoding) and sanity-check an FXRP transfer
pnpm --filter @eclipse/scripts resolve
TO_ADDRESS=0x... pnpm --filter @eclipse/scripts transfer:fxrp

# 4. Deploy contracts to Coston2 (writes deployments/coston2.json), then verify
pnpm --filter @eclipse/contracts build
pnpm --filter @eclipse/scripts deploy
pnpm --filter @eclipse/contracts exec hardhat verify --network coston2 <settlement> <args...>

# 5. Build the TEE extension reproducibly and register its code-hash
#    (SOURCE_DATE_EPOCH pinned so the code-hash matches the on-chain whitelist)
SOURCE_DATE_EPOCH=1700000000 pnpm --filter @eclipse/tee build:reproducible
ENGINE_CODE_HASH=<hash> ENGINE_SIGNER_ADDRESS=<attested signer> \
  pnpm --filter @eclipse/scripts register:codehash

# 6. Start relay + engine, then run a batch
pnpm --filter @eclipse/tee start
pnpm --filter @eclipse/relay start
pnpm --filter @eclipse/scripts demo:batch   # 4 sealed orders → one clearing price → settleBatch

# 7. Frontend
pnpm --filter @eclipse/web dev
```

> Local test suites (no network): `pnpm --filter @eclipse/contracts test`,
> `pnpm --filter @eclipse/tee test`, `pnpm --filter @eclipse/relay test`.
> Toolchain note: the runnable contract tests are Hardhat + TypeScript (Foundry
> is optional via `contracts/foundry.toml`) — see `README.md`.

## 9. Testing

Required tests (Foundry/Hardhat):

- **Happy path:** deposits → sealed batch → `settleBatch` → correct net balances, one clearing price.
- **Attestation negative:** settlement signed by a non-whitelisted code-hash → `UnattestedSigner()`.
- **Fairness negative:** clearing price outside the FTSO band → `PriceOutsideBand()`.
- **Custody safety:** withdraw with an open matched leg → reverts; idle escrow withdraw always succeeds.
- **Replay:** reusing a batch nonce → `ReplayedBatch()`.
- **Conservation:** unbalanced net deltas → `UnbalancedBatch()`.

## 10. Security notes

- **Trust root:** hardware TEE attestation + on-chain code-hash whitelist. Compromising settlement requires forging attestation for a modified build.
- **Operator cannot steal:** the relay/operator has no custody path; only the attested signer authorizes transfers, and only within escrowed balances.
- **Oracle risk:** clearing price is bounded by FTSO read in the same settlement tx, limiting the damage from any single manipulated batch.
- **Redeemability:** a trader's idle escrow is always withdrawable, independent of governance and the signer set.

## 11. Roadmap (post-hackathon)

1. **Verified-counterparty pools** — KYC/attestation-gated batches (aligns with institutional lending-market models where only approved counterparties trade).
2. **Direct FXRP entry via Smart Accounts** — deposit straight from an XRPL Payment, no Flare gas needed by the trader.
3. **Multi-asset** — extend beyond FXRP/USDT0 as more FAssets go live.
4. **Songbird → Flare mainnet** as FCC rolls out on each.
5. **Continuous confidential matching** beyond discrete batch auctions.

---

### Appendix: XRP/USD feed id derivation
`"XRP/USD"` → hex `5852502f555344`; prefix crypto category byte `01`; zero-pad to 21 bytes →
`0x015852502f55534400000000000000000000000000`.
