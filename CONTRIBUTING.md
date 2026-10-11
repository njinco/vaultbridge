# Contributing to VaultBridge

VaultBridge is maintained for personal use. Active implementation lives in
`personal/`; changes must keep the isolated runtime free of upstream `pro/`
imports. Preserve copyright, license and modification notices for reused code.

Review the local build and test scripts before running them. Use the setup guide
for the isolated build, type check and offline tests. Do not include credentials,
tokens, passwords, vault notes or settings files in changes or issue reports.

Install Git LFS before working with this checkout, then run `git lfs install`
and `git lfs pull`. Images and encrypted test fixtures use LFS. Without its
clean filter, materialized images can appear modified even when their SHA-256
hashes match the committed LFS pointers. Do not commit the image bytes as a fix.

Use `npm ci --ignore-scripts`, then build before running tests. The active
GitHub checks run build, dependency audit, TypeScript, the full compatibility
suite and candidate packaging on Node.js 22 and 24. They do not publish or
access vaults/cloud accounts. Run `npm run check:dependencies --ignore-scripts`
after a build to check dependency classification. `dependencies` describes
direct packages used in the audited bundle; development-only packages support
tests, type checks, retained providers and archived tooling. Keep those
development dependencies until the retained compatibility sources are retired.

The original upstream CLA and contribution instructions are retained under
`upstream-reference/`. VaultBridge has no active upstream CLA workflow and does
not ask contributors to sign an agreement with the upstream project.
