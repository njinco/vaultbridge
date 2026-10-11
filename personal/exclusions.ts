// SPDX-License-Identifier: Apache-2.0
import { PersonalSyncError } from "./errors";
// Relative, case-sensitive globs. No regex, negation or filesystem traversal.
export function compileExclusions(source: string): (path: string) => boolean {
  if (new TextEncoder().encode(source).byteLength > 8192)
    throw new PersonalSyncError("Exclusion rules exceed 8 KiB.");
  const rules = source
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  if (rules.length > 100)
    throw new PersonalSyncError("Use at most 100 exclusion rules.");
  const patterns = rules.map((rule) => {
    if (
      rule.length > 256 ||
      rule.startsWith("/") ||
      /[\\\x00-\x1f\x7f!\[\]{}:]/.test(rule) ||
      rule.split("/").some((p) => p === "." || p === "..") ||
      rule.includes("***") ||
      rule.includes("//")
    )
      throw new PersonalSyncError(
        "Invalid exclusion rule. Use relative paths, folder/, *, ? or ** only; no negation or parent paths."
      );
    const folder = rule.endsWith("/");
    const value = folder ? rule.slice(0, -1) : rule;
    const tokens: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "*" && value[i + 1] === "*") {
        i++;
        if (value[i + 1] === "/") {
          tokens.push("**/");
          i++;
        } else tokens.push("**");
      } else tokens.push(value[i]);
    }
    return { tokens, folder, basename: !value.includes("/") && !folder };
  });
  return (path) =>
    patterns.some((rule) => {
      const name = rule.basename ? path.slice(path.lastIndexOf("/") + 1) : path;
      if (match(rule.tokens, name)) return true;
      return rule.folder && match([...rule.tokens, "/", "**"], path);
    });
}
// Dynamic programming avoids regex backtracking on user-supplied patterns.
function match(tokens: string[], path: string): boolean {
  let previous = new Uint8Array(path.length + 1);
  previous[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(path.length + 1);
    if (["*", "**", "**/"].includes(token)) next[0] = previous[0];
    let reachable = false;
    for (let j = 1; j <= path.length; j++) {
      const c = path[j - 1];
      reachable ||= !!previous[j - 1];
      if (token === "**/")
        next[j] = previous[j] || Number(c === "/" && reachable);
      else if (token === "*" || token === "**")
        next[j] =
          previous[j] || Number(!!next[j - 1] && (token === "**" || c !== "/"));
      else
        next[j] = Number(
          !!previous[j - 1] && (token === "?" ? c !== "/" : c === token)
        );
    }
    previous = next;
  }
  return !!previous[path.length];
}
