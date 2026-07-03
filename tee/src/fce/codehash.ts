import { keccak256, toUtf8Bytes } from "ethers";

/**
 * Deterministic engine code-hash.
 *
 * The trust model (CLAUDE.md §2.3, §2.6) requires the engine to build
 * reproducibly so its code-hash matches the value whitelisted on-chain. This
 * module computes that hash from the engine source in a machine-independent way:
 * line endings are normalized, files are sorted, and the pinned toolchain +
 * `SOURCE_DATE_EPOCH` are folded in. Two builds of identical source on any OS
 * produce the same hash; a single changed byte changes it — exactly the property
 * `EclipseRegistry`/`TeeMachineRegistry` whitelisting relies on.
 */
export interface FileEntry {
  path: string;
  content: string;
}

export interface CodeHashInputs {
  sourceDateEpoch: number;
  toolchain: Record<string, string>;
}

export function computeCodeHash(files: FileEntry[], inputs: CodeHashInputs): string {
  const normalized = files
    .map((f) => ({
      path: f.path.replace(/\\/g, "/"),
      content: f.content.replace(/\r\n/g, "\n"),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const parts: string[] = [`SOURCE_DATE_EPOCH=${inputs.sourceDateEpoch}`];
  for (const [k, v] of Object.entries(inputs.toolchain).sort(([a], [b]) => (a < b ? -1 : 1))) {
    parts.push(`toolchain:${k}=${v}`);
  }
  for (const f of normalized) {
    parts.push(`${f.path}:${keccak256(toUtf8Bytes(f.content))}`);
  }
  return keccak256(toUtf8Bytes(parts.join("\n")));
}
