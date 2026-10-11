# Retained upstream references

These files describe the original Remotely Save project. They are historical
references and are not VaultBridge installation, build or release instructions.
Follow the [VaultBridge setup guide](../personal/README.md) instead.

- [Original English documentation](./README.md) and
  [Chinese documentation](./README.zh-cn.md). Relative document links were
  adjusted for this folder; upstream service/release links are historical.
- Original `manifest.json`, `manifest-beta.json`, `versions.json` and
  `styles.css`, preserved separately from the active VaultBridge metadata.
- Original `esbuild.config.mjs` and `webpack.config.js`, retained for reference.
  They are not supported build entry points at this location and must not be
  used to create VaultBridge artifacts.
- Original `CONTRIBUTING.md` and `CLA.md`, describing upstream policies.
- Original `workflows/auto-build.yml`, `release.yml` and `cla.yml`. These are
  outside `.github/workflows` and are inactive. They retain upstream secret,
  publishing, Git LFS and CLA settings for reference only.

Original implementation source remains in `src/` and `pro/`, and original
technical documentation remains in `docs/`, with their existing license files.
The VaultBridge build reuses selected Apache-licensed components and rejects
`pro/` runtime imports. Attribution and storage-format identifiers are preserved;
archiving documentation does not change licenses or Git history.
