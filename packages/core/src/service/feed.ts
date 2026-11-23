/**
 * GET /v1/events and kiro_list_events: the change feed (see schemas/feed.ts).
 *
 * The feed an account reads is its own: events are filed under the owner of the session they are
 * about, so the access rule is the one the sessions have (`sessions:read`, owner only). Another
 * account's events are not hidden by a filter, they are in another partition.
 */

import type { Principal } from "../auth/authenticate.ts";
import { authorize } from "../auth/authorize.ts";
import type { FeedPage, FeedQuery } from "../schemas/feed.ts";
import type { ServiceDeps } from "./index.ts";

export async function listFeedEvents(
  deps: ServiceDeps,
  principal: Principal,
  args: FeedQuery,
): Promise<FeedPage> {
  authorize(principal, "read");
  return deps.repo.readFeed(principal.sub, args.after, args.limit);
}
