import { describe, expect, it } from "vitest";

import { cellNumber, fileName, toCsv } from "./export";

describe("exports", () => {
  it("writes CSV that spreadsheets read", () => {
    expect(
      toCsv([
        ["Phone", "Price"],
        ['Vivo "Y19s", 8GB', "Rs. 32,682"],
      ]),
    ).toBe('\uFEFFPhone,Price\r\n"Vivo ""Y19s"", 8GB","Rs. 32,682"');
  });

  it("reads numbers out of cells for sorting", () => {
    expect(cellNumber("Rs. 32,682")).toBe(32682);
    expect(cellNumber("5,500 mAh")).toBe(5500);
    expect(cellNumber("-15%")).toBe(-15);
    expect(cellNumber("n/a")).toBeNull();
  });

  it("keeps cells from running as spreadsheet formulas, and leaves numbers alone", () => {
    expect(toCsv([["=HYPERLINK(1)", "@cmd", "-15%", "+3"]], { bom: false })).toBe(
      "'=HYPERLINK(1),'@cmd,-15%,+3",
    );
  });

  it("doesn't read dates or model names as numbers", () => {
    expect(cellNumber("2024-01-05")).toBeNull();
    expect(cellNumber("8GB/128GB")).toBeNull();
    expect(cellNumber("$1,200.50")).toBe(1200.5);
  });

  it("makes safe file names", () => {
    expect(fileName("Best phones: Daraz vs GSMArena?", "md")).toBe("Best-phones-Daraz-vs-GSMArena.md");
    expect(fileName("***", "csv")).toBe("export.csv");
  });
});
