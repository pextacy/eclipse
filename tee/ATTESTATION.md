# Eclipse TEE — attestation & reproducible build

This is the milestone that makes Eclipse a *Confidential Compute app*, not just a
private server. The chain trusts the **build**, not the operator.

## Trust chain

```
reproducible source ──► deterministic code-hash ──► whitelisted in EclipseRegistry
                                                          │  bound to
enclave signing key (fce-sign) ───────────────────────────┘
                                                          ▼
EclipseSettlement.settleBatch: signature must recover to the bound signer,
whose code-hash is whitelisted → else UnattestedSigner()
```

## 1. Reproducible build → code-hash

```bash
SOURCE_DATE_EPOCH=1700000000 pnpm --filter @eclipse/tee build:reproducible
# → prints ENGINE_CODE_HASH and writes tee/build/codehash.json
```

The hash is computed from the engine source with normalized (LF) line endings,
sorted files, and the pinned toolchain + `SOURCE_DATE_EPOCH` folded in, so it is
**identical on any machine/OS** given identical source (see `codehash.test.ts`).
A single changed byte changes the hash — which is exactly what on-chain
whitelisting depends on. **A non-reproducible build is a release blocker**
(CLAUDE.md §2.6).

## 2. Attested-key registration (verify once, check cheaply forever)

On-chain full attestation verification is heavy, so we verify the hardware
attestation **once**, at registration, then bind the enclave's signing key to its
code-hash:

```bash
ENGINE_CODE_HASH=<hash from step 1> ENGINE_SIGNER_ADDRESS=<attested signer> \
  pnpm --filter @eclipse/scripts register:codehash
```

`toRegistration()` (`src/fce/attestation.ts`) enforces the linkage a verifier
must confirm before whitelisting: the attested code-hash equals the
reproducible-build code-hash, the quote commits to the signer key, and a
`dev`-provenance signer is refused. Quote-signature verification itself is
delegated to the platform attestation library (Intel/AMD/FCC).

After registration, each settlement is checked cheaply on-chain: the signature
must recover to the bound signer (`EclipseRegistry.isAuthorized`).

## 3. Negative paths (proved on-chain)

- A settlement signed by a **non-whitelisted** code-hash → `UnattestedSigner()`
  (revert). See `test/contracts/EclipseSettlement.test.ts`
  → *"reverts UnattestedSigner when signed by a non-registered key"*.
- A **revoked** code-hash can no longer settle. See *"blocks a settlement signed
  by a revoked (non-whitelisted) build"*.

## 4. Ship-vs-fallback decision (lock by Day 11)

| Path | When | Trust model |
|------|------|-------------|
| **FCC extension** (preferred) | FCC extension registration is live on Coston2 | Enclave signs via `fce-sign`; code-hash whitelisted in `TeeMachineRegistry`/`TeeExtensionRegistry` |
| **Confidential VM fallback** | FCC extension registration not yet live in the build window | Real Intel **TDX** / AMD **SEV-SNP** VM; attest it; register its attestation-bound signing key on-chain — **same trust model, still no mock** |

Both paths register an attestation-bound signing key on-chain and settle through
the identical `EclipseSettlement` check. The only thing that differs is *how* the
enclave is measured — never *whether* the chain verifies it. Decide the shipping
path by **Day 11** so Phase 3 cannot slip the demo.

## Local dev only

FCC's simulated / `MODE=0` attestation is permitted for local unit tests
(CLAUDE.md §2.1). It is **never** used in the deployed Coston2 demo: the deployed
engine runs as a real FCC extension or a real Confidential VM, and the on-chain
contract always verifies a real attestation-bound signer.
