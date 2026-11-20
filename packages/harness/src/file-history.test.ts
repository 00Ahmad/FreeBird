import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileHistory, isVersionId, MAX_KEPT_PER_BOT } from "./file-history";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mrog-history-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const owner = { botId: "bot_a", threadId: "thr_a", messageId: "msg_a", callId: "c1" };

/** What write_file does: keep a copy, write, then record what was written. */
async function write(history: ReturnType<typeof createFileHistory>, path: string, content: string) {
  const finish = await history.keep(owner, path);
  writeFileSync(path, content);
  return (await finish!(content))!;
}

describe("kept copies of changed files", () => {
  it("puts a changed file back, and removes a file the call created", async () => {
    const history = createFileHistory(join(dir, "history"));
    const notes = join(dir, "notes.txt");
    writeFileSync(notes, "before");
    const changed = await write(history, notes, "after");
    expect(isVersionId(changed.id)).toBe(true);
    expect(await history.undo(changed.id)).toMatchObject({ ok: true, version: { undone: true } });
    expect(readFileSync(notes, "utf8")).toBe("before");
    // Twice is refused.
    expect(await history.undo(changed.id)).toMatchObject({ ok: false, code: "already_undone" });

    const fresh = join(dir, "new.txt");
    const created = await write(history, fresh, "hello");
    expect(created.existed).toBe(false);
    await history.undo(created.id);
    expect(existsSync(fresh)).toBe(false);
  });

  it("won't throw away a later change unless told to", async () => {
    const history = createFileHistory(join(dir, "history"));
    const notes = join(dir, "notes.txt");
    writeFileSync(notes, "v1");
    const version = await write(history, notes, "v2");
    writeFileSync(notes, "v3, edited by hand");
    expect(await history.undo(version.id)).toMatchObject({ ok: false, code: "changed_since" });
    expect(readFileSync(notes, "utf8")).toBe("v3, edited by hand");
    expect(await history.undo(version.id, true)).toMatchObject({ ok: true });
    expect(readFileSync(notes, "utf8")).toBe("v1");
  });

  it("refuses ids it didn't make, and keeps at most a hundred copies per bot", async () => {
    const history = createFileHistory(join(dir, "history"));
    expect(isVersionId("../../etc/passwd")).toBe(false);
    expect(await history.undo("../../x")).toMatchObject({ ok: false, code: "not_found" });
    const file = join(dir, "f.txt");
    writeFileSync(file, "0");
    const first = await write(history, file, "1");
    for (let i = 2; i <= MAX_KEPT_PER_BOT + 1; i++) await write(history, file, String(i));
    expect(await history.get(first.id)).toBeNull();
    await history.forgetBot("bot_a");
    expect(existsSync(join(dir, "history", "bot_a"))).toBe(false);
  });
});

describe("copies left by a write that failed", () => {
  it("are removed once they are an hour old", async () => {
    const { utimesSync } = await import("node:fs");
    const history = createFileHistory(join(dir, "history"));
    const file = join(dir, "f.txt");
    writeFileSync(file, "0");
    // A copy kept, then the write failed: no record follows.
    await history.keep(owner, file);
    const folder = join(dir, "history", "bot_a");
    const { readdirSync } = await import("node:fs");
    const stray = readdirSync(folder).find((name) => name.endsWith(".bak"))!;
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(join(folder, stray), old, old);
    await write(history, file, "1");
    expect(readdirSync(folder)).not.toContain(stray);
  });
});
