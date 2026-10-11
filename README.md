# VaultBridge

An independently maintained Obsidian sync plugin derived from Remotely Save's
Apache-licensed components, with its own sync engine, conflict handling, and
Google Drive/Dropbox integrations. Supports **S3, Google Drive and Dropbox**
without an upstream subscription account or hosted bridge.

VaultBridge reuses the credited S3 adapter and compatible OpenSSL/rclone
encryption components. The isolated build excludes the upstream `pro/` runtime.
See [LICENSE](./LICENSE) and [NOTICE](./personal/NOTICE) for attribution and the
separate licenses of retained source directories.

## Setup

Read the [VaultBridge setup guide](./personal/README.md) for installation,
encryption, your own OAuth apps and conflict resolution. The plugin ID is
`vaultbridge`.

The [Linux/Android guide](./personal/LINUX_ANDROID.md) covers release-candidate
installation and the current manual mobile authorization setup.

The default build writes its files only under `dist/personal/`:

```sh
npm ci --ignore-scripts
npm run build --ignore-scripts
npm run check:dependencies --ignore-scripts
npm run typecheck --ignore-scripts
npm test --ignore-scripts
```

Inspect scripts before executing them. These commands are documented for local
development; opening Obsidian, configuring credentials and applying a sync are
separate manual steps. Install the files from `dist/personal/` together, rather
than mixing files from the reference implementation.

## Behavior and validation

Sync is manual: preview first, then apply the reviewed plan. Separate Markdown
edits merge against a saved common version; overlapping edits and binary
conflicts preserve both versions for review. Overwrites retain local backups.
Deletion/rename propagation and automatic scheduled sync are not implemented.

Setup offers a checklist and a connection check that lists the target and reads
one bounded sample without uploading. Custom exclusions apply to both sides.
Preview includes file selection, search/action filters, progress counts, bounded
Markdown conflict comparisons and a proposed merged-result view. Apply includes
checked files, including hidden checked files; unchecked files stay untouched.
The **Browse VaultBridge backups** command restores local copies with an
undo backup and offers reviewed cleanup of older runs into the vault's `.trash`.
No backups are automatically removed. Saved settings are versioned and validated;
damaged fields require review, and unreadable/future settings remain blocked.
Interrupted runs leave per-file journal markers for a fresh preview. Local
replacements get final checks after uploads/folder creation; S3 reads/writes
carry object-version conditions. Cloud merge history survives OAuth token
rotation, and settings saves run in order with independent snapshots.
The last 20 Apply results include counts and backup links. Redacted diagnostic
exports omit credentials, targets, file paths and note contents.

Cancel or close the preview dialog to stop further work. During Apply, an
already-issued request or write can finish; the plugin stays locked until it
settles. Changes are not rolled back, so preview again before continuing.
Encryption worker replies have a two-minute timeout and release their message
ports; unloading stops subsequent sync operations and terminates workers.

Encryption passwords are held for the current session. Storage/OAuth credentials
and local merge history are saved locally, so keep plugin settings private.
Existing S3 prefixes and rclone encryption formats are not migrated by renaming
this plugin. The legacy rclone format has known whole-file integrity limitations,
described in the setup guide.

See [validation results](./personal/VALIDATION.md). Linux/Android and live cloud
testing are **deferred, not verified**, until development is complete. The
automated suites use simulated vaults and cloud responses.

## Development and retained references

Active source, build script and setup documentation live in `personal/`.
`build:personal` and `test:personal` remain aliases for existing local workflows.
`test:compatibility` also runs retained compatibility and upstream regression
tests. The npm package is private and is not intended for registry publishing.

The [upstream reference index](./upstream-reference/INDEX.md) separates historical
documentation, manifests, build configurations and GitHub workflows from
VaultBridge's active setup. Original source remains in `src/` and `pro/` with
its license files. Git history and format-specific identifiers remain intact.
Archived workflows are inactive; no automatic publishing or upstream CLA bot
is configured for VaultBridge.

VaultBridge's own CI checks the build, dependency audit, types, compatibility
tests and candidate packaging. See [CONTRIBUTING](./CONTRIBUTING.md) for Git LFS
setup and the separation of runtime and retained development dependencies.

The remaining development agenda is tracked in [ROADMAP](./personal/ROADMAP.md).
