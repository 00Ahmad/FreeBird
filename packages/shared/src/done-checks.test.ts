import { describe, expect, it } from "vitest";

import { DONE_FORMS, MAX_DONE_LENGTH, parseDoneCheck, selectorsOf } from "./done-checks";

describe("done checks", () => {
  it("reads each form, with -> or →, any case and extra spaces", () => {
    expect(parseDoneCheck("#list has items")).toEqual({ kind: "has-items", target: "#list" });
    expect(parseDoneCheck('  .status  CONTAINS  "Ready now" ')).toEqual({
      kind: "contains",
      target: ".status",
      text: "Ready now",
    });
    expect(parseDoneCheck("click #refresh → #list changes")).toEqual({
      kind: "click-changes",
      click: "#refresh",
      target: "#list",
    });
    expect(parseDoneCheck('type #task "Buy milk" then click #add -> ul#list contains "Buy milk"')).toEqual({
      kind: "type-click-contains",
      input: "#task",
      typed: "Buy milk",
      click: "#add",
      target: "ul#list",
      text: "Buy milk",
    });
    expect(parseDoneCheck("button[data-page=next] has items")).toEqual({
      kind: "has-items",
      target: "button[data-page=next]",
    });
  });

  it("reads every form the Planner is shown", () => {
    for (const form of DONE_FORMS) expect(parseDoneCheck(form)).not.toHaveProperty("error");
  });

  it("says why a check isn't one of the forms", () => {
    const wrong = parseDoneCheck("the list shows movies");
    expect(wrong).toHaveProperty("error");
    expect((wrong as { error: string }).error).toContain("isn't one of the forms");
    expect((wrong as { error: string }).error).toContain(DONE_FORMS[0]);
    expect(parseDoneCheck("")).toEqual({ error: "the check is empty" });
    expect(parseDoneCheck(`#a contains "${"x".repeat(MAX_DONE_LENGTH)}"`)).toHaveProperty("error");
    expect(parseDoneCheck("#list contains Ready")).toHaveProperty("error");
    expect(parseDoneCheck("click #a #b changes")).toHaveProperty("error");
  });

  it("lists the elements a check needs", () => {
    const check = parseDoneCheck('type #task "x" then click #add -> #list contains "x"');
    expect(selectorsOf(check as Exclude<typeof check, { error: string }>)).toEqual([
      "#task",
      "#add",
      "#list",
    ]);
  });
});
