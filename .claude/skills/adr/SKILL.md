---
name: adr
description: Use before changing architecture, data stores, integration patterns, dependencies or cross-cutting conventions, and whenever asked to record, propose or look up an architectural decision.
---

# Architectural decisions (adr)

Decisions in this repo are managed by adr. Decision files do not
show their own status, so never judge from the raw files whether a
decision applies.

## Before changing architecture

1. Call adr_for_path for the files you will touch, and adr_search
   for the area you are about to change. adr_search returns active
   decisions only; adr_for_path also lists inactive ones, each with
   a warning.
2. If your change conflicts with an accepted decision, stop and tell
   the user which ADR it conflicts with. Do not work around it silently.
3. If the user still wants the change, propose a superseding ADR.

## Reading decisions

- Use adr_get or adr://decision/{id}, never docs/adr/decisions/*.md.
- If a response says SUPERSEDED or DEPRECATED, follow it to the
  effective decision before acting.
- If it says REJECTED or WITHDRAWN, the decision was never in force;
  do not apply it.

## Proposing decisions

1. Call adr_templates and fill every required section.
2. Use only facts from the conversation and the code. Mark unknowns
   as open questions instead of inventing them.
3. List at least two options considered when the template has that section.
4. Set supersedes when the proposal replaces an existing decision.
5. Do not accept your own proposal. Tell the user the ADR id and
   that they can review it and run: adr accept <id>
6. If the user decides against your proposal, withdraw it with
   adr_withdraw and give their reason. Don't withdraw other
   people's proposals; tell the user instead.

## Changing scope

- When you move or rename code covered by a decision, let the
  pre-commit hook update its globs (adr hooks install). For your
  own proposals, you can use adr_scope. Rescoping an accepted
  decision needs mcp_can_decide; otherwise tell the user and
  suggest adr scope <id> ….
- Before any scope change, read the decision's Scope section. If it
  would no longer read true after the change, do not rescope: tell
  the user the decision itself is changing and propose a
  superseding ADR.

## Never

- Edit an accepted decision body, any file under docs/adr/events/,
  or index.md by hand.
- Use adr_note to change the meaning of a decision. Notes clarify;
  changed decisions need a superseding ADR.

## Without the MCP server

Use the CLI with --json: adr search, adr for, adr show, adr new,
adr note. Set ARK_AGENT=<your name> and ARK_ON_BEHALF_OF=<the user's
email> so your writes are attributed.
