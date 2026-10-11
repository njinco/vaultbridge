"""Package an existing audited build. No plugin execution, install or network."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import zipfile


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", default="rc.1")
    label = parser.parse_args().label
    if not re.fullmatch(r"rc\.[1-9][0-9]*", label):
        raise RuntimeError("Use a candidate label such as rc.1 or rc.2")
    root = Path(__file__).resolve().parent.parent
    build = root / "dist" / "personal"
    build_files = ("main.js", "manifest.json", "styles.css", "LICENSE", "NOTICE", "build-inputs.json")
    for name in build_files:
        source = build / name
        if not source.is_file() or source.is_symlink():
            raise RuntimeError(f"Missing or unsafe build file: {name}")
    manifest = json.loads((build / "manifest.json").read_text())
    for source in (root / "manifest.json", root / "personal" / "manifest.json"):
        if manifest != json.loads(source.read_text()):
            raise RuntimeError("Build and source manifests differ; rebuild first")
    package = json.loads((root / "package.json").read_text())
    if (manifest["id"] != "vaultbridge" or manifest["isDesktopOnly"] or
            package["name"] != "vaultbridge" or package["version"] != manifest["version"] or
            not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", manifest["version"])):
        raise RuntimeError("Unexpected plugin identity, version or platform metadata")
    for name in ("manifest.json", "styles.css", "LICENSE", "NOTICE"):
        if (build / name).read_bytes() != (root / "personal" / name).read_bytes():
            raise RuntimeError(f"Stale build file: {name}; rebuild first")
    inputs = json.loads((build / "build-inputs.json").read_text())
    if not isinstance(inputs, list) or not inputs or any(
        not isinstance(p, str) or "pro" in p.replace("\\", "/").split("/")
        for p in inputs
    ):
        raise RuntimeError("Invalid build audit or upstream PRO runtime input")

    # Read only package metadata and legal files of audited bundle inputs.
    packages = {}
    for entry in inputs:
        if not entry.startswith("node_modules/"):
            continue
        input_path = root / entry
        if ".." in Path(entry).parts or not input_path.is_file():
            raise RuntimeError("Unexpected dependency input path")
        found = False
        for folder in input_path.parents:
            if folder == root:
                break
            metadata = folder / "package.json"
            if metadata.is_file():
                info = json.loads(metadata.read_text())
                if info.get("name") and info.get("version"):
                    packages[folder] = info
                    found = True
                    break
        if not found:
            raise RuntimeError("Could not identify bundled dependency")
    dependencies = []
    legal_sources = []
    for number, (folder, info) in enumerate(sorted(packages.items())):
        legal = sorted(p for p in folder.iterdir() if p.is_file() and
                       p.name.upper().startswith(("LICENSE", "LICENCE", "NOTICE", "COPYING")))
        if not legal:
            raise RuntimeError(f"Missing legal files for {info['name']}")
        directory = f"third-party/{number:03d}"
        names = []
        for source in legal:
            if source.is_symlink():
                raise RuntimeError("Refusing a symlink in packaged legal files")
            destination = f"{directory}/{source.name}"
            names.append(destination)
            legal_sources.append((source, destination))
        dependencies.append({"name": info["name"], "version": info["version"],
                             "license": info.get("license"), "files": names})

    identity = f"vaultbridge-{manifest['version']}-{label}"
    output = build / f"release-candidate-{manifest['version']}-{label}-{sha256(build / 'main.js')[:12]}"
    output.mkdir(exist_ok=False)
    plugin = output / "vaultbridge"
    plugin.mkdir()
    sources = [(build / name, name) for name in build_files] + legal_sources + [
        (root / "personal" / "LINUX_ANDROID.md", "INSTALL.md"),
        (root / "personal" / "VALIDATION.md", "VALIDATION.md"),
        (root / "personal" / "ROADMAP.md", "ROADMAP.md"),
    ]
    for source, name in sources:
        target = plugin / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        if sha256(source) != sha256(target):
            raise RuntimeError(f"Copy hash mismatch: {name}")
    (plugin / "THIRD_PARTY.json").write_text(json.dumps(dependencies, indent=2) + "\n")
    (plugin / "README.md").write_text(f"""# VaultBridge {manifest['version']} — {label}

Local release candidate for personal use. Plugin manifest version:
`{manifest['version']}`; `{label}` identifies this candidate package.

Copy this entire `vaultbridge` folder into your test vault's configuration
directory under `plugins/`. Read [INSTALL](./INSTALL.md) first. This archive
does not enable the plugin, install dependencies or contain saved credentials.

Offline validation is documented in [VALIDATION](./VALIDATION.md).
Actual Obsidian Linux/Android and live-provider testing are deferred, not verified.
See [ROADMAP](./ROADMAP.md) for the remaining trial.

Reuses credited Apache-licensed Remotely Save components; the build excludes
upstream PRO runtime code. Keep LICENSE, NOTICE and third-party legal files
together with the plugin. THIRD_PARTY.json maps bundled dependency names and
versions to their packaged license/notice files.

SHA256SUMS checks for accidental file changes; it is not a publisher signature.
""")
    (plugin / "release.json").write_text(json.dumps({
        "id": manifest["id"], "version": manifest["version"], "candidate": label,
        "createdUtc": datetime.now(timezone.utc).isoformat(),
        "buildSha256": sha256(build / "main.js"), "auditedInputs": len(inputs),
        "bundledPackagesWithLegalFiles": len(dependencies),
        "realDeviceAndLiveProviderValidation": "deferred, not verified",
        "includesCredentials": False,
    }, indent=2) + "\n")
    files = sorted(p for p in plugin.rglob("*") if p.is_file())
    (plugin / "SHA256SUMS").write_text("".join(
        f"{sha256(path)}  {path.relative_to(plugin).as_posix()}\n" for path in files))
    files = sorted(p for p in plugin.rglob("*") if p.is_file())
    if any(p.name == "data.json" or p.suffix == ".map" or p.is_symlink() for p in files):
        raise RuntimeError("Unexpected settings, source map or symlink in candidate")
    archive = output / f"{identity}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
        for path in files:
            zipped.write(path, path.relative_to(output).as_posix())
    with zipfile.ZipFile(archive) as zipped:
        expected = {p.relative_to(output).as_posix() for p in files}
        if zipped.testzip() is not None or set(zipped.namelist()) != expected:
            raise RuntimeError("Archive corruption or inventory mismatch")
        for path in files:
            if zipped.read(path.relative_to(output).as_posix()) != path.read_bytes():
                raise RuntimeError("Archive content mismatch")
        for line in (plugin / "SHA256SUMS").read_text().splitlines():
            expected_hash, name = line.split("  ", 1)
            if hashlib.sha256(zipped.read(f"vaultbridge/{name}")).hexdigest() != expected_hash:
                raise RuntimeError("Packaged checksum mismatch")
    (output / f"{archive.name}.sha256").write_text(f"{sha256(archive)}  {archive.name}\n")
    print(f"Verified release candidate: {archive}")
    print(f"{len(files)} files; {len(inputs)} audited inputs; {len(dependencies)} bundled package legal sets.")
    print("No Obsidian, cloud access, existing-vault changes or publishing performed.")


if __name__ == "__main__":
    main()
