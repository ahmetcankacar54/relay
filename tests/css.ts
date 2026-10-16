/** The body of the first `@media <query>` block, braces matched; empty when there is none. */
export function mediaBlock(css: string, query: string) {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return css.slice(open + 1);
}
