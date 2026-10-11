// SPDX-License-Identifier: Apache-2.0
// Browser-safe error container for the Apache S3 adapter. Avoids Node stack APIs.
export default class BrowserAggregateError extends Error {
  constructor(readonly errors: unknown[]) {
    super("Multiple storage errors occurred.");
    this.name = "AggregateError";
  }
}
