/**
 * Reproducible-build driver. Computes the engine's deterministic code-hash and
 * writes it to tee/build/codehash.json. Pin `SOURCE_DATE_EPOCH` so the hash is
 * stable across builds/machines (a non-reproducible build is a release blocker —
 * CLAUDE.md §2.6).
 *
 *   SOURCE_DATE_EPOCH=1700000000 pnpm --filter @eclipse/tee build:reproducible
 *
 * The printed ENGINE_CODE_HASH is what you whitelist on-chain:
 *   ENGINE_CODE_HASH=<hash> ENGINE_SIGNER_ADDRESS=<attested signer> \
 *     pnpm --filter @eclipse/scripts register:codehash
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import { computeCodeHash, type FileEntry } from "./codehash.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");
const teeRoot = resolve(here, "../..");
const repoRoot = resolve(teeRoot, "..");

/** Read a build manifest into the hash; missing optional files are skipped. */
function manifest(absPath: string, label: string, acc: FileEntry[]): void {
  if (existsSync(absPath)) acc.push({ path: label, content: readFileSync(absPath, "utf8") });
}

/** All engine source files are part of the measured enclave code. */
function collect(dir: string, acc: FileEntry[] = []): FileEntry[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      acc.push({ path: relative(srcRoot, full), content: readFileSync(full, "utf8") });
    }
  }
  return acc;
}

function main() {
  const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH ?? "1700000000");
  const pkg = JSON.parse(readFileSync(resolve(teeRoot, "package.json"), "utf8"));
  const toolchain = {
    node: process.versions.node,
    typescript: pkg.devDependencies?.typescript ?? "unknown",
    tweetnacl: pkg.dependencies?.tweetnacl ?? "unknown",
    ethers: pkg.dependencies?.ethers ?? "unknown",
  };

  const files = collect(srcRoot);
  // Pin exact dependencies + build config, not just version strings.
  const manifests: FileEntry[] = [];
  manifest(resolve(teeRoot, "package.json"), "tee/package.json", manifests);
  manifest(resolve(teeRoot, "tsconfig.json"), "tee/tsconfig.json", manifests);
  manifest(resolve(repoRoot, "pnpm-lock.yaml"), "pnpm-lock.yaml", manifests);
  const codeHash = computeCodeHash(files, { sourceDateEpoch, toolchain, manifests });

  const outDir = resolve(teeRoot, "build");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const out = {
    codeHash,
    sourceDateEpoch,
    toolchain,
    fileCount: files.length,
    files: files.map((f) => f.path).sort(),
    manifests: manifests.map((m) => m.path).sort(),
  };
  writeFileSync(resolve(outDir, "codehash.json"), JSON.stringify(out, null, 2) + "\n");

  console.log(`Engine reproducible build`);
  console.log(`  SOURCE_DATE_EPOCH = ${sourceDateEpoch}`);
  console.log(`  files measured    = ${files.length}`);
  console.log(`  manifests pinned  = ${manifests.map((m) => m.path).join(", ") || "(none)"}`);
  console.log(`  ENGINE_CODE_HASH  = ${codeHash}`);
}

main();
