# VaultBridge

An independent personal Obsidian plugin for S3, Google Drive and Dropbox.
New code in `personal/` is Apache-2.0. The S3 adapter and existing OpenSSL/rclone
encryption formats reuse Apache-licensed code from `src/`. The Dropbox, Drive,
OAuth and sync implementations are independent of `pro/`.

The build rejects PRO runtime imports, audits the encryption worker too, and
permits only Obsidian as an external runtime dependency. It uses no upstream
subscription account, license gate, hosted bridge or default upstream OAuth app.
Retained upstream source and its license files remain separate. Historical
manifests, build configurations and documentation are indexed under
[`upstream-reference/`](../upstream-reference/INDEX.md).

See [validation results and the desktop/mobile trial checklist](./VALIDATION.md).

Follow the [Linux and Android installation/setup guide](./LINUX_ANDROID.md) for
the release candidate, including manual mobile credential setup for own apps.

The supported services are S3, Google Drive and Dropbox. Box support has been
removed from VaultBridge. An older saved Box selection is blocked until you
explicitly choose a supported service; it is never redirected automatically.

## Current behavior

- Manual **Preview VaultBridge sync** command/ribbon button, followed by an Apply
  button. Loading the plugin makes no cloud requests and starts no sync timer.
- Uploads and downloads normal vault files within the selected remote folder or
  S3 prefix. Listings are fully paginated before an apply plan is offered.
- Compares SHA-256 content hashes instead of trusting modification times.
- Automatically merges separate Markdown line edits against a verified saved
  common version. Keeps line endings, BOMs and final newline changes.
- Overlapping edits, divergent first-sync files and binary conflicts default to
  keeping both originals untouched. Applying the plan saves both versions for
  manual review. A preview dropdown can explicitly choose the local or remote
  version, backing up the version it replaces.
- Saves local copies of overwritten files and remote copies before overwriting
  them in `_personal_sync_backups/<run>/local/` and `remote/`. These backups are
  visible locally and excluded from sync. Backups are not automatically pruned.
- Excludes hidden files/directories, vault configuration, old Remotely Save
  metadata and debug files. Does not import the original plugin's ignore rules.
- Missing files are restored from the other side. **Deletion and rename
  propagation are not implemented**; a rename is treated as a new file and the
  old path can be restored. Empty folders are not synced.
- Rechecks reviewed files before writes and verifies both resulting copies
  before saving a new baseline. This is not a distributed transaction: keep
  other writers idle while applying. Providers can change files between a check
  and an upload. A partial failure preserves backups and requires a new preview.

The first version supports desktop and mobile browser runtimes. **Real Obsidian
desktop/mobile and live cloud testing have not yet been performed.** Tests use
in-memory stores, mocked provider APIs and the actual bundle with simulated
Obsidian/mobile transport and the actual bundled encryption worker code. Try a copied test vault and a separate remote prefix
before enabling it on your working vault.

Safety limits: 50 MiB per plaintext file, 256 MiB of combined file contents per
preview, and 1 MiB/10,000 lines per Markdown merge. Unsupported paths and
case/Unicode collisions stop the preview. Large vaults need a later streaming
implementation; no files are silently skipped to fit these limits.

## Build and install locally

Dependencies were installed with lifecycle scripts disabled. After inspecting
the build script, use:

```sh
node personal/build.mjs
./node_modules/.bin/tsc --noEmit --skipLibCheck
./node_modules/.bin/mocha --import=tsx 'tests/personal*.test.ts'
```

The default npm commands are `npm run build --ignore-scripts`,
`npm run typecheck --ignore-scripts` and `npm test --ignore-scripts`.
`build:personal` and `test:personal` remain aliases. Use
`npm run test:compatibility --ignore-scripts` for the full retained regression
suite. Bundle tests skip when build artifacts
are absent, so build first for complete verification.

Use Node.js 20.11 or newer for the local build script. The root package and
manifest now describe VaultBridge; `personal/manifest.json` is the build's
manifest source and must match the root manifest. Dependencies needed by
retained sources/tests remain in the development toolchain but are not all
included in the audited plugin bundle.

