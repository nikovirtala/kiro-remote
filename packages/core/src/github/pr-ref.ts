/**
 * Pure helpers for GitHub pull-request references and the session trailer.
 * Shared by the service layer (manual links, the launch-prompt trailer), the
 * REST API and packages/github (harvest, trailer parsing, routing).
 */

/** A pull request: `owner/repo#number`. Owner and repo keep the case they were written in. */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO = "[A-Za-z0-9._-]{1,100}";
const SHORT_RE = new RegExp(`^(${OWNER})/(${REPO})#(\\d{1,9})$`);
const URL_RE = new RegExp(
  `^https://github\\.com/(${OWNER})/(${REPO})/pull/(\\d{1,9})(?:[/?#][^\\s]*)?$`,
);
/** Finds PR URLs inside free text. The trailing boundary stops at the first non-URL character. */
const URL_IN_TEXT_RE = new RegExp(
  `https://github\\.com/(${OWNER})/(${REPO})/pull/(\\d{1,9})(?![0-9A-Za-z])`,
  "g",
);

/** Canonical `owner/repo#n` key. Owner/repo are lower-cased so keys compare equal however GitHub spells them. */
export function prKeyOf(ref: PrRef): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
}

/** `owner/repo` (lower-cased) for a ref. */
export function repoOf(ref: Pick<PrRef, "owner" | "repo">): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}`;
}

/** Parse `owner/repo#n` or a `https://github.com/owner/repo/pull/n` URL. Null when it is neither. */
export function parsePrRef(input: string): PrRef | null {
  const text = input.trim();
  const m = SHORT_RE.exec(text) ?? URL_RE.exec(text);
  if (!m) {
    return null;
  }
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number < 1) {
    return null;
  }
  return { owner: m[1], repo: m[2].replace(/\.git$/, ""), number };
}

/** Every distinct PR URL in `text`, in order of first appearance. */
export function findPrUrls(text: string): PrRef[] {
  const seen = new Set<string>();
  const out: PrRef[] = [];
  for (const m of text.matchAll(URL_IN_TEXT_RE)) {
    const ref: PrRef = { owner: m[1], repo: m[2], number: Number(m[3]) };
    const key = prKeyOf(ref);
    if (!seen.has(key) && ref.number >= 1) {
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}

/** The PR body trailer key the agent is asked to write. */
export const SESSION_TRAILER_KEY = "Kiro-Remote-Session";

/** The exact trailer line for a session. */
export function trailerLine(sessionId: string): string {
  return `${SESSION_TRAILER_KEY}: ${sessionId}`;
}

/** What the launch prompt appends so the agent puts the trailer in the PR body. */
export function trailerInstruction(sessionId: string): string {
  return `When you open a pull request, put this exact line on its own line in the pull request description (body): ${trailerLine(sessionId)}`;
}

const TRAILER_RE = new RegExp(
  `^${SESSION_TRAILER_KEY}:[ \\t]*([A-Za-z0-9_-]{8,64})[ \\t]*\\r?$`,
  "gm",
);

/**
 * The session id named by the trailer in a PR body. Null when there is none,
 * or when the body names more than one distinct id (ambiguous, so refused).
 */
export function parseTrailer(body: string | null | undefined): string | null {
  if (!body) {
    return null;
  }
  const ids = new Set<string>();
  for (const m of body.matchAll(TRAILER_RE)) {
    ids.add(m[1]);
  }
  return ids.size === 1 ? [...ids][0] : null;
}
