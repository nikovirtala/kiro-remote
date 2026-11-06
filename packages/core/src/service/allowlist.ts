/**
 * Repo allow-list matching.
 *
 * Patterns are simple globs over `owner/name` strings where `*` matches any run
 * of characters except `/` and `**` matches across `/`. Matching is anchored
 * (the whole string must match) and case-insensitive on the owner/name, which
 * is how GitHub treats them.
 */

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

/** True when `repo` matches any pattern in `allowed`. Empty list denies all. */
export function matchesAllowList(repo: string, allowed: readonly string[]): boolean {
  return allowed.some((pattern) => globToRegExp(pattern).test(repo));
}