After reviewing `personal/package_release.py`, create a local candidate with
`python3 personal/package_release.py --label rc.1`. It packages the existing
build under `dist/personal/release-candidate-<version>-<label>-<hash>/`, verifies
ZIP contents and checksums, and includes legal files for audited third-party
dependencies. It does not rebuild, install, enable, publish or contact a cloud
service. Existing candidate directories are not overwritten; use a new label
for the next candidate. The plugin manifest remains `0.1.0`; `rc.1` labels the
candidate archive rather than changing the Obsidian plugin version.

Copy `dist/personal/main.js`, `manifest.json`, and `styles.css` into:

```text
<your vault>/<config directory>/plugins/vaultbridge/
```

The usual config directory is `.obsidian`. Reload Obsidian and enable
**VaultBridge**. Disable the original Remotely Save and other sync
plugins for the same vault. This project is not installed into any vault by
the build script. You do not submit or upload this plugin to Obsidian.

If you already installed the preliminary **Personal Vault Sync** build, disable
it and copy its local `data.json` from `plugins/personal-vault-sync/` to
`plugins/vaultbridge/` before enabling VaultBridge. This preserves settings and
merge baselines. The build does not perform this vault operation automatically.
The rename does not change remote prefixes, encrypted filenames or encryption
keys. For your existing rclone-encrypted storage, choose **rclone (legacy
compatible)** with the same password on each device.

## Start with your existing S3 setup

Copy the endpoint, region, bucket, access key, secret key, path-style setting and
exact remote prefix from your existing setup **locally**. An empty endpoint uses
the standard AWS endpoint for your region. Custom endpoints must include HTTPS.
Preserve the prefix, including its trailing slash. A blank prefix means the
whole bucket, so a dedicated prefix/bucket is preferable for a test.

Explicitly choose **Unencrypted**, **OpenSSL (legacy compatible)**, or **rclone
(legacy compatible)**, matching the existing remote format. If encrypted, enter the same
password in the unlock prompt when you preview. It is kept in memory for the
current session and is not saved in `data.json`. Reloading/disabling the plugin,
changing provider/format, or choosing **Lock encryption** clears its session
reference. A failed preview also clears it so you can retry a mistaken password.
Selecting a different format/password is not a migration.
The plugin decrypts names before planning; decryption failures stop the preview.
OpenSSL-encrypted names are detected when unencrypted is mistakenly selected.
Unencrypted rclone names cannot reliably be recognized without their password.

No production S3 objects have been inspected or changed during development.
Compatibility tests cover the existing prefix, OpenSSL byte/name format, and
rclone encrypted upload/download using the actual bundled worker implementation.
The rclone suite covers Unicode/nested names, binary block boundaries, empty
files, wrong passwords, modified ciphertext, short truncation, conflict merging,
backups, cancellation and session-only password persistence. It still needs
an end-to-end test in real Obsidian desktop/mobile.

The legacy rclone format authenticates individual content blocks, not a whole
file's expected length or version. Tests demonstrate that removing a complete
final block can leave a valid shorter file. Valid ciphertext can also be replayed
or substituted; filenames are encrypted but not bound cryptographically to file
contents. Encryption does not authenticate the remote directory inventory.
Do not treat it as protection against every action by a malicious storage
provider. Preserving compatibility means we have not added a new whole-file
authentication format or migrated any existing objects.

When upgrading the preliminary VaultBridge build, an old saved password is
retained for the current session and rewritten as empty in plugin settings.
This does not erase copies in old device backups. Local notes, merge baselines
and conflict backups remain plaintext.

## Own cloud applications

These features require provider credentials and storage access, not a Remotely
Save subscription. Your cloud provider's quotas, billing and app policies still
apply. Credentials, local Markdown baselines and backups are stored locally in
plain form, like the vault's own notes. Do not commit or share the plugin's
`data.json`, backup folder or OAuth callback URL. Remote encryption does not
encrypt local settings or local backup files.

