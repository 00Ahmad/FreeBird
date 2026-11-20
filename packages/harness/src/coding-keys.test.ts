import { describe, expect, it } from "vitest";

import { fillKeys, findKeys, hideKeys, placeholder } from "./coding-keys";

// Made-up keys, shaped like the real kinds.
const TMDB = "3f9a8c7d6e5b4a3f2e1d0c9b8a7f6e5d";
const TOKEN =
  "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIzZjlhOGM3ZCIsInN1YiI6IjEyMyJ9.k3yS1gNaTuReP4rtGoesHere0123456789";
const OPENAI = "sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12";

const BRIEF = `Build a movie site with TMDB.
TMDB API Key: ${TMDB}
API Read Access Token: ${TOKEN}
Use the endpoint https://api.themoviedb.org/3/movie/popular and show 20 movies.`;

describe("keys in the brief", () => {
  it("finds the keys the brief gives, named after the words before them", () => {
    expect(findKeys(BRIEF)).toEqual([
      { name: "TMDB_API_KEY", value: TMDB },
      { name: "API_READ_ACCESS_TOKEN", value: TOKEN },
    ]);
    expect(findKeys(`and my openai key is ${OPENAI}`)).toEqual([{ name: "OPENAI_KEY", value: OPENAI }]);
  });

  it("finds them laid out as briefs lay them out: after the label, on the next line, or in an example address", () => {
    // As the movies brief had them: the label and the key on one line, with blank lines around.
    expect(
      findKeys(`working TMDB API.\n\nthe API key ${TMDB}\n\nthe API read access token ${TOKEN}\n`).map(
        (key) => key.name,
      ),
    ).toEqual(["API_KEY", "API_READ_ACCESS_TOKEN"]);
    expect(findKeys(`TMDB API Key:\n${TMDB}\n`)).toEqual([{ name: "TMDB_API_KEY", value: TMDB }]);
    expect(findKeys(`Call https://api.themoviedb.org/3/movie/popular?api_key=${TMDB}&page=1`)).toEqual([
      { name: "API_KEY", value: TMDB },
    ]);
  });

  it("leaves addresses, words, ids and numbers alone", () => {
    expect(findKeys("https://example.com/some-long-path-with-words/abc123def456ghi789")).toEqual([]);
    expect(findKeys("The movie_details_component_container shows 2024 posters.")).toEqual([]);
    expect(findKeys("Show order number 12345678901234567890 at the top.")).toEqual([]);
    expect(findKeys("Use the class name abc123def456ghi789jkl for the grid.")).toEqual([]);
  });

  it("names a second key with the same words apart, and skips keys already known", () => {
    const keys = findKeys(`token: ${TMDB}\ntoken: ${TMDB.replace("3f", "4f")}`);
    expect(keys.map((key) => key.name)).toEqual(["TOKEN", "TOKEN_2"]);
    expect(findKeys(`token: ${TMDB}`, keys)).toEqual([]);
  });

  it("hides keys behind their names, and fills the names back in", () => {
    const keys = findKeys(BRIEF);
    const hidden = hideKeys(BRIEF, keys);
    expect(hidden).not.toContain(TMDB);
    expect(hidden).not.toContain(TOKEN);
    expect(hidden).toContain(`TMDB API Key: ${placeholder("TMDB_API_KEY")}`);
    expect(fillKeys(hidden, keys)).toBe(BRIEF);
    expect(fillKeys('const KEY = "{{TMDB_API_KEY}}"; const X = "{{OTHER}}";', keys)).toBe(
      `const KEY = "${TMDB}"; const X = "{{OTHER}}";`,
    );
  });
});
