import type { LeadWarningRule } from "./types";

export const noContact: LeadWarningRule = {
  id: "no-contact",
  check: ({ contacts }) =>
    contacts.length === 0
      ? "No contact page, business inbox or phone line was found."
      : contacts.every((c) => c.kind === "contact_page")
        ? "Only a contact form was found."
        : null,
};
