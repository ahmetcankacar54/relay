import type { CarriedConversation } from "./desktop-files";

/** Every draft Claude keeps in Local Storage has a key that starts with this. */
export const DRAFT_KEY_PREFIX = "composer-draft:";
/** Claude's Local Storage key for the unsent draft of a Code conversation, followed by its alias. */
export const CONVERSATION_DRAFT_PREFIX = DRAFT_KEY_PREFIX + "epitaxy-local_";
/** Claude's Local Storage key for the draft of a session that does not exist yet. */
export const NEW_SESSION_DRAFT = DRAFT_KEY_PREFIX + "epitaxy-draft";

/** An unsent draft of account A that is worth re-typing once Claude runs as account B. */
export interface CapturedDraft {
  /** The alias of B's session the draft belongs to. Absent for the new-session draft. */
  targetAlias?: string;
  /** Set on the draft of a session that does not exist yet. */
  newSession?: true;
  /** B's title for the conversation, or "" when there is none. */
  title: string;
  text: string;
  /** The draft also holds files or snippets, which cannot be re-typed. */
  attachments: boolean;
}

type Draft = Record<string, unknown> & { owner: string };

function parseDraft(raw: string): Draft | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { owner?: unknown }).owner === "string"
    )
      return value as Draft;
  } catch {
    // Not JSON: nothing to keep.
  }
  return null;
}

/** The draft's text, or "" when it has none worth keeping. */
function textOf(draft: Draft): string {
  return typeof draft.text === "string" && draft.text.trim() !== ""
    ? draft.text
    : "";
}

const attached = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0;

/**
 * Picks the unsent drafts of account `from` that are worth re-typing after a switch away from it.
 * Nothing is written or removed: this only reads.
 *
 * A conversation's drafts are looked for at its target alias and at every member alias. Of
 * `from`'s drafts there, the one at the target alias is kept, otherwise the lexically first.
 * Drafts of other accounts are never kept, and a draft is kept for one conversation only. A
 * conversation whose target key holds a value that is not a draft is skipped altogether. Drafts
 * without text are not kept, and neither are values that are not a JSON object with a string
 * `owner`. The draft of a session that does not exist yet comes last.
 *
 * `drafts` holds every `composer-draft:` key with its raw string value. `titles` maps a
 * conversation's target alias to the title the account switched to gives it.
 */
export function selectDrafts(input: {
  drafts: Record<string, string>;
  from: string;
  conversations: CarriedConversation[];
  titles: Record<string, string>;
}): CapturedDraft[] {
  const { drafts, conversations, titles } = input;
  // Account UUIDs compare without case.
  const fromKey = input.from.toLowerCase();
  const isFrom = (draft: Draft) => draft.owner.toLowerCase() === fromKey;
  const seen = new Set<string>();
  /** The parsed draft at `key` when it is in scope and a draft is stored there, else undefined. */
  const read = (key: string): Draft | null | undefined => {
    const raw = drafts[key];
    if (typeof raw !== "string" || seen.has(key)) return undefined;
    seen.add(key);
    return parseDraft(raw);
  };
  const capture = (draft: Draft) => ({
    text: textOf(draft),
    attachments: attached(draft.files) || attached(draft.snippets),
  });

  const captured: CapturedDraft[] = [];
  for (const conversation of conversations) {
    const targetKey = CONVERSATION_DRAFT_PREFIX + conversation.targetAlias;
    const keys = [
      ...new Set([
        targetKey,
        ...conversation.members.map(
          (member) => CONVERSATION_DRAFT_PREFIX + member.alias,
        ),
      ]),
    ].sort();
    const mine: { key: string; draft: Draft }[] = [];
    for (const key of keys) {
      const draft = read(key);
      if (draft && isFrom(draft) && textOf(draft) !== "")
        mine.push({ key, draft });
    }
    // A value Relay cannot read may be a draft of any account: the conversation is left out.
    const targetRaw = drafts[targetKey];
    if (typeof targetRaw === "string" && !parseDraft(targetRaw)) continue;
    if (mine.length === 0) continue;
    // The draft already at the target alias wins; otherwise the lexically first (`keys` is sorted).
    const keep = mine.find(({ key }) => key === targetKey) ?? mine[0];
    captured.push({
      targetAlias: conversation.targetAlias,
      title: Object.hasOwn(titles, conversation.targetAlias)
        ? titles[conversation.targetAlias]
        : "",
      ...capture(keep.draft),
    });
  }

  const newSession = read(NEW_SESSION_DRAFT);
  if (newSession && isFrom(newSession) && textOf(newSession) !== "")
    captured.push({ newSession: true, title: "", ...capture(newSession) });
  return captured;
}
