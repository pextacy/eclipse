import { describe, it, expect } from "vitest";
import { computeCodeHash, type FileEntry } from "../src/fce/codehash.js";
import { toRegistration, type AttestationBundle } from "../src/fce/attestation.js";

const toolchain = { node: "20.0.0", typescript: "5.5.4" };
const files: FileEntry[] = [
  { path: "engine.ts", content: "export const a = 1;\n" },
  { path: "seal.ts", content: "export const b = 2;\n" },
];

describe("reproducible code-hash", () => {
  it("is deterministic and order-independent", () => {
    const h1 = computeCodeHash(files, { sourceDateEpoch: 1700000000, toolchain });
    const h2 = computeCodeHash([...files].reverse(), { sourceDateEpoch: 1700000000, toolchain });
    expect(h1).to.equal(h2);
    expect(h1).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("is insensitive to CRLF vs LF line endings (cross-OS reproducibility)", () => {
    const lf = computeCodeHash(files, { sourceDateEpoch: 1700000000, toolchain });
    const crlf = computeCodeHash(
      files.map((f) => ({ ...f, content: f.content.replace(/\n/g, "\r\n") })),
      { sourceDateEpoch: 1700000000, toolchain },
    );
    expect(lf).to.equal(crlf);
  });

  it("changes when any source byte, the epoch, or the toolchain changes", () => {
    const base = computeCodeHash(files, { sourceDateEpoch: 1700000000, toolchain });
    const changedSrc = computeCodeHash(
      [{ ...files[0]!, content: files[0]!.content + " " }, files[1]!],
      { sourceDateEpoch: 1700000000, toolchain },
    );
    const changedEpoch = computeCodeHash(files, { sourceDateEpoch: 1700000001, toolchain });
    const changedTool = computeCodeHash(files, {
      sourceDateEpoch: 1700000000,
      toolchain: { ...toolchain, typescript: "5.5.5" },
    });
    expect(changedSrc).to.not.equal(base);
    expect(changedEpoch).to.not.equal(base);
    expect(changedTool).to.not.equal(base);
  });
});

describe("attestation → registration", () => {
  const bundle: AttestationBundle = {
    codeHash: "0x" + "11".repeat(32),
    signerAddress: "0x" + "22".repeat(20),
    sealedPublicKey: "cGs=",
    quote: "cXVvdGU=",
    provenance: { kind: "fce-extension", codeHash: "0x" + "11".repeat(32) },
  };

  it("returns the on-chain registration args for a valid bundle", () => {
    expect(toRegistration(bundle)).to.deep.equal({
      codeHash: bundle.codeHash,
      signer: bundle.signerAddress,
    });
  });

  it("refuses a dev-provenance signer for the deployed demo", () => {
    expect(() =>
      toRegistration({ ...bundle, provenance: { kind: "dev", note: "local" } }),
    ).toThrow(/dev-provenance/);
  });

  it("rejects a code-hash mismatch between the quote and the reproducible build", () => {
    expect(() =>
      toRegistration({
        ...bundle,
        provenance: { kind: "confidential-vm", tee: "tdx", codeHash: "0x" + "99".repeat(32) },
      }),
    ).toThrow(/does not match/);
  });
});
