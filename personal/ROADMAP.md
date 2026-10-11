# VaultBridge agenda

## Completed development work

- Isolated VaultBridge build excluding upstream PRO runtime code.
- S3 with compatible OpenSSL/rclone encryption and session-only passwords.
- Independent Markdown merging, conflict choices and overwrite backups.
- Independent Google Drive and Dropbox adapters with failure-handling tests.
- Box removed from the supported providers.
- VaultBridge package/manifest branding, primary setup documentation and issue
  templates; upstream manifests, build configurations, policies and workflows
  moved to labeled references. License attribution and storage identifiers kept.
- Linux/Android installation and user-owned OAuth app setup instructions.
- Bounded encryption worker replies, message-port cleanup and failure handling;
  cooperative cancellation during preview/Apply and plugin unload. In-flight
  native requests/writes may finish; subsequent operations are blocked.
- Local `0.1.0-rc.2` candidate packaging with matching plugin files, licenses,
  bundled third-party legal files and verified archive/file checksums.
- VaultBridge CI for build, dependency audit, type checks, compatibility tests
  and candidate packaging; explicit secret ignores and documented Git LFS setup.
- Versioned saved-state validation and explicit recovery before sync; pure
  settings and vault helpers separated from encryption/provider initialization.
- Reduced unchanged-file Apply reads and batched baseline saves, with progress
  reporting and unchanged overwrite/verification safeguards for changed files.
- Search/action filters and bounded Markdown comparisons in conflict review.
- Backup browsing, reviewed local restore with verified undo copies, and
  optional reviewed cleanup into local trash; no automatic pruning.
- Unbundled and type-only packages moved to development dependencies with
  dependency versions and the installed package inventory preserved.
- Local `0.1.0-rc.3` candidate for the repository/usability improvements, with
  verified archive contents/checksums and 218 offline compatibility tests.
- Final local replacement checks after remote uploads and parent-folder creation.
- Conditional single-PUT S3 creates/updates and version-bound reads, with no
  unconditional fallback or SDK retry. Provider enforcement still needs trials.
- Stable provider-account merge history and conservative migration of matching
  legacy baselines; serialized immutable settings snapshots.
- Schema-2 per-target interruption journals recorded before sync writes;
  fresh-preview recovery without replay, preserved across failures/cancellation.
- Local `0.1.0-rc.4` candidate for pre-trial correctness improvements, with
  verified archive contents/checksums and 241 offline compatibility tests.
- Setup checklist and read-only connection/sample checks with actual exclusion
  lists; bounded, case-sensitive custom file/folder patterns on both sides.
- Per-file Apply selection, with unchecked files excluded from writes/backups
  and history updates; unfinished journal entries cannot be hidden and cleared.
- Bounded three-version Markdown merge preview rendered as text before Apply.
- Last 20 local Apply results, per-run backup links and allowlisted diagnostics
  exports into a hidden, sync-excluded folder; no credentials or file contents.
- Local `0.1.0-rc.5` candidate for guided setup/review improvements, with verified
  archive contents/checksums and 255 offline compatibility tests.

## Next steps

1. Perform the deferred Linux/Android and live-provider trials before using the
   plugin on a working vault. These are **not verified** by the offline tests.
2. Fix any issues identified by the trials and package a new candidate before
   treating the plugin as ready for daily use.

Additional providers can be considered later. Dependency pruning is separate
from branding cleanup because retained compatibility sources still use parts
of the original development toolchain.
