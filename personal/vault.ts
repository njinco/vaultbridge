// SPDX-License-Identifier: Apache-2.0
import type { Vault } from "obsidian";
import { PersonalSyncError } from "./errors";

export async function ensureParents(
  vault: Vault,
  path: string,
  check: () => void = () => {}
) {
  const parts = path.split("/");
  parts.pop();
  for (let i = 1; i <= parts.length; i++) {
    check();
    const folder = parts.slice(0, i).join("/");
    const exists = await vault.adapter.exists(folder);
    check();
    if (!exists) await vault.adapter.mkdir(folder);
    else if ((await vault.adapter.stat(folder))?.type !== "folder")
      throw new PersonalSyncError("File blocks a required folder.");
  }
}
