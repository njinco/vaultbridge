// SPDX-License-Identifier: Apache-2.0
import { diffIndices } from "node-diff3";
import { textOf } from "./engine";
import type { Change } from "./engine";

export function mergedMarkdown(
  change: Change
): { local: string; remote: string; result: string } | undefined {
  if (
    change.action !== "merge" ||
    !change.path.toLowerCase().endsWith(".md") ||
    !change.local ||
    !change.remote ||
    !change.result ||
    change.local.byteLength +
      change.remote.byteLength +
      change.result.byteLength >
      128 * 1024
  )
    return undefined;
  const local = textOf(change.local),
    remote = textOf(change.remote),
    result = textOf(change.result);
  if (
    local === undefined ||
    remote === undefined ||
    result === undefined ||
    [local, remote, result].reduce(
      (n, s) => n + (s.match(/[^\n]*\n|[^\n]+$/g)?.length ?? 0),
      0
    ) > 2000
  )
    return undefined;
  return { local, remote, result };
}

export interface DiffLine {
  kind: "same" | "local" | "remote";
  text: string;
}
// Bounded line comparison keeps large notes from blocking the mobile UI.
export function compareMarkdown(
  path: string,
  local?: ArrayBuffer,
  remote?: ArrayBuffer
): DiffLine[] | undefined {
  if (
    !path.toLowerCase().endsWith(".md") ||
    !local ||
    !remote ||
    local.byteLength + remote.byteLength > 128 * 1024
  )
    return undefined;
  const a = textOf(local),
    b = textOf(remote);
  if (a === undefined || b === undefined) return undefined;
  const left = a.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const right = b.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (left.length + right.length > 2000) return undefined;
  const result: DiffLine[] = [];
  let cursor = 0;
  for (const region of diffIndices(left, right)) {
    const [offset, count] = region.buffer1 as number[];
    for (const text of left.slice(cursor, offset))
      result.push({ kind: "same", text });
    for (const text of region.buffer1Content as string[])
      result.push({ kind: "local", text });
    for (const text of region.buffer2Content as string[])
      result.push({ kind: "remote", text });
    cursor = offset + count;
  }
  for (const text of left.slice(cursor)) result.push({ kind: "same", text });
  return result;
}
