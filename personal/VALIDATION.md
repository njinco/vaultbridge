# VaultBridge validation

## Automated results

The worker/cancellation check passed the isolated build, TypeScript check and all
188 tests in `test:compatibility`. Package/lockfile/manifests/version-map metadata
agree, and active entry-point documentation links resolve locally. The default
`test` command now selects VaultBridge tests; `test:compatibility` retains the
broader inherited regression coverage. None of these checks used a live cloud
account or a real Obsidian vault.

The rclone integration suite runs the built VaultBridge plugin, its actual
encryption worker code, S3 request signing and the sync/backup engine. A test
harness replaces Obsidian, browser worker transport, vault files and S3 HTTP
responses with in-memory equivalents. It copies messages and detaches
transferred buffers, but is not a real browser or mobile runtime.

Verified:

- Read filenames/content produced by the existing rclone library, including
  encrypted directories and Unicode names.
- Encrypt new uploads and decrypt downloads on a second simulated device.
- Round-trip zero-byte files and binary data across the 65,536-byte boundary.
- Generate different ciphertext for repeated encryption of the same content.
- Merge separate Markdown edits using a saved common version, encrypt the
  result remotely, and retain both original versions in local backups.
- Preserve overlapping conflicts without overwriting either original.
- Reject wrong passwords, ciphertext bit changes and short truncation before
  any sync writes; clean up workers and avoid logging sensitive error details.
- Prompt for a session password before any cloud request; cancelling makes no
  requests; settings/checkpoints never serialize the encryption password.
- Upgrade the preliminary saved-password format by rewriting it empty and
  retaining its value only for the current session.

Known legacy-format limitation: removing a complete final encrypted block can
produce an authenticated shorter file. Valid ciphertext replay/substitution and
remote inventory changes are not prevented by per-block encryption. The tests
record this limitation; they do not imply whole-file/version authentication.

Google Drive failure tests also verify acknowledged-range continuation,
completion checks after lost responses, bounded recovery, expired-session
stops, malformed upload metadata, one-time 401 refresh/retry, concurrent refresh
deduplication, safe revoked-token messages, malformed-token rejection, callback
binding and restoration of in-memory credentials after authorization-save
failure. These use fake transport responses, not a live Google account.

Dropbox failure tests verify complete paginated listings, Unicode paths,
revision-conditional updates, strict creates, metadata validation, safe failure
stops and own-app authentication. An engine integration test simulates a remote
edit after the last content check: the conditional upload is rejected, the
remote edit and backup survive, and the saved common version does not advance.
All provider responses are simulated; live Dropbox testing is deferred.

Worker/lifecycle tests cover silent-worker timeouts, crashes, message/send errors,
malformed replies, rejection of pending requests on close, and closure of both
message ports. The actual bundled plugin is also exercised with silent/crashed
workers, cancellation while native HTTP is pending, unloading during password
entry or a reviewed preview, and cancellation/unload during an S3 upload. The
in-flight upload can complete, but the next file is not uploaded and no common
version checkpoint advances. Cleanup prevents restarting an unloaded instance.
Timeouts are shortened only in the fake runtime; the plugin timeout is two minutes.
Native HTTP/file operations are cooperatively stopped after they settle, not
forcibly aborted or rolled back. No real device/network cancellation was tested.

## Real desktop/mobile trial — deferred, not verified

No real vault or cloud account was used for automated validation. Run this
trial with disposable data before switching your working vault. The user has
chosen to defer this trial until development is finished; it has not been run.

For Linux and Android, `personal/prepare_trial.py` packages the existing build
into two disposable vault ZIPs under `dist/personal/trial-kit-<id>/`. It does not
execute the plugin or contact any service. Both vaults have VaultBridge disabled
and no saved credentials; Linux contains deterministic fixtures and Android
starts empty. Follow the generated `TRIAL.md`, using its unique S3 test prefix,
and record actual device results in `RESULTS.md`. Packaging verification does
not replace the real-device trial.

1. Create a new vault named `VaultBridge Test` on desktop. Use a separate S3
   bucket or an unmistakably separate prefix, such as
   `vaultbridge-validation/`. Do not use your existing working prefix. Copy
   the three plugin build files as described in the setup guide and enable
   VaultBridge manually.
2. Configure S3 locally, choose **rclone (legacy compatible)**, and use a new
   test passphrase. Create `note.md` containing four lines: `one`, `two`,
   `three`, `four`. Add a small attachment and a zero-byte file.
3. Preview and check the proposed uploads before applying. Inspect the test
   bucket/prefix in the provider UI: object names and downloaded bytes should
   be encrypted, while file sizes and timestamps remain visible.
4. Create a second disposable vault on mobile, install VaultBridge and enter
   the same test S3 prefix and passphrase locally. Preview/download. Check
   all file contents and attachments. Never send credentials here.
5. Preview/apply on both devices until each has a saved common version. While
   offline, change `one` to `ONE` on desktop and `four` to `FOUR` on mobile.
   Sync desktop, then mobile, then desktop. Check that both show both edits
   and that local backups contain the previous versions.
6. Establish a common version again. Change the same line differently on
   each device, sync one, then preview on the other. Confirm the conflict
   defaults to preserving both. Apply and inspect its backups, then test an
   explicit **Use local** or **Use remote** resolution.
7. Reload/lock the plugin and enter an incorrect test passphrase. Confirm
   preview stops and no note/object is overwritten. Retry with the correct
   passphrase. Inspect this test plugin's `data.json` locally: its `password`
   field should be empty. API/storage credentials remain sensitive.
8. Repeat with temporary folders and separately authorized own apps for
   Dropbox and Drive. Check encryption in the provider UI
   and repeat the two-device merge/conflict steps.

The original Remotely Save plugin and other sync plugins must be disabled in
these test vaults. Deletion/rename propagation is not implemented: missing
files are restored from the other side. Avoid editing files while applying a
reviewed plan. Keep the working vault and working cloud prefix separate
throughout the trial.
