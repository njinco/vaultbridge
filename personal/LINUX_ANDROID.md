# VaultBridge setup on Linux and Android

This is a release candidate for personal use. Automated tests passed, but real
Obsidian Linux/Android and live cloud behavior are **deferred, not verified**.
Use a copied vault and a separate remote location for the first trial. The
plugin supports one selected provider per vault; configure the same provider,
remote location and encryption format on the paired devices.

## Install the same build on both devices

1. Extract the release ZIP. Its `vaultbridge/` folder contains `main.js`,
   `manifest.json`, `styles.css`, licenses, notices and this guide.
2. On Linux, choose the test vault in Obsidian, then close Obsidian while
   copying that entire folder to `<vault>/.obsidian/plugins/vaultbridge/`.
   A vault using a custom configuration directory needs that directory instead
   of `.obsidian`. Enable hidden-file display in your file manager if needed.
3. On Android, first create or choose the test vault in Obsidian. Close the app
   while using a file manager to copy the same folder into that vault's
   `.obsidian/plugins/`. Confirm the folder was extracted, not left inside a ZIP,
   and that `.obsidian/plugins/vaultbridge/main.js` exists. Android storage
   permissions and file-manager access vary; select a vault location accessible
   to both Obsidian and your file manager.
4. Reopen Obsidian on each device. In Settings → Community plugins, turn
   Restricted mode off for the test vault and enable **VaultBridge**. Disable
   Remotely Save and other sync plugins in that vault.

The manual plugin layout follows the
[official Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/README.md).
You do not upload the plugin to Obsidian or install the upstream community-list
entry. The packaging/build scripts do not install it or open a vault.

For an upgrade, disable VaultBridge and back up its local settings before
replacing plugin files. Preserve your existing `data.json`; the package does not
contain one. Update both devices to the same build and restart Obsidian.

## S3 — start here

In VaultBridge settings select **S3**. Enter these locally on each device:

| Setting | Value |
| --- | --- |
| Endpoint | Your S3-compatible HTTPS endpoint; blank uses AWS for the region |
| Region | The region used by your provider |
| Bucket | Your bucket name |
| Existing remote prefix | A separate prefix for the trial, with its trailing slash |
| Access key ID / Secret access key | Your own storage credentials |
| Path-style S3 URLs | Match the setting required by your existing provider |

Choose **rclone (legacy compatible)** for your existing rclone format. For the
disposable trial, use a new passphrase and the same test prefix/passphrase on
both devices. Do not point the trial at your working prefix. A blank prefix
targets the whole bucket. Encryption is an explicit choice; changing format
or password does not migrate existing objects.

Use **Check connection** first to list the target and read one bounded sample.
Review any custom exclusions; use identical rules on both devices. Then use
**Preview VaultBridge sync**. Enter the passphrase when prompted, inspect merged
results, select the files to include and Apply. Filters hide rows without
unchecking them. Passwords remain in the current plugin session;
restart, Lock encryption or a failed preview requires unlocking again. Storage
credentials are saved locally. Do not share the settings file or password.

## Google Drive — your own app, authorize on Linux

