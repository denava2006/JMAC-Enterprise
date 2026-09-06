# JMAC Agent Pipeline v1

Purpose: automate the handoff loop between Claude Code (builder) and Codex (QA) while preserving human approval at production-write boundaries.

## Roles

- **Claude Code**: implement/fix, run implementation tests, commit/push/deploy when the task explicitly allows it.
- **Codex**: read-only QA, exploratory workflow testing, UX-confusion review, regression verification. Never fixes code.
- **Supervisor**: launches each agent, parses reports, advances or loops, and stops at human gates.
- **User**: approves sensitive production writes, destructive operations, payments/disbursements, rollbacks, and other explicit gates.

## Files

- `config.json` — commands, limits and safety settings.
- `state.json` — current pipeline state.
- `tasks/claude-task.md` — builder task.
- `tasks/codex-task.md` — QA task.
- `reports/claude-report.md` — latest builder output.
- `reports/codex-report.md` — latest QA output.
- `prompts/claude-system.md` — wrapper appended around the builder task.
- `prompts/codex-system.md` — wrapper appended around the QA task.
- `run-agent-pipeline.mjs` — local supervisor.

Runtime files under `reports/`, `logs/` and `state.json` are intended to be local working state and should not be committed once the pipeline is active.

## Human gates

The supervisor must stop instead of automatically proceeding when a report says:

```text
PIPELINE_VERDICT: HUMAN_GATE
```

It must also stop after the configured iteration limit.

Never automate:

- destructive/reset DB operations
- production data repair
- production supplier/reimbursement/payroll payment completion
- production rollback
- force push

unless a future user-approved policy explicitly changes this.

## First-time setup

From `INTEGRATION/HRMS`:

```powershell
node .agent-pipeline/run-agent-pipeline.mjs doctor
```

This verifies that `git`, `claude`, `codex`, and `node` are visible to the shell.

Then edit the task files and run:

```powershell
node .agent-pipeline/run-agent-pipeline.mjs run
```

The initial v1 defaults to a conservative flow. Review `config.json` before enabling unattended implementation sessions.

## Report contract

Both agent reports must end with:

```text
PIPELINE_VERDICT: PASS|FAIL|HUMAN_GATE
PIPELINE_SEVERITY: NONE|LOW|MEDIUM|HIGH|BLOCKER
PIPELINE_SUMMARY: <one line>
```

Supervisor behavior:

- Claude `PASS` -> Codex QA
- Claude `FAIL` -> stop for inspection
- Claude `HUMAN_GATE` -> stop for user
- Codex `PASS` -> pipeline finishes successfully
- Codex `FAIL` -> findings are fed back into Claude for the next iteration
- Codex `HUMAN_GATE` -> stop for user
