PIPELINE_PHASE: SETUP
PIPELINE_RISK: LOCAL_ONLY

# Claude task

Replace this template with the implementation/fix task Claude should perform.

Rules for this template run:
- local work only
- no commit
- no push
- no deployment
- no production business-data writes

When Codex reports findings, the supervisor will append those findings to this task automatically for the next repair iteration.