1. Create your own Google Cloud project, enable the Drive API and configure
   OAuth consent for your account. Create a **Desktop app** OAuth client.
   Follow [Google's installed-app instructions](https://developers.google.com/identity/protocols/oauth2/native-app).
2. Create a dedicated ordinary Drive folder. Copy only its folder ID from the
   folder URL into **Dedicated vault folder ID**. Keep Google-native documents
   and shortcuts outside it.
3. Select **Google Drive**. Enter your own client ID and the client secret issued
   for that client. Choose the remote encryption format explicitly.
4. On Linux keep **Registered OAuth redirect URI** as
   `http://127.0.0.1:42813/`. Click **Open authorization** and grant consent in
   the browser. VaultBridge requests the full `drive` scope and offline access;
   the folder setting is not a restriction on the token's account permissions.
5. No local server is started. After the loopback page fails to load, privately
   copy its full URL from the browser address bar into **Full callback URL** and
   click **Finish authorization**. Keep the modal open and complete within
   15 minutes. If the browser loses the callback URL, start a new authorization.
6. On Android enter the same app client ID/secret, folder ID, encryption format
   and passphrase. Privately transfer the Linux-authorized **refresh token**
   into Android's **Refresh token** field; **Access token** can remain blank.
   The token is available locally in Linux's plugin `data.json` under
   `settings.google.refreshToken`. Never upload or send that file here, and
   never copy the whole settings/history file to the second device.

This Android procedure is VaultBridge's current manual setup. It does not
implement Google's native Android login flow. Google's desktop loopback flow
does not support mobile OAuth clients. Testing-mode projects may receive
short-lived refresh tokens under Google's policies; expired/revoked access
requires authorizing your app again. Start each device with Preview.

## Dropbox — your own scoped app

1. Create a scoped app in your [Dropbox App Console](https://www.dropbox.com/developers/apps).
   Choose App Folder for a new dedicated dataset, or Full Dropbox when you need
   access to an existing folder outside your new app's folder.
2. Enable `files.metadata.read`, `files.content.read`, `files.content.write` and
   `account_info.read`. If adding the last scope to an existing app, authorize
   it again so its tokens can identify the account.
   Create the vault folder in the app's accessible root first. An App Folder
   app cannot automatically read files owned by another App Folder app.
3. For Linux, register an exact localhost redirect such as
   `http://localhost:42813/`. Enter that same URI in VaultBridge. Dropbox's
   [official localhost example](https://dropbox.tech/developers/oauth-code-flow-implementation-using-node-js-and-dropbox-javascript-sdk)
   and [OAuth guide](https://docs.dropboxapi.com/dropbox-api/docs/oauth) describe
   redirect registration and PKCE. Use an unused local port; VaultBridge starts
   no server to receive the callback.
4. Select **Dropbox**. **Your OAuth client ID** is your app key. The PKCE flow
   supports leaving **Your OAuth client secret** blank. Enter the vault folder
   path relative to the app/account root, for example `VaultBridge Test`.
   Select encryption explicitly.
5. On Linux use **Open authorization**, grant access, then paste the full failed
   localhost redirect URL into the modal and finish, as with Drive. Tokens are
   requested for offline access.
6. For Android, privately enter the same app key, folder path and encryption
   settings, plus the Linux-authorized refresh token from
   `settings.dropbox.refreshToken`. Leave Access token blank. A separate
   authorization using a registered HTTPS redirect you control is also supported.

Dropbox revision conflicts stop Apply and keep backups. Ambiguous upload
failures are not automatically replayed. If rate limited, wait and preview
again. Listing/downloading failures require a fresh preview; missing app/root
access should be fixed in the provider settings first.

## First sync and conflict checks

1. Populate Linux with disposable notes; start Android empty. Preview/apply on
   Linux, then Android. Inspect the test remote folder and downloaded contents.
2. Preview/apply on both until there are no changes. Each device now has its own
   saved common versions; the first successful sync establishes merge history.
3. Make separate-line edits offline, then sync Linux → Android → Linux.
   Confirm both edits survive and overwrite backups exist locally.
4. Make overlapping edits. Preview defaults to **Preserve both**. Resolve using
   backup copies and an explicit **Use local** or **Use remote** choice. Binary
   conflicts and first-sync differences need manual review.
5. Lock/restart and try a wrong test password: preview should fail before writes.
   Repeat with the correct password. Record Obsidian versions and safe error
   messages without sending credentials, tokens, private notes or settings.

Missing files are restored; deletion/rename propagation is not implemented.
Keep both devices idle during Apply. Remote encryption leaves local notes,
settings, merge history and backups plaintext. Legacy rclone encryption does not
authenticate the whole file/version or remote inventory and cannot prevent
complete-block truncation or valid-ciphertext replay. These limits remain part
of the release candidate; automated tests do not replace the device trial.

Cancel or close a preview dialog to stop. If Apply is already running, the
current native HTTP request or file write can still finish. VaultBridge stays
locked until it settles, retains existing backups, and stops subsequent sync
operations. Cancellation does not undo changes; preview again before continuing.
Unloading stops further sync work and closes encryption workers. A worker that
does not reply within two minutes also stops the operation safely. Native HTTP
requests have their own runtime/SDK behavior; this is not a general network
timeout. Include cancellation and plugin-disable checks in the disposable trial.

If the trial fails, disable VaultBridge, retain the backups, and report the
step, Obsidian versions and safe displayed message. Do not switch a working
vault until the device/provider checks are complete. Detailed implementation
notes remain in `personal/README.md` in the source checkout.
