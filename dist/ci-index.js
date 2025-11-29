const fs = require('fs');

const MARKER = '<!-- ai-ci-helper -->';
const GITHUB_API_BASE = process.env.GITHUB_API_URL || 'https://api.github.com';
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);

// Reads action input from environment with optional defaults and required guard.
function getInput(name, { required = false, defaultValue = '' } = {}) {
  const key = `INPUT_${name.toUpperCase().replace(/ /g, '_')}`;
  const value = process.env[key];
  if ((value === undefined || value.trim() === '') && required) {
    throw new Error(`Missing required input: ${name}`);
  }
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  return value.trim();
}

// Parses the GitHub event payload for this run (retained for compatibility/logging).
function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is not set. This action must run on GitHub Actions.');
  }
  const raw = fs.readFileSync(eventPath, 'utf8');
  return JSON.parse(raw);
}

// Builds base headers for GitHub REST requests.
function buildGitHubHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'ai-ci-helper',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

// Thin wrapper around fetch for GitHub API with JSON/text handling.
async function githubRequest(url, token, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: buildGitHubHeaders(token, headers),
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

// Retrieves all jobs for a workflow run, handling pagination.
async function fetchJobs(owner, repo, runId, token) {
  let page = 1;
  const jobs = [];
  while (true) {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`;
    const data = await githubRequest(url, token);
    const pageJobs = data && Array.isArray(data.jobs) ? data.jobs : [];
    jobs.push(...pageJobs);
    if (!data || !data.jobs || data.jobs.length < 100) {
      break;
    }
    page += 1;
  }
  return jobs;
}

// Picks the first failed job from the run.
function pickFailedJob(jobs) {
  return jobs.find((job) => FAILURE_CONCLUSIONS.has(String(job.conclusion || '').toLowerCase()));
}

// Picks the first failed step inside the job.
function pickFailedStep(job) {
  if (!job || !Array.isArray(job.steps)) {
    return null;
  }
  return job.steps.find((step) => FAILURE_CONCLUSIONS.has(String(step.conclusion || '').toLowerCase()));
}

// Downloads logs for a specific job.
async function fetchJobLogs(owner, repo, jobId, token) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;
  return githubRequest(url, token, {
    headers: { Accept: 'text/plain' },
  });
}

// Tails the log to a maximum number of lines.
function trimLog(logText, maxLines) {
  const lines = String(logText || '').split(/\r?\n/);
  if (lines.length <= maxLines) {
    return { text: lines.join('\n'), total: lines.length };
  }
  const trimmed = lines.slice(-maxLines);
  return { text: trimmed.join('\n'), total: lines.length };
}

// Ensures the prompt contains the required log placeholder.
function ensurePromptTemplate(template) {
  if (!template.includes('{{LOG}}')) {
    throw new Error('prompt_template must include {{LOG}} placeholder.');
  }
}

// Simple template renderer replacing {{KEY}} tokens.
function renderTemplate(template, values) {
  return Object.entries(values).reduce((acc, [key, val]) => acc.split(`{{${key}}}`).join(val), template);
}

// Resolves repository/run context for the current workflow run.
function resolveRunContext() {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runName = process.env.GITHUB_WORKFLOW || 'current workflow';

  if (!repository || !runId) {
    throw new Error('Repository or run id is missing; ensure this action runs inside a GitHub Actions workflow.');
  }

  const [owner, repo] = repository.split('/');
  return { owner, repo, runId, runName };
}

// Sends the prompt to OpenRouter and returns the model response.
async function callOpenRouter(apiKey, model, prompt) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'X-Title': process.env.GITHUB_REPOSITORY || 'ai-ci-helper',
  };

  const referer = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
    : null;
  if (referer) {
    headers['HTTP-Referer'] = referer;
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  console.log(`OpenRouter responded with status: ${response.status}`);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenRouter response missing message content.');
  }

  return String(content).trim();
}

// Main entrypoint: gather failed job log, build prompt, call OpenRouter, and print analysis.
async function main() {
  const openrouterApiKey = getInput('openrouter_api_key', { required: true });
  const model = getInput('model', { required: true });
  const promptTemplate = getInput('prompt_template', { required: true });
  const maxLogLinesInput = getInput('max_log_lines', { defaultValue: '500' });
  const maxLogLines = Number.parseInt(maxLogLinesInput, 10);
  const githubToken = process.env.GITHUB_TOKEN;

  if (!Number.isFinite(maxLogLines) || maxLogLines <= 0) {
    throw new Error('max_log_lines must be a positive integer.');
  }

  if (!githubToken) {
    throw new Error('GITHUB_TOKEN is required to call GitHub API.');
  }

  ensurePromptTemplate(promptTemplate);

  // Parse payload for logging/compatibility; logic uses current run context.
  readEventPayload();
  const context = resolveRunContext();

  console.log(`Starting CI failure analysis for workflow: ${context.runName} (#${context.runId})`);

  const jobs = await fetchJobs(context.owner, context.repo, context.runId, githubToken);
  if (!jobs.length) {
    console.log('No jobs found for this workflow run.');
    return;
  }

  const failedJob = pickFailedJob(jobs);
  if (!failedJob) {
    console.log('No failed jobs detected. Exiting.');
    return;
  }

  const failedStep = pickFailedStep(failedJob);
  const stepName = failedStep ? failedStep.name : 'Unknown step';

  const logs = await fetchJobLogs(context.owner, context.repo, failedJob.id, githubToken);
  const { text: trimmedLog, total: totalLogLines } = trimLog(logs, maxLogLines);

  console.log(`Analyzing job "${failedJob.name}" (id: ${failedJob.id}), step "${stepName}".`);
  console.log(`Original log lines: ${totalLogLines}; included lines: ${Math.min(totalLogLines, maxLogLines)}`);

  const prompt = renderTemplate(promptTemplate, {
    LOG: trimmedLog || 'Log is empty.',
    WORKFLOW_NAME: context.runName || '',
    JOB_NAME: failedJob.name || '',
    STEP_NAME: stepName || '',
  });

  let analysis = '';
  try {
    analysis = await callOpenRouter(openrouterApiKey, model, prompt);
  } catch (error) {
    console.error('OpenRouter request failed:', error.message);
    analysis = `Не удалось получить ответ от OpenRouter: ${error.message}`;
  }

  const body = [
    MARKER,
    `CI Failure Analysis (workflow: ${context.runName}, job: ${failedJob.name}, step: ${stepName})`,
    analysis,
    'Generated automatically after workflow failure.',
  ].join('\n');

  console.log('AI analysis:');
  console.log(body);
}

main().catch((error) => {
  console.error('CI helper failed:', error.message);
  process.exitCode = 1;
});
