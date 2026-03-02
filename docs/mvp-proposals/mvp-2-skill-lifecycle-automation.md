# MVP-2 Skill Lifecycle Automation Proposal & Plan

Status: in_progress  
Last updated: 2026-03-02

## Proposal Summary

Goal: make skill pair lifecycle fully automated so publish/update/unpublish no longer depends on manual workspace operations.

Scope:

1. `ansible-main` installer/wirer for delegation skills.
2. `ansible-main` installer/wirer for executor skills.
3. Deterministic detach/unwire for unpublish + rollback.
4. Canary rollout controller + soak evaluator.
5. Automated remediation hooks for SLA/error misfires.

Success Gates:

1. Publish/update/unpublish run end-to-end without manual wiring.
2. Skill rollback is deterministic and auditable.
3. Soak evaluator can recommend promote/hold/rollback from recorded evidence.

Disposition (current):

1. Partial implementation in place from MVP-1 adjacency work.
2. Remaining backlog tracked in `docs/ansible-completion-checklist-v1.md`.
3. Next closure artifact should be `docs/evidence/mvp2/<timestamp>-mvp2-exit-gates.md`.
