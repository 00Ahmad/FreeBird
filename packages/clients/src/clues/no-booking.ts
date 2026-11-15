import { fold } from "@mrog/jobs";

import { isHomePage, type SiteClue } from "./types";

const BOOKING =
  /\bbook(ing)?s?\b|\breserv(e|ation)|\bappointments?\b|\bschedule a\b|\bbuy now\b|\bbasket\b|\bcheckout\b|\badd to cart\b|\bshop now\b/;
const MIN_LINKS = 6;

export const noBooking: SiteClue = {
  id: "no_booking",
  label: "No online booking or ordering",
  check: (page) => {
    if (!isHomePage(page.url) || page.links.length < MIN_LINKS) return null;
    const words = fold(`${page.text} ${page.links.map((l) => `${l.text} ${l.url}`).join(" ")}`);
    return BOOKING.test(words) ? null : "No way to book or order online on the home page.";
  },
};
