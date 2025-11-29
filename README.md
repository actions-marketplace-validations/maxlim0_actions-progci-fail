# Programmatic CI Failure helper

GitHub Action that catches failed workflow runs, summarizes the failing job/step logs, and asks OpenRouter for likely fixes. It only outputs to the action logs (no PR comments).

## Inputs
- `openrouter_api_key` (required): OpenRouter API key.
- `model` (required): OpenRouter model name (e.g., `x-ai/grok-4.1-fast:free`).
- `prompt_template` (required): Must include `{{LOG}}`; optional placeholders: `{{WORKFLOW_NAME}}`, `{{JOB_NAME}}`, `{{STEP_NAME}}`.
- `max_log_lines` (optional, default 500): Tail lines included from the failed job log.

## Example workflow
Trigger on failed workflow runs:
```yaml
name: Programmatic CI Failure helper

on:
  workflow_run:
    types: [completed]

jobs:
  progci-fail:
    if: ${{ github.event.workflow_run.conclusion != 'success' }}
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
    steps:
      - name: Analyze failed CI
        uses: your-org/actions-progci-fail@v0.1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          model: x-ai/grok-4.1-fast:free
          prompt_template: |
            Workflow {{WORKFLOW_NAME}} failed at job {{JOB_NAME}}, step {{STEP_NAME}}. Here are the last logs:\n{{LOG}}\nSuggest likely root cause and concrete fixes.
          max_log_lines: 500
```

## Notes
- The action picks the first failed job and step, tails its log, and sends it to OpenRouter.
- Secrets are not logged; logs are trimmed to the last `max_log_lines` lines.
- Works for any workflow_run; not tied to pull requests.
