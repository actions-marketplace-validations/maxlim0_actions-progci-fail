# Programmatic CI Failure Helper

GitHub Action that inspects the current workflow run, confirms it failed, finds the latest failed job/step, tails its logs, and asks OpenRouter for likely fixes. Output goes to the action log and, if the run is tied to a pull request, a PR comment is created/updated.

## Inputs
- `openrouter_api_key` (required): OpenRouter API key.
- `model` (required): OpenRouter model name (e.g., `x-ai/grok-4.1-fast:free`).
- `prompt_template` (required): Must include `{{LOG}}`; optional placeholders: `{{WORKFLOW_NAME}}`, `{{JOB_NAME}}`, `{{STEP_NAME}}`.
- `max_log_lines` (optional, default 500): Tail lines included from the failed job log.

## Example workflow (helper job after failure)
```yaml
name: AI CI Failure Demo

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  fail-demo:
    runs-on: ubuntu-latest
    steps:
      - name: Step 1 - always succeeds
        run: echo "Hello from the first step"

      - name: Step 2 - broken docker build (fails intentionally)
        run: docker build -t invalid-image ./does-not-exist

  ai-helper:
    needs: [fail-demo]
    if: ${{ failure() }}
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      pull-requests: write
    steps:
      - name: AI failure helper
        uses: your-org/actions-progci-fail@v0.1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          model: x-ai/grok-4.1-fast:free
          prompt_template: |
            Workflow {{WORKFLOW_NAME}} failed at job {{JOB_NAME}}, step {{STEP_NAME}}.
            Last log lines:
            {{LOG}}

            Explain the likely root cause and suggest concrete fixes.
          max_log_lines: 200
```

## Notes
- Place the helper in a separate job with `needs: [...]` and `if: failure()` so целевые job уже завершены и логи доступны.
- Helper обрабатывает только провалившийся workflow; если все прошло успешно, он завершается без анализа.
- Если run связан с PR, helper создаёт/обновляет комментарий с маркером `<!-- ai-ci-helper -->`.
- Логи берутся из последнего упавшего job/step и обрезаются до `max_log_lines`; секреты не выводятся в лог.
