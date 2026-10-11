import { strict as assert } from "assert";
import { validateImportedSettings } from "../src/settingsImportValidation";
import { redactSettingsForLog } from "../src/safeSettingsLog";

describe("Settings import trust boundary", () => {
  it("accepts basic exports and complete service settings", () => {
    const settings = {
      serviceType: "s3",
      password: "private",
      concurrency: 5,
      autoRunEveryMilliseconds: -1,
      protectModifyPercentage: 50,
      ignorePaths: ["private/"],
      profiler: { enable: false },
      s3: {
        s3Endpoint: "https://example.com",
        s3Region: "us-east-1",
        s3AccessKeyID: "key",
        s3SecretAccessKey: "secret",
        s3BucketName: "notes",
      },
    };
    assert.deepEqual(validateImportedSettings(settings), settings);
  });

  it("rejects primitives, arrays, null, and empty imports", () => {
    for (const value of [null, [], "settings", 42, true, {}]) {
      assert.throws(() => validateImportedSettings(value));
    }
  });

  it("rejects unknown keys and prototype pollution at both levels", () => {
    for (const text of [
      '{"__proto__":{"polluted":true}}',
      '{"constructor":{"prototype":{"polluted":true}}}',
      '{"webdis":{"address":"https://example.com","__proto__":{}}}',
      '{"password":"private","unexpected":true}',
    ]) {
      assert.throws(() => validateImportedSettings(JSON.parse(text)));
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it("rejects account entitlements and vault identity", () => {
    assert.throws(() =>
      validateImportedSettings({ pro: { enabledProFeatures: [] } })
    );
    assert.throws(() =>
      validateImportedSettings({ vaultRandomID: "another-vault" })
    );
  });

  it("rejects wrong types, invalid enums, invalid ranges, and incomplete services", () => {
    for (const value of [
      { syncConfigDir: "true" },
      { serviceType: "unknown" },
      { conflictAction: "overwrite_everything" },
      { concurrency: 0 },
      { concurrency: 1.5 },
      { autoRunEveryMilliseconds: -2 },
      { protectModifyPercentage: 101 },
      { skipSizeLargerThan: Infinity },
      { ignorePaths: [123] },
      { webdav: { address: "https://example.com" } },
      { profiler: { enable: "true" } },
    ])
      assert.throws(() => validateImportedSettings(value));
  });

  it("does not include credentials in validation errors", () => {
    assert.throws(
      () =>
        validateImportedSettings({ password: "secret-marker", unknown: true }),
      (error: Error) => !error.message.includes("secret-marker")
    );
  });
});

describe("Settings diagnostics", () => {
  it("redacts credentials and signed URLs recursively without mutating settings", () => {
    const value = {
      password: "secret-marker",
      webdav: { customHeaders: "Bearer secret-marker" },
      azureblobstorage: {
        containerSasUrl: "https://example.com?sig=secret-marker",
      },
      ignorePaths: ["secret-marker"],
      concurrency: 5,
      syncConfigDir: false,
    };
    const redacted = redactSettingsForLog(value) as Record<string, unknown>;
    assert.equal(JSON.stringify(redacted).includes("secret-marker"), false);
    assert.equal(redacted.concurrency, 5);
    assert.equal(redacted.syncConfigDir, false);
    assert.equal(value.password, "secret-marker");
  });
});
