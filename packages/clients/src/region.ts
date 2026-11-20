import { fold } from "@mrog/jobs";

/** Whether the places you serve are in the UK (the registers built so far are UK ones). */

const UK =
  /\b(uk|u\.k\.|united kingdom|great britain|britain|england|scotland|wales|northern ireland|london|manchester|birmingham|leeds|liverpool|sheffield|bristol|newcastle|nottingham|leicester|glasgow|edinburgh|cardiff|belfast|southampton|portsmouth|brighton|oxford|cambridge|york|bradford|hull|coventry|reading|milton keynes|aberdeen|dundee|swansea|derby|plymouth|norwich|exeter|bath|yorkshire|lancashire|kent|surrey|essex|sussex|devon|cornwall|cheshire|midlands|north east|north west|south east|south west|east anglia)\b/;

/** Words that only say how you work, not where. */
const NOT_A_PLACE = /^(remote|remotely|anywhere|online|worldwide|global|nationwide|uk ?wide|uk-wide)$/;
const COUNTRY = /^(uk|u\.k\.|united kingdom|great britain|britain|england|scotland|wales|northern ireland)$/;

export const isUkArea = (areas: readonly string[]) => areas.some((area) => UK.test(fold(area)));

/** Whether one word is a UK place's name on its own ("leeds", "yorkshire"). */
export function isPlaceWord(word: string): boolean {
  const folded = fold(word);
  return UK.exec(folded)?.[0] === folded;
}

/**
 * The towns and regions in your areas, each part on its own and without a country ("Leeds, UK" → "Leeds";
 * "Leeds, West Yorkshire" → "Leeds", "West Yorkshire"); "remote" and whole countries are not places.
 */
export function placesIn(areas: readonly string[]): string[] {
  return areas.flatMap((area) =>
    area
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part && !NOT_A_PLACE.test(fold(part)) && !COUNTRY.test(fold(part))),
  );
}

/** The place to search near: the first town or region you serve, or "". */
export const placeOf = (areas: readonly string[]): string => placesIn(areas)[0] ?? "";

/** Whether you serve clients anywhere (remote work): place doesn't limit the fit. */
export const servesAnywhere = (areas: readonly string[]) =>
  areas.some((area) => NOT_A_PLACE.test(fold(area)));
