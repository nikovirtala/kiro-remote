/**
 * The `instructions` returned in `initialize` and `server/discover`. Clients
 * that do not support the Skills extension (Claude Desktop, Kiro) rely on this
 * text alone, so it carries the loop, the follow-up rule and the retry rule. Keep it
 * short: clients put it in every prompt.
 */

/** The URI of the skill, for clients that support skills. */
export const SKILL_URI = "skill://kiro-remote-sessions/SKILL.md";

export const INSTRUCTIONS = `Hand coding work to a Kiro cloud session. Loop: kiro_launch_session, then kiro_wait_for_events (pass nextCursor as after; stop when turnStatus is idle and a turn.completed or turn.failed event arrived), then kiro_get_transcript. Send follow-ups with kiro_send_prompt and whenBusy: "queue", because the default steer fails on a busy cloud session. Pass one idempotencyKey per logical call and reuse it on every retry. Full guide for clients that support skills: ${SKILL_URI}`;
