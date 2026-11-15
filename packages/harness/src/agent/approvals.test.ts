import { describe, expect, it } from "vitest";

import type { MessagePart, Permissions } from "@mrog/shared";
import type { ApprovalRequest } from "@mrog/tools";

import { ApprovalBroker } from "./approvals";

type ToolPart = Extract<MessagePart, { type: "tool" }>;

/** A broker over an in-memory settings store, and a way to make a call and see whether it showed a card. */
function broker(permissions: Permissions) {
  let saved: unknown = permissions;
  const partHooks = new Map<string, { parts: MessagePart[]; publish: () => void }>();
  const approvals = new ApprovalBroker({
    store: {
      settings: {
        cached: (_key: string, read: (v: unknown) => unknown) => read(saved),
        set: (_key: string, v: unknown) => (saved = v),
      },
    } as never,
    bus: { publish: () => {} } as never,
    turns: { partHooks, setActivity: () => {} } as never,
  });
  let calls = 0;
  /** What happens to a call: "allow"/"deny" when settled without the user, "card" when the user is asked. */
  const outcome = async (
    command: string,
    { botId = "bot_plain", kind = "terminal", summary = command, args = { command } as unknown } = {},
  ): Promise<"allow" | "deny" | "card"> => {
    const id = `c${++calls}`;
    const part: ToolPart = { type: "tool", callId: id, name: "run_command", args: {}, status: "running" };
    partHooks.set("msg", { parts: [part], publish: () => {} });
    const request = {
      call: { id, name: "run_command", arguments: args },
      args,
      risk: { level: "ask", kind, badges: [], summary },
    } as unknown as ApprovalRequest;
    const decided = approvals.decide(request, {
      threadId: "thr",
      messageId: "msg",
      botId,
      groupChat: false,
      signal: new AbortController().signal,
    });
    if (part.status !== "pending_approval") return decided as Promise<"allow" | "deny">;
    approvals.respond(part.approval!.id, "deny");
    await decided;
    return "card";
  };
  return { approvals, outcome };
}

