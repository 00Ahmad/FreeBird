import { isHomePage, type SiteClue } from "./types";

const BLOG = /\/(blog|news|insights|articles|journal|updates|stories|resources)(\/|$)|^(blog|news)\./i;
const BLOG_WORDS = /^(blog|news|insights|articles|journal|latest news|our blog|stories)$/i;
/** Fewer links than this: the page didn't really load, so nothing is concluded from what it lacks. */
const MIN_LINKS = 6;

export const noBlog: SiteClue = {
  id: "no_blog",
  label: "No blog or news",
  check: (page) => {
    if (!isHomePage(page.url) || page.links.length < MIN_LINKS) return null;
    const has = page.links.some((link) => {
      try {
        const url = new URL(link.url);
        return BLOG.test(url.pathname) || BLOG.test(url.hostname) || BLOG_WORDS.test(link.text.trim());
      } catch {
        return false;
      }
    });
    return has ? null : "The home page links to no blog or news section.";
  },
};
