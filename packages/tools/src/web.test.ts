import { describe, expect, it, vi } from "vitest";

// A name on the local network that doesn't look like one: only a lookup tells.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host === "files.example.com") return [{ address: "192.168.1.20", family: 4 }];
    if (host === "public.example.com") return [{ address: "93.184.216.34", family: 4 }];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  },
}));

const { addressRisk, mayReachLocal } = await import("./web");

describe("addresses on the local network", () => {
  it("asks for a name that turns out to be local, and lets that call go there", async () => {
    const args = { url: "http://files.example.com/share" };
    expect(await addressRisk(args, args.url, `Fetch ${args.url}`)).toMatchObject({
      level: "ask",
      badges: ["Reaches your local network"],
    });
    expect(mayReachLocal(args, args.url)).toBe(true);
    // Another call to the same name wasn't judged, so it gets no pass.
    expect(mayReachLocal({ url: args.url }, args.url)).toBe(false);
  });

  it("lets public addresses through without asking, and not to the local network", async () => {
    const args = { url: "https://public.example.com/" };
    expect(await addressRisk(args, args.url, "Fetch")).toMatchObject({ level: "safe" });
    expect(mayReachLocal(args, args.url)).toBe(false);
    // Written as a local address, it always asked first.
    expect(mayReachLocal({}, "http://192.168.1.1/")).toBe(true);
    expect(await addressRisk({}, "file:///etc/passwd", "Open")).toMatchObject({ level: "safe" });
  });
});
