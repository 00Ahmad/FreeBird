import { describe, expect, it } from "vitest";

import { imageHost, isAppOwnImage } from "./images";

describe("images in chat text", () => {
  it("shows the app's own inline images without asking", () => {
    expect(isAppOwnImage("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isAppOwnImage("DATA:image/svg+xml;utf8,<svg/>")).toBe(true);
    expect(isAppOwnImage("blob:http://127.0.0.1:5173/3f2c")).toBe(true);
  });

  it("asks before loading anything from the network", () => {
    expect(isAppOwnImage("https://evil.example/p?d=secret")).toBe(false);
    expect(isAppOwnImage("http://192.168.1.5/x.png")).toBe(false);
    expect(isAppOwnImage("//evil.example/x.png")).toBe(false);
    expect(isAppOwnImage("/relative.png")).toBe(false);
    expect(isAppOwnImage("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isAppOwnImage("")).toBe(false);
    expect(isAppOwnImage(undefined)).toBe(false);
  });

  it("names the site an image would come from", () => {
    expect(imageHost("https://evil.example/p?d=secret")).toBe("evil.example");
    expect(imageHost("http://192.168.1.5:8080/x.png")).toBe("192.168.1.5:8080");
    expect(imageHost("/relative.png")).toBeNull();
    expect(imageHost(undefined)).toBeNull();
  });
});
