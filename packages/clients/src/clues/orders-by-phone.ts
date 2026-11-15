import { clip, fold } from "@mrog/jobs";

import type { SiteClue } from "./types";

const BY_PHONE =
  /(call|phone|ring|telephone) (us )?(to|and) (order|book|place an order|make a booking)|email (us )?your (order|booking)|order by (phone|email|telephone)|to order,? (please )?(call|phone|email)/;

export const ordersByPhone: SiteClue = {
  id: "orders_by_phone",
  label: "Orders by phone or email",
  check: (page) => {
    const m = BY_PHONE.exec(fold(page.text));
    return m ? `It takes orders by phone or email: “${clip(m[0], 80)}”.` : null;
  },
};