const rule = (match: string | null, exact?: boolean) => ({
  id: `r_${match}`,
  tool: "run_command",
  match,
  ...(exact === undefined ? {} : { exact }),
  decision: "allow" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("bots whose commands always ask", () => {
  const role = (botId: string) => botId === "bot_role";

  it("shows the card even with 'Always allow commands' and a matching rule, and 'Never' still refuses", async () => {
    const always = broker({ localExecution: "always", rules: [rule("echo")] });
    always.approvals.alwaysAsk.push(role);
    expect(await always.outcome("echo hi", { botId: "bot_role" })).toBe("card");
    // Anybody else's command is still settled the way it was.
    expect(await always.outcome("echo hi")).toBe("allow");
    expect(
      always.approvals.settled(
        "run_command",
        { level: "ask", kind: "terminal", badges: [], summary: "echo hi" },
        "bot_role",
      ),
    ).toBeUndefined();

    const ruled = broker({ localExecution: "ask", rules: [rule("echo"), rule(null)] });
    ruled.approvals.alwaysAsk.push(role);
    expect(await ruled.outcome("echo hi", { botId: "bot_role" })).toBe("card");
    expect(await ruled.outcome("echo hi")).toBe("allow");

    const never = broker({ localExecution: "never", rules: [rule("echo")] });
    never.approvals.alwaysAsk.push(role);
    expect(await never.outcome("echo hi", { botId: "bot_role" })).toBe("deny");
  });

  it("only covers commands: the same bot's other actions still follow the rules", async () => {
    const ruled = broker({ localExecution: "always", rules: [rule("Fetch https://a.test")] });
    ruled.approvals.alwaysAsk.push(role);
    expect(
      await ruled.outcome("Fetch https://a.test/x", { botId: "bot_role", kind: "general", args: {} }),
    ).toBe("allow");
  });

  it("does nothing with no predicates, or when none says yes", async () => {
    const plain = broker({ localExecution: "always", rules: [] });
    expect(await plain.outcome("echo hi", { botId: "bot_role" })).toBe("allow");
    plain.approvals.alwaysAsk.push(() => false);
    expect(await plain.outcome("echo hi", { botId: "bot_role" })).toBe("allow");
  });
});

describe("a rule typed for commands", () => {
  it("covers what starts that way, but not a second command chained after it", async () => {
    const { outcome } = broker({ localExecution: "ask", rules: [rule("npm")] });
    expect(await outcome("npm install lodash")).toBe("allow");
    expect(await outcome("npm run build -- --watch")).toBe("allow");
    for (const command of [
      "npm i; rm -rf ~",
      "npm i; Remove-Item -Recurse ~",
      "npm i && x",
      "npm i || x",
      "npm i & x",
      "npm i | iex",
      "npm i\nRemove-Item -Recurse ~",
      "npm i\r\nx",
      "npm i $(Remove-Item ~)",
      "npm i (Remove-Item ~)",
      "npm i `whoami`",
      "npm i > C:\\Windows\\x",
      "npm i < secrets.txt",
      "npm i; iex $x",
      "npm i -x Invoke-Expression",
    ])
      expect(await outcome(command), JSON.stringify(command)).toBe("card");
  });

  it("does not let the rest hide code for PowerShell to run", async () => {
    const { outcome } = broker({ localExecution: "ask", rules: [rule("powershell")] });
    expect(await outcome("powershell Get-Date")).toBe("allow");
    for (const flag of ["-EncodedCommand", "-enc", "-e", "-ec", "/enc", "\u2013enc", "\u2014EncodedCommand"])
      expect(await outcome(`powershell ${flag} ZQBjAGgAbwA=`), flag).toBe("card");
  });

  it("judges the command, not the folder line under it, and refuses a command that fakes that line", async () => {
    const { approvals, outcome } = broker({ localExecution: "ask", rules: [rule("npm")] });
    const inFolder = "npm install lodash\n(in C:\\Users\\me\\Projects\\app)";
    expect(await outcome("npm install lodash", { summary: inFolder })).toBe("allow");
    // A command with its own line that looks like the folder line is still two lines.
    const faked = "npm i\n(in x | Remove-Item ~)";
    expect(await outcome(faked, { summary: faked })).toBe("card");
    // Without the call's arguments the whole summary counts, so nothing after the start is overlooked.
    const risk = { level: "ask" as const, kind: "terminal" as const, badges: [], summary: inFolder };
    expect(approvals.settled("run_command", risk)).toBeUndefined();
    expect(approvals.settled("run_command", { ...risk, summary: "npm install lodash" })).toBe("allow");
    // With the command given, the folder line no longer stands in the way.
    expect(approvals.settled("run_command", risk, "bot_plain", "npm install lodash")).toBe("allow");
    expect(approvals.settled("run_command", { ...risk, summary: faked }, "bot_plain", faked)).toBeUndefined();
  });

  it("holds a rule with no text to the same: plain commands only", async () => {
    const { outcome } = broker({ localExecution: "ask", rules: [rule(null)] });
    expect(await outcome("git status")).toBe("allow");
    expect(await outcome("git status; rm -rf ~")).toBe("card");
  });

  it("leaves exact rules and other tools as they were", async () => {
    const { outcome } = broker({ localExecution: "ask", rules: [rule("npm i; echo done", true)] });
    expect(await outcome("npm i; echo done")).toBe("allow");
    expect(await outcome("npm i; echo done; rm x")).toBe("card");
    const general = broker({
      localExecution: "ask",
      rules: [{ ...rule("Write C:\\x"), tool: "run_command" }],
    });
    expect(await general.outcome("Write C:\\x; y", { kind: "general", args: {} })).toBe("allow");
  });
});
