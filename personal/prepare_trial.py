"""Package disposable Linux/Android vaults; never launch or execute the plugin."""

import hashlib
import json
from pathlib import Path
import shutil
import uuid
import zipfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    build = Path(__file__).resolve().parent.parent / "dist" / "personal"
    files = ("main.js", "manifest.json", "styles.css", "LICENSE", "NOTICE", "build-inputs.json")
    for name in files:
        if not (build / name).is_file() or (build / name).is_symlink():
            raise RuntimeError(f"Missing or unsafe build file: {name}")
    manifest = json.loads((build / "manifest.json").read_text())
    if manifest["id"] != "vaultbridge" or manifest["isDesktopOnly"]:
        raise RuntimeError("Expected the mobile-compatible VaultBridge build")
    inputs = json.loads((build / "build-inputs.json").read_text())
    if not isinstance(inputs, list) or any(
        not isinstance(p, str) or "pro" in p.replace("\\", "/").split("/")
        for p in inputs
    ):
        raise RuntimeError("Invalid audit or PRO runtime input")

    trial_id = uuid.uuid4().hex[:12]
    prefix = f"vaultbridge-validation-{trial_id}/"
    output = build / f"trial-kit-{trial_id}"
    output.mkdir(exist_ok=False)
    fixture = {
        "note.md": b"one\ntwo\nthree\nfour\n",
        "日本語/メモ.md": "# Unicode check\n日本語のテスト。\n".encode(),
        "empty-file.txt": b"",
        "attachments/sample.bin": bytes(range(256)) * 256 + b"\x7f",
    }
    for platform in ("Linux", "Android"):
        vault = output / f"VaultBridge Test {platform}"
        plugin = vault / ".obsidian" / "plugins" / "vaultbridge"
        plugin.mkdir(parents=True)
        for name in files:
            shutil.copyfile(build / name, plugin / name)
            if digest(build / name) != digest(plugin / name):
                raise RuntimeError("Plugin copy hash mismatch")
        (vault / ".obsidian" / "community-plugins.json").write_text("[]\n")
        if platform == "Linux":
            for name, content in fixture.items():
                target = vault / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
        archive = output / f"{vault.name}.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
            for path in sorted(vault.rglob("*")):
                if path.is_file():
                    zipped.write(path, path.relative_to(output).as_posix())
        with zipfile.ZipFile(archive) as zipped:
            if zipped.testzip() is not None:
                raise RuntimeError("Corrupt archive")
            root = vault.name + "/"
            expected = {root + p.relative_to(vault).as_posix() for p in vault.rglob("*") if p.is_file()}
            if set(zipped.namelist()) != expected:
                raise RuntimeError("Archive inventory mismatch")
            if json.loads(zipped.read(root + ".obsidian/community-plugins.json")) != []:
                raise RuntimeError("Plugin must remain disabled")
            if any(p.endswith("/data.json") for p in zipped.namelist()):
                raise RuntimeError("Trial must contain no saved credentials")
            for path in vault.rglob("*"):
                if path.is_file() and zipped.read(root + path.relative_to(vault).as_posix()) != path.read_bytes():
                    raise RuntimeError("Archive content mismatch")

    (output / "fixture-hashes.json").write_text(json.dumps(
        {name: {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
         for name, content in fixture.items()}, indent=2, ensure_ascii=False) + "\n")
    (output / "TRIAL.md").write_text(f"""# VaultBridge Linux + Android trial

Real-device results: **not run**. These archives contain the same build,
with VaultBridge disabled and no saved credentials. Linux has four test files;
Android starts empty. The binary attachment is 65,537 bytes.

## Install and connect the disposable vaults

1. On Linux, extract `VaultBridge Test Linux.zip` to a new location. In
   Obsidian's vault switcher, open the extracted `VaultBridge Test Linux`
   folder as a vault. Enable viewing hidden files if needed to confirm that
   `.obsidian/plugins/vaultbridge` was extracted. Do not copy into your working vault.
2. In this test vault only, turn Restricted mode off under Settings → Community
   plugins, then enable VaultBridge. Keep other sync plugins disabled.
3. Configure S3 locally: your endpoint, region, bucket, keys and path-style option.
   Use this exact **new test prefix on BOTH devices**: `{prefix}`
   Choose **rclone (legacy compatible)**. Use a new test passphrase, entered at
   preview. Do not use your existing working prefix or send credentials here.
4. Preview on Linux. Expect four uploads and no conflicts. Apply. Inspect only
   the test prefix in your S3 provider: names and contents should be encrypted.
5. Transfer `VaultBridge Test Android.zip` to Android and extract it to a folder
   Obsidian can access. Ensure the extractor retains the hidden `.obsidian`
   folder. Open the extracted vault in Obsidian; repeat steps 2–3 locally.
   Android must start with no visible notes. Preview should show four downloads.
   Apply and verify the four files, including Unicode, the empty file and binary.
   Compare hashes using `fixture-hashes.json` if a local hashing tool is available.
6. Preview/apply on each device until the plan has no changes. This establishes
   the saved common versions needed for the merge tests.

## Merge, conflict and password checks

1. With neither device syncing, edit line 1 of `note.md` to `ONE` on Linux and
   line 4 to `FOUR` on Android. Sync Linux, Android, then Linux. Both should show
   `ONE`, `two`, `three`, `FOUR`. Check `_personal_sync_backups` on the device
   that merged for the original local and remote versions.
2. Establish a common version again. Change line 2 differently on both devices.
   Sync Linux, then preview on Android. Expect a conflict with **Preserve both**
   selected. Apply: originals remain unchanged and both versions are backed up.
   Preview again to test an explicit **Use local** or **Use remote** resolution.
3. Lock encryption, enter a wrong test passphrase and preview. Expect failure
   without any writes. Retry with the correct passphrase. Inspect this vault's
   `.obsidian/plugins/vaultbridge/data.json` locally: `password` should be empty.
   Other saved fields contain sensitive storage credentials; do not share the file.
4. Restart Obsidian on each device and repeat a preview to verify password
   prompting and worker compatibility on the actual Linux/Android runtimes.

Keep both devices idle during Apply. Missing files are restored; deletion and
rename propagation are not implemented. The legacy rclone format has per-block
authentication, with no protection against complete-block truncation or replay.
This trial does not establish protection against those known format limitations.

Report only: Obsidian versions, which numbered step failed, the safe displayed
message, and expected versus actual behavior. Do not send credentials, passwords,
settings files, cloud URLs containing tokens, or personal notes.

After the trial, disable VaultBridge in these vaults. Delete only this exact test
S3 prefix and these disposable vault folders when you no longer need the results.

Official installation references:
- https://obsidian.md/help/manage-vaults
- https://obsidian.md/help/plugin-security
- https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/README.md
""")
    (output / "RESULTS.md").write_text("""# Real-device trial results

Status: NOT RUN — packaging checks passed; no real vault or cloud was accessed.

- Linux Obsidian version:
- Android Obsidian version:
- Linux upload / encrypted S3 inspection:
- Android download / fixture comparison:
- Separate-line merge / backups:
- Same-line conflict / explicit resolution:
- Wrong password / no writes:
- Restart / password prompt on both devices:
- Safe error message or observations:
""")
    inventory = [p for p in sorted(output.rglob("*")) if p.is_file()]
    (output / "SHA256SUMS").write_text("".join(
        f"{digest(path)}  {path.relative_to(output).as_posix()}\n" for path in inventory))
    print(f"Verified disabled trial vaults and archives: {output}")
    print(f"Disposable S3 prefix: {prefix}")
    print(f"Plugin SHA-256: {digest(build / 'main.js')}")
    print("No plugin execution, cloud access, or existing-vault access performed.")


if __name__ == "__main__":
    main()