**Google Drive:** enable the Drive API in your own Google Cloud project, configure
OAuth consent for your own account and create a Desktop OAuth client. Enter its
client ID/secret. The authorization flow uses PKCE and requests offline access.
It requests the `drive` scope so it can access an existing selected folder;
this permits broad account access, so use a dedicated account/project where
practical. A future Picker integration could use the narrower `drive.file`
scope. Personal testing accounts may have short-lived refresh tokens under
Google's OAuth testing policies; configure the consent screen appropriately.
Use a dedicated ordinary folder ID from its Drive URL. Google-native documents
and shortcuts in that tree are unsupported and stop the preview.

Drive uploads larger than 5 MB use a resumable session. A connection failure or
temporary server failure triggers a status query; only the bytes Drive reports
missing are resent. Recovery is limited to four data attempts within that same
Apply operation. Expired sessions, invalid/stalled progress and exhausted
recovery stop the operation: preview again before retrying. Sessions are not
saved across restarts. Small multipart creates and ambiguous session creation
failures are never automatically replayed, avoiding duplicate files.

An access-token rejection triggers at most one refresh/retry. Revoked or expired
refresh authorization requires authorizing your own app again. Token response
types are checked before credentials change, and refreshes are saved before
file requests. OAuth callbacks are bound to the app/provider that started them.
If saving a newly exchanged authorization fails, previous in-memory credentials
are restored and a new authorization is required; partially written settings on
disk cannot be rolled back reliably by this check.

On **desktop**, the default redirect is `http://127.0.0.1:42813/`. Grant consent,
then copy the full redirect URL from the browser address bar after the loopback
page fails to load, and paste it into the plugin's authorization modal. The
plugin deliberately starts no listener/server. The callback must match the
redirect and random state and expires after 15 minutes. Do not use Google's
retired out-of-band authorization flow.

On **mobile**, Google's desktop loopback flow is not supported. Authorize on
desktop and privately enter the matching app credentials and refresh token in
mobile settings, with the same folder ID/encryption settings. Each device keeps
its own merge baseline. Do not share an upstream PRO token/account. Do not copy
the entire settings file between devices while they are actively syncing.

**Dropbox:** register your own scoped Dropbox app. Choose App Folder access for
a smaller scope, or Full Dropbox if your existing files require it. Grant
`files.metadata.read`, `files.content.read`, and `files.content.write` scopes.
Register a redirect URI you control; use that exact URI in the authorization
settings. The flow uses PKCE and offline access. Create the vault folder in the
app's accessible root first, then enter its path relative to that root.
Existing files made with another App Folder app are not automatically visible
to your own app; move a copy or choose the appropriate Full Dropbox access.

Dropbox uploads use revision-conditional updates for existing files and strict
adds for new files, with automatic renaming disabled. A remote edit after the
preview therefore causes a conflict rather than an unconditional overwrite.
Download metadata must match the listed file/revision and received byte count.
Incomplete or duplicate listings, out-of-root entries, non-downloadable files
and symlinks stop the preview. Missing roots are not created during preview.
An ambiguous upload failure, revision conflict or rate limit stops Apply; wait
if rate limited, then preview again. Uploads are not automatically replayed.
The plugin's 50 MiB plaintext-file limit stays below Dropbox's single-upload
limit even with supported encryption overhead; upload sessions are not used.

Provider references:
[Google native OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads),
[Dropbox OAuth](https://developers.dropbox.com/oauth-guide).

Dropbox request/revision behavior follows the
[official API specification](https://github.com/dropbox/dropbox-api-spec/blob/main/files.stone).

## Resolving a preserved conflict

Open the local and remote backup copies in `_personal_sync_backups/`, compare
them, and choose/edit the desired result. Preview again and explicitly choose
**Use local** or **Use remote** for that file, then apply. To combine both
versions yourself, edit the local note using the backups and choose **Use local**.
The overwritten version is backed up before replacement, including encrypted
remotes. A verified result establishes the next common version. Automatic
Markdown merging starts once this device has saved a verified common version;
it cannot reconstruct a missing ancestor.
