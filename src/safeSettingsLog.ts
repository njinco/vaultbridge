// Settings strings can contain credentials, signed URLs, headers, and passwords.
// Redact every string rather than maintaining an incomplete secret-name list.
export const redactSettingsForLog = (value: unknown): unknown => {
  if (typeof value === "string") return "[REDACTED]";
  if (Array.isArray(value)) return value.map(redactSettingsForLog);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactSettingsForLog(item),
      ])
    );
  }
  return value;
};
