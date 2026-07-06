/**
 * Groomer comment sanitization.
 *
 * GitHub auto-linkifies any `@name` token where `name` matches its username
 * rules ([A-Za-z0-9] with single hyphens, up to 39 chars total) when the `@`
 * appears at start-of-string or after whitespace/common punctuation. If the
 * LLM emits a literal token like `@reviewer` in `githubComment`, GitHub will
 * treat it as a mention of the real account by that name and notify them.
 *
 * `neutralizeMentions` wraps such tokens in backticks so GitHub renders them
 * as inert inline code instead of live mentions. It intentionally leaves:
 *   - email addresses (e.g. `foo@bar.com`) alone, because the `@` is preceded
 *     by an alphanumeric, not the GitHub-linkifiable set;
 *   - tokens already inside backticks / fenced code blocks alone, because
 *     they cannot be linkified there.
 */

// Match `@name` with optional leading delimiter; capture the delimiter so we
// can preserve it. GitHub's own rules: max 39 chars, [A-Za-z0-9] with single
// hyphens not at the edges.
const MENTION_PATTERN = /(^|[\s(,;:\[{<>"'`])@([A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38})/g;

export function neutralizeMentions(text: string): string {
  if (!text) return text;
  return neutralizeOutsideCode(text);
}

/**
 * Walk the string, skipping over inline-code spans (single backticks) and
 * fenced code blocks (``` ... ```) so we never touch text the LLM already
 * marked as code. Apply the mention-wrapping regex to the rest.
 */
function neutralizeOutsideCode(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    // Fenced code block: ``` ... ```
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      const stop = end === -1 ? text.length : end + 3;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    // Inline code: ` ... ` (no newlines allowed inside; GitHub uses first
    // backtick to the next backtick on the same logical line).
    if (text[i] === "`") {
      const newline = text.indexOf("\n", i + 1);
      const searchEnd = newline === -1 ? text.length : newline;
      const end = text.indexOf("`", i + 1);
      const stop = end === -1 || end > searchEnd ? searchEnd : end + 1;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    // Plain run: scan forward to the next backtick.
    const nextTick = text.indexOf("`", i);
    const runEnd = nextTick === -1 ? text.length : nextTick;
    out += wrapMentions(text.slice(i, runEnd));
    i = runEnd;
  }
  return out;
}

function wrapMentions(run: string): string {
  return run.replace(MENTION_PATTERN, (_match, delimiter: string, name: string) => {
    return `${delimiter}\`@${name}\``;
  });
}