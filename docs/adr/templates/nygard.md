---
template: nygard
version: 1
sections:
  - id: context
    heading: Context
    required: true
    guidance: What is the issue that motivates this decision? Describe the forces at play.
  - id: decision
    heading: Decision
    required: true
    guidance: What is the change that we're proposing or doing? Write it in the active voice.
  - id: scope
    heading: Scope
    required: true
    guidance: What does this decision govern? Name the systems, code paths or teams it applies to.
  - id: consequences
    heading: Consequences
    required: true
    guidance: What becomes easier or harder because of this change? Include the risks.
---
# {{title}}

## Context
{{context}}

## Decision
{{decision}}

## Scope
{{scope}}

## Consequences
{{consequences}}
