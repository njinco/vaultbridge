import { strict as assert } from "node:assert";
import { compareMarkdown } from "../personal/review";
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
describe("Markdown conflict comparison", () => {
  it("labels local and remote edits while retaining matching lines and line endings", () => {
    assert.deepEqual(
      compareMarkdown(
        "note.md",
        bytes("same\r\nlocal"),
        bytes("same\r\nremote")
      ),
      [
        { kind: "same", text: "same\r\n" },
        { kind: "local", text: "local" },
        { kind: "remote", text: "remote" },
      ]
    );
  });
  it("compares empty versions and distinguishes final newline changes", () => {
    assert.deepEqual(compareMarkdown("note.md", bytes(""), bytes("note\n")), [
      { kind: "remote", text: "note\n" },
    ]);
    assert.deepEqual(
      compareMarkdown("note.md", bytes("note"), bytes("note\n")),
      [
        { kind: "local", text: "note" },
        { kind: "remote", text: "note\n" },
      ]
    );
  });
  it("declines binary, invalid UTF-8, oversized and excessive-line comparisons", () => {
    const a = bytes("a");
    assert.equal(compareMarkdown("image.png", a, a), undefined);
    assert.equal(
      compareMarkdown("note.md", new Uint8Array([255]).buffer, a),
      undefined
    );
    assert.equal(
      compareMarkdown("note.md", bytes("x".repeat(128 * 1024)), a),
      undefined
    );
    assert.equal(
      compareMarkdown("note.md", bytes("x\n".repeat(2001)), a),
      undefined
    );
  });
});
