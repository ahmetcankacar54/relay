/**
 * The body of the first `@media <query>` block, braces matched; empty when there is none. Comments are
 * ignored when looking (one may name the query, or hold a brace), but the body comes back exactly as
 * written, comments included, so `css.replace(body, "")` still removes it.
 */
export function mediaBlock(css: string, query: string) {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));
  const start = code.indexOf(`@media ${query}`);
  if (start < 0) return "";
  const open = code.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return css.slice(open + 1);
}
