import type { PrRead } from "./pr-batch";
import type { CallCache } from "./call-cache";
import type { GhPriority } from "./gh-queue";
import { conditionalGet, isPlainGet, type EtagStore } from "./etag";
import { budgetText, paceDelay, parseRateLimit } from "./budget";
import { existsSync } from "node:fs";
import { findGh, ghFailure, mergePaths, PATH_MARKER, pathFromShell } from "./gh-binary";
import { logTail } from "./log-excerpt";
import { approvalLine, upToDateLine } from "./pr-status";
import type { WorkflowRole, WorkflowSummary } from "./workflow-role";
import { deployPossible, startsOnMerge, startsOnPullRequest, workflowEnvironments } from "./merge-triggers";
import { checkName, factsFrom, isDeployJob, latestAttempts, pipelineChecks, summaryLine, type CheckView, type JobView, type PrFacts, type PrView, type RunWithJobs } from "./pr-facts";
import { noDebugLog, tolerate, type DebugLog } from "./debug-log";
import { COMMENTS_QUERY, parseComments, type CommentRead } from "./comments";
import { favouriteSearches, mergeReviews, REQUESTED_SEARCH, REVIEW_SEARCH_QUERY, reviewArgs, reviewRequestsFrom, staleHead, type ReviewEvent, type ReviewRequest } from "./review-requests";
import { afterSuccess, budgetOf, classifyGhError, healthAfter, pausedText } from "./github-health";
import { processState, sharedMap } from "./runtime";
import { myPrFrom, type MyPr, type SearchedPr } from "./my-prs";
import { runFacts } from "./run-facts";
import { planSummary, type TerraformPlan } from "./terraform";
import type { Snapshot } from "./watcher";
import { execFile } from "node:child_process";

export type Gh = (args: string[], cwd: string) => Promise<string>;

let ghBinary: string | undefined;
let debug: DebugLog = noDebugLog;

/** Where tolerated read failures (optional facts and text) are logged. */
export const setGithubDebug = (log: DebugLog) => {
  debug = log;
};

let ghEnv: NodeJS.ProcessEnv | undefined;

// An app started from the Dock doesn't get the terminal's PATH; the login shell knows it (Homebrew, mise, ...).
// Interactive, so .zshrc counts too; markers skip anything the startup files print.
function loginShellPath(): Promise<string | undefined> {
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    execFile(shell, ["-ilc", `printf '${PATH_MARKER}%s${PATH_MARKER}' "$PATH"`], { timeout: 10_000 }, (err, stdout) =>
      resolve(err ? undefined : pathFromShell(stdout)),
    );
  });
}

/** Finds `gh` once at load, with the login shell's PATH; returns undefined when it can't be found anywhere. */
export async function configureGh(configured?: string): Promise<string | undefined> {
  const shellPath = await loginShellPath();
  const path = shellPath ? mergePaths(shellPath, process.env.PATH ?? "") : process.env.PATH;
  ghEnv = { ...process.env, ...(path ? { PATH: path } : {}) };
  ghBinary = findGh({ ...(configured ? { configured } : {}), ...(path ? { path } : {}) }, existsSync);
  return ghBinary;
}

const execGh: Gh = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(ghBinary ?? "gh", args, { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 60_000, ...(ghEnv ? { env: ghEnv } : {}) }, (err, stdout, stderr) => {
      if (err) reject(new Error(ghFailure(err, args, stderr)));
      else resolve(stdout);
    });
  });

// gh exits non-zero on a 304 and on errors; with -i the answer, headers and all, is still on stdout.
const execGhRaw: Gh = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(ghBinary ?? "gh", args, { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 60_000, ...(ghEnv ? { env: ghEnv } : {}) }, (err, stdout, stderr) => {
      if (/^HTTP\/\S+ \d{3}/.test(stdout)) resolve(stdout);
      else if (err) reject(new Error(ghFailure(err, args, stderr)));
      else resolve(stdout);
    });
  });

const etags = sharedMap<{ etag: string; body: string } | { missingUntil: number; message: string }>("etags/2");

/** A plain GET is asked with the last answer's ETag; an unchanged answer (304) is free. Anything else as it is. */
const execConditional: Gh = (args, cwd) =>
  isPlainGet(args)
    ? conditionalGet(etags as EtagStore, args.join("\u0000"), (etag) =>
        execGhRaw(["api", "-i", ...args.slice(1), ...(etag ? ["-H", `If-None-Match: ${etag}`] : [])], cwd))
    : execGh(args, cwd);

// While GitHub is rate limiting or can't be reached, every call is refused at once until the shared pause is over.
// Every call waits its turn in the process's queue.
// Reading the budget doesn't count against it; read at most once a minute, and only for REST calls.
let budgetRead: Promise<void> | undefined;
const refreshBudget = (cwd: string): Promise<void> => {
  const state = processState();
  if (state.restBudgetReadAt !== undefined && Date.now() - state.restBudgetReadAt < 60_000) return Promise.resolve();
  state.restBudgetReadAt = Date.now();
  return (budgetRead ??= execGh(["api", "rate_limit"], cwd)
    .then((json) => void (state.restBudget = parseRateLimit(json)))
    .catch(() => undefined)
    .finally(() => (budgetRead = undefined)));
};

const PACE_AS_PAUSE_MS = 60_000;

const ghCall = (priority: GhPriority): Gh => async (args, cwd) => {
  const state = processState();
  const budget = budgetOf(args);
  const key = budget === "graphql" ? "githubGraphql" : "github";
  const paused = pausedText(state[key], Date.now());
  if (paused) throw new Error(paused);
  if (budget === "rest") {
    await refreshBudget(cwd);
    if (priority === "background") {
      const now = Date.now();
      const wait = paceDelay(state.restBudget, now, state.lastPacedAt ?? 0);
      if (wait > PACE_AS_PAUSE_MS && state.restBudget) {
        // Down to the reserve: every watch waits for the reset, shown in the panel like being rate limited.
        state.github = { kind: "rate-limit", until: state.restBudget.resetAt, failures: 0 };
        throw new Error(pausedText(state.github, now)!);
      }
      state.lastPacedAt = now + wait;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  try {
    const out = await state.ghQueue.run(priority, () => execConditional(args, cwd));
    for (const which of ["github", "githubGraphql"] as const) {
      const health = state[which];
      if (!health) continue;
      const next = afterSuccess(health, which === key);
      if (next) continue;
      debug("github-back", { budget: which === "github" ? "rest" : "graphql", after: health.kind, failures: health.failures });
      state[which] = undefined;
    }
    return out;
  } catch (err) {
    const kind = classifyGhError(err instanceof Error ? err.message : String(err));
    if (kind) {
      let health = healthAfter(state[key], kind, Date.now());
      // GitHub says when the budget comes back; waiting for that beats guessing.
      if (health && kind === "rate-limit" && budget === "rest" && state.restBudget && state.restBudget.resetAt > Date.now()) {
        health = { ...health, until: state.restBudget.resetAt };
      }
      state[key] = health;
      if (health) debug("github-paused", { budget: budgetOf(args), kind, until: new Date(health.until).toISOString(), failures: health.failures });
    }
    throw err;
  }
};

export const runGh: Gh = ghCall("background");
/** For what someone is waiting on, such as starting a watch: ahead of background checks. */
export const runGhFirst: Gh = ghCall("first");

/** Why GitHub calls are paused or slowed right now, for the panel; undefined when they aren't. */
export const githubPaused = () => {
  const state = processState();
  const now = Date.now();
  return pausedText(state.github, now) ?? pausedText(state.githubGraphql, now) ?? budgetText(state.restBudget, now);
};

const PR_FIELDS = "headRefOid,author,reviewRequests,state,isDraft,baseRefName,title,url,reviewDecision,mergeStateStatus,autoMergeRequest,mergedAt,mergeCommit,statusCheckRollup";


export interface RunView {
  databaseId: number;
  workflowName: string;
  /** Unique, unlike the name: GitHub's default CodeQL setup and a codeql.yml can both be called "CodeQL". */
  workflowDatabaseId?: number;
  status: string;
  conclusion: string;
  event: string;
  createdAt: string;
  url: string;
}

export const runLine = (run: RunView) =>
  `  - ${run.workflowName} [${run.event}] started ${run.createdAt}: ${run.status} ${run.conclusion} ${run.url}`.replace(/ +$/, "");

const checkLine = (c: CheckView) =>
  `  - ${c.name ?? c.context}: ${c.status ?? ""} ${c.conclusion ?? c.state ?? ""}`.trimEnd();

// Undefined when GitHub has nothing there (an unprotected branch) or won't show it to us (classic branch protection
// needs admin rights; the rules API covers that case). Any other failure throws.
async function apiJson<T>(gh: Gh, path: string, cwd: string): Promise<T | undefined> {
  try {
    return JSON.parse(await gh(["api", path], cwd)) as T;
  } catch (err) {
    if (!/HTTP 40[34]|Not Found/i.test(err instanceof Error ? err.message : String(err))) throw err;
    debug("tolerated-error", { what: "not visible", path, error: err });
    return undefined;
  }
}

/**
 * The checks the base branch requires before a merge, from classic branch protection and rulesets.
 * A source that can't be read contributes nothing rather than failing the snapshot.
 */
export const requiredChecks = (gh: Gh, repo: string, base: string, cwd: string): Promise<string[]> =>
  cached(`required:${repo}@${base}`, 10 * 60_000, () => readRequiredChecks(gh, repo, base, cwd));

async function readRequiredChecks(gh: Gh, repo: string, base: string, cwd: string): Promise<string[]> {
  const branch = await apiJson<{ protection?: { required_status_checks?: { contexts?: string[] } } }>(
    gh, `repos/${repo}/branches/${base}`, cwd,
  );
  const rules = await apiJson<{ type: string; parameters?: { required_status_checks?: { context: string }[] } }[]>(
    gh, `repos/${repo}/rules/branches/${base}`, cwd,
  );
  const fromRules = (rules ?? [])
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    .map((check) => check.context);
  return [...new Set([...(branch?.protection?.required_status_checks?.contexts ?? []), ...fromRules])].sort();
}

/** The model's judgement of a workflow's role, cached by the caller; undefined when it can't be judged. */
export type RoleLookup = (workflowID: number) => Promise<WorkflowRole | undefined>;

/**
 * The open PR from one call, to start its watch at once; the first full check fills in the rest. Merged or closed PRs
 * need the full read (their deploy decides whether to watch), so they get none.
 */
export async function quickSnapshot(gh: Gh, repo: string, pr: number, cwd: string, now = Date.now(), readPr?: ReadPr): Promise<Snapshot | undefined> {
  const view: PrView = readPr ? (await readPr(repo, pr, cwd)).view : JSON.parse(await gh(["pr", "view", String(pr), "--repo", repo, "--json", PR_FIELDS], cwd));
  if (view.state !== "OPEN") return undefined;
  return { text: `PR: ${view.title} (${view.url})\n(first read; details follow)`, facts: factsFrom(view, [], now) };
}

/** Reads a PR and who commented on it; the plugin batches these into one GraphQL call. */
export type ReadPr = (repo: string, pr: number, cwd: string) => Promise<PrRead>;

export async function prSnapshot(
  gh: Gh,
  repo: string,
  pr: number,
  cwd: string,
  now = Date.now(),
  roleOf?: RoleLookup,
  noDeploy = false,
  guessEnvironments?: EnvironmentGuess,
  readPr?: ReadPr,
  /** The facts from the last check, whose details stand in for those that can't be read this time. */
  previous?: PrFacts,
): Promise<Snapshot> {
  let view: PrView;
  let batchedComments: CommentRead | undefined;
  try {
    if (readPr) {
      const read = await readPr(repo, pr, cwd);
      view = read.view;
      batchedComments = read.comments;
    } else {
      view = JSON.parse(await gh(["pr", "view", String(pr), "--repo", repo, "--json", PR_FIELDS], cwd));
    }
  } catch (err) {
    debug("read-failed", { repo, pr, what: "PR", error: err });
    return { text: `Could not read the PR: ${err instanceof Error ? err.message : String(err)}` };
  }

  const runs: RunWithJobs[] = [];
  let listed: RunView[] = [];
  if (view.mergeCommit) {
    try {
      listed = await listRuns(gh, repo, `head_sha=${view.mergeCommit.oid}`, cwd);
      const workflowIDs = [...new Set(listed.filter((r) => r.event === "push" && r.workflowDatabaseId !== undefined).map((r) => r.workflowDatabaseId!))];
      // Without a role the workflow is judged from its job names, as before roles existed.
      const roles = new Map(
        await Promise.all(workflowIDs.map(async (id) => [id, await tolerate(debug, "workflow role", roleOf?.(id), undefined, { repo, workflow: id })] as const)),
      );
      for (const run of [...listed].sort((a, b) => a.databaseId - b.databaseId)) {
        const jobs = run.event === "push" ? await jobsOf(gh, repo, run.databaseId, cwd) : [];
        const pending = run.event === "push" && run.status !== "completed" && !jobs.some(isDeployJob);
        const usuallyDeploys = pending && run.workflowDatabaseId !== undefined && (await workflowUsuallyDeploys(gh, repo, run.workflowDatabaseId, cwd));
        const role = run.event === "push" && run.workflowDatabaseId !== undefined ? roles.get(run.workflowDatabaseId) : undefined;
        runs.push({ ...run, jobs, ...(usuallyDeploys ? { usuallyDeploys } : {}), ...(role ? { role } : {}) });
      }
    } catch (err) {
      // Facts from a partial read would be wrong (no runs reads as "no deploy started"); decide nothing this round.
      debug("read-failed", { repo, pr, what: "workflow runs", error: err });
      return { text: `Could not read the workflow runs: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  let required: string[];
  let rerunning: string[];
  let baseRuns: RunWithJobs[];
  try {
    required = view.state === "OPEN" ? await requiredChecks(gh, repo, view.baseRefName, cwd) : [];
    rerunning = view.state === "OPEN" ? await runningWorkflows(gh, repo, view.headRefOid, cwd) : [];
    baseRuns = view.state === "OPEN" ? await runningBaseDeploys(gh, repo, view.baseRefName, cwd) : [];
  } catch (err) {
    debug("read-failed", { repo, pr, what: "checks and base deploys", error: err });
    return { text: `Could not read the checks: ${err instanceof Error ? err.message : String(err)}` };
  }
  let facts = factsFrom(view, runs, now, required, rerunning, baseRuns, { noDeploy });
  // Merged without deploy runs: if nothing a merge starts can deploy, there's nothing to wait for.
  if (view.state === "MERGED" && !noDeploy && (facts.deploy === "NO_RUNS" || facts.deploy === "UNIDENTIFIED")) {
    const changed = await tolerate(debug, "changed files", prChangedFiles(gh, repo, pr, cwd), undefined, { repo, pr });
    const ids = await tolerate(debug, "workflows a merge starts", mergeWorkflows(gh, repo, view.baseRefName, cwd, changed), undefined, { repo, pr });
    if (ids) {
      const roles = await Promise.all(ids.map((id) => tolerate(debug, "workflow role", roleOf?.(id), undefined, { repo, workflow: id })));
      const possible = deployPossible(roles);
      debug("deploy-possible", { repo, pr, workflows: ids, roles, possible });
      if (possible !== undefined) facts = { ...facts, deployPossible: possible };
    }
  }
  if (view.state === "OPEN" && view.headRefOid) {
    const blocked = await tolerate(debug, "checks queued behind other runs", blockedChecks(gh, repo, view.headRefOid, cwd), [], { repo, pr });
    if (blocked.length > 0) facts = { ...facts, blockedChecks: blocked };
  }
  if (view.state === "OPEN") {
    // A detail that couldn't be read this time keeps its value from the last check of the same commit; leaving it out
    // would look like a change (and come back as one), which the model then reports.
    const same = previous !== undefined && previous.headSha === view.headRefOid;
    const read_ = await finishedRunPlans(gh, repo, view.statusCheckRollup, cwd);
    const plans = !read_.complete && same && previous.terraformPlans ? previous.terraformPlans : read_.plans;
    if (plans.length > 0) facts = { ...facts, terraformPlans: plans };
    // Only for the line's icon: never part of the text, so a new comment doesn't wake the model.
    const read = batchedComments ?? (await tolerate(debug, "comments", prComments(gh, repo, pr, cwd), undefined, { repo, pr }));
    if (read) facts = { ...facts, unresolvedThreads: read.unresolvedThreads, ...(read.unresolvedUrl ? { unresolvedUrl: read.unresolvedUrl } : {}), commentIds: read.commentIds, comments: read.comments };
    const changedOpen = await tolerate(debug, "changed files", prChangedFiles(gh, repo, pr, cwd), undefined, { repo, pr });
    const approvalRead = await tolerate(debug, "expected checks approval", cachedChecksApproval(gh, repo, view.baseRefName, cwd, now, guessEnvironments, changedOpen), undefined, { repo, pr });
    const checksApproval = approvalRead ?? (same ? previous.expectedChecksApproval : undefined) ?? [];
    if (checksApproval.length > 0) facts = { ...facts, expectedChecksApproval: checksApproval };
    if (roleOf) {
      const expectedRead = await tolerate(debug, "expected deploy", cachedExpectedDeploy(gh, repo, view.baseRefName, cwd, roleOf, now, changedOpen).then((expected) => ({ expected })), undefined, { repo, pr });
      const expected = expectedRead ? expectedRead.expected : same ? previous.expectedDeploy : undefined;
      if (expected) facts = { ...facts, expectedDeploy: expected };
    }
  }
  if (facts.deploy === "RUNNING") {
    const queued = runs.find((r) => r.event === "push" && r.status !== "completed" && r.status !== "in_progress" && r.jobs.length === 0) as (RunWithJobs & { workflowDatabaseId?: number }) | undefined;
    const blockedBy = queued?.workflowDatabaseId !== undefined
      ? await tolerate(debug, "blocking run", blockingRun(gh, repo, { databaseId: queued.databaseId, workflowDatabaseId: queued.workflowDatabaseId }, cwd), undefined, { repo, pr })
      : undefined;
    if (blockedBy) facts = factsFrom(view, runs, now, required, rerunning, baseRuns, { noDeploy, blockedBy });
  }
  if (facts.deploy === "FAILED" && view.mergeCommit) {
    const failedRuns = listed.filter((r) => r.event === "push" && r.conclusion === "failure" && r.workflowDatabaseId !== undefined) as { workflowDatabaseId: number; createdAt: string }[];
    const deployedBy = await tolerate(debug, "later deploy", laterDeploy(gh, repo, view.mergeCommit.oid, view.baseRefName, failedRuns, cwd), undefined, { repo, pr });
    if (deployedBy) facts = factsFrom(view, runs, now, required, rerunning, baseRuns, { noDeploy, deployedBy });
  }

  // Only the PR's own pipeline is listed; everything else is counted, so the state stays short in large monorepos.
  const runLines: string[] = [];
  if (view.mergeCommit) {
    runLines.push(`merged at ${view.mergedAt}, commit ${view.mergeCommit.oid}`, "merge pipeline:");
    const mergedAt = Date.parse(view.mergedAt ?? "");
    const unaffected = new Set(facts.unaffectedPipelines);
    const own = runs.filter((r) => r.event === "push" && Date.parse(r.createdAt) >= mergedAt && !unaffected.has(r.workflowName));
    if (own.length === 0) runLines.push(facts.deploy === "NOTHING" ? "  nothing to deploy for this change" : "  (none yet)");
    for (const run of own) {
      runLines.push(runLine(run), ...run.jobs.filter((j) => j.conclusion !== "skipped").map((j) => `      job ${j.name}: ${j.status} ${j.conclusion}`.trimEnd()));
      if (run.conclusion === "failure") runLines.push(await failedLogTail(gh, repo, run.databaseId, cwd));
    }
    // Component pipelines that skipped their deploys are left out entirely: they change as each one decides, and every
    // change in this text goes to the model, which then reported them despite being told not to.
    const others = runs.filter((r) => !own.includes(r) && !unaffected.has(r.workflowName));
    if (others.length > 0) {
      const failed = others.filter((r) => r.conclusion === "failure").map((r) => `${r.workflowName} [${r.event}]`);
      runLines.push(`${others.length} other runs on the merge commit (not this PR's deploy)${failed.length ? `, failed: ${failed.join(", ")}` : ""}`);
    }
  }

  const checks = latestAttempts(pipelineChecks(view.statusCheckRollup));
  const shown = checks.filter((c) => (c.conclusion ?? "").toUpperCase() !== "SKIPPED");
  const lines = [
    `PR: ${view.title} (${view.url})`,
    summaryLine(facts, now),
    `state: ${view.state}${view.isDraft ? " (draft)" : ""}`,
    approvalLine(view.reviewDecision),
    upToDateLine(view),
    `merge: ${view.mergeStateStatus}${view.autoMergeRequest ? ", auto-merge enabled" : ""}`,
    ...(view.state === "OPEN"
      ? [
          "checks:",
          ...shown.map(checkLine).sort(),
          ...facts.missingChecks.map((name) => `  - ${name}: required, not reported`),
          ...(checks.length > shown.length ? [`  (${checks.length - shown.length} skipped)`] : []),
        ]
      : []),
    ...(facts.deployingOnBase.length > 0 ? [`earlier merge still deploying on ${view.baseRefName}: ${facts.deployingOnBase.join(", ")}`] : []),
    ...runLines,
  ];
  return { text: lines.join("\n"), facts };
}

/** Who commented on the PR (never the text) and how many review threads nobody has resolved, in one call. */
export async function prComments(gh: Gh, repo: string, pr: number, cwd: string): Promise<CommentRead> {
  const [owner, name] = repo.split("/");
  return parseComments(JSON.parse(await gh(["api", "graphql", "-f", `query=${COMMENTS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr}`], cwd)));
}

export interface ExpectedDeploy {
  readonly jobs: readonly string[];
  readonly approval: readonly string[];
}

/**
 * What a merge into the base branch will deploy: the jobs of the deploy workflows' last successful run there (skipped
 * ones left out), and the environments they deploy to that need a reviewer's approval. Undefined when nothing deploys.
 * Which workflows deploy is the model's judgement (roleOf); `complete` is false while a role is still unknown.
 */
async function readExpectedDeploy(gh: Gh, repo: string, base: string, cwd: string, roleOf: RoleLookup, changed?: readonly string[]): Promise<{ expected?: ExpectedDeploy; complete: boolean }> {
  const ids = await mergeWorkflows(gh, repo, base, cwd, changed);
  if (!ids) return { complete: false };
  const roles = await Promise.all(ids.map((id) => tolerate(debug, "workflow role", roleOf(id), undefined, { repo, workflow: id })));
  const complete = !roles.includes(undefined);
  const deploying = ids.filter((_, i) => roles[i] === "deploy");
  if (deploying.length === 0) return { complete };
  const { workflows } = JSON.parse(await gh(["api", `repos/${repo}/actions/workflows`], cwd)) as { workflows: { id: number; path: string }[] };
  const jobs: string[] = [];
  const environments: string[] = [];
  for (const id of deploying) {
    const path = workflows.find((w) => w.id === id)?.path;
    if (path) environments.push(...workflowEnvironments(await gh(["api", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(base)}`, "-H", "Accept: application/vnd.github.raw"], cwd)));
    const [last] = JSON.parse(
      await gh(["run", "list", "--repo", repo, "--workflow", String(id), "--branch", base, "--event", "push", "--status", "success", "--limit", "1", "--json", "databaseId"], cwd),
    ) as { databaseId: number }[];
    if (last) jobs.push(...(await jobsOf(gh, repo, last.databaseId, cwd)).filter((job) => job.conclusion !== "skipped").map((job) => job.name));
  }
  return { expected: { jobs: [...new Set(jobs)], approval: await protectedEnvironments(gh, repo, environments, cwd) }, complete };
}

/** The environments, of those given, that need a reviewer's approval; one that can't be read is left out. */
async function protectedEnvironments(gh: Gh, repo: string, environments: readonly string[], cwd: string): Promise<string[]> {
  const approval: string[] = [];
  for (const env of new Set(environments)) {
    const rules = await tolerate(debug, "environment protection", gh(["api", `repos/${repo}/environments/${encodeURIComponent(env)}`], cwd), undefined, { repo, env });
    const parsed = rules ? (JSON.parse(rules) as { protection_rules?: { type: string }[] }) : undefined;
    if (parsed?.protection_rules?.some((rule) => rule.type === "required_reviewers")) approval.push(env);
  }
  return approval;
}

/** The model's reading of the environments a workflow file's jobs use for a pull request; undefined when it can't tell. */
export type EnvironmentGuess = (file: string, base: string) => Promise<string[] | undefined>;

// An environment set by an expression, directly or as an input to a shared workflow, which no general rule can read.
const ENV_EXPRESSION = /environment:\s*['"]?\$\{\{/;

/**
 * The environments that the workflows a pull request into the base branch starts deploy to, and that need approval.
 * Names in the file are read as they are; names set by an expression come from the model, and only those the repo
 * really has count. `complete` is false when a model answer was needed and not given.
 */
async function readChecksApproval(gh: Gh, repo: string, base: string, cwd: string, guess?: EnvironmentGuess, changed?: readonly string[]): Promise<{ approval: string[]; complete: boolean }> {
  const { workflows } = JSON.parse(await gh(["api", `repos/${repo}/actions/workflows`], cwd)) as { workflows: { id: number; path: string; state: string }[] };
  const environments: string[] = [];
  let complete = true;
  let known: Set<string> | undefined;
  for (const w of workflows.filter((w) => w.state === "active" && w.path.startsWith(".github/"))) {
    const file = await tolerate(debug, "workflow file", gh(["api", `repos/${repo}/contents/${w.path}?ref=${encodeURIComponent(base)}`, "-H", "Accept: application/vnd.github.raw"], cwd), undefined, { repo, path: w.path });
    if (!file || !startsOnPullRequest(file, base, changed)) continue;
    environments.push(...workflowEnvironments(file));
    if (!ENV_EXPRESSION.test(file)) continue;
    const guessed = guess ? await tolerate(debug, "environments of a workflow", guess(file, base), undefined, { repo, path: w.path }) : undefined;
    if (!guessed) {
      complete = false;
      continue;
    }
    known ??= new Set(((JSON.parse(await gh(["api", `repos/${repo}/environments`], cwd)) as { environments?: { name: string }[] }).environments ?? []).map((e) => e.name));
    environments.push(...guessed.filter((name) => known!.has(name)));
  }
  return { approval: await protectedEnvironments(gh, repo, environments, cwd), complete };
}

export async function expectedChecksApproval(gh: Gh, repo: string, base: string, cwd: string, guess?: EnvironmentGuess): Promise<string[]> {
  return (await readChecksApproval(gh, repo, base, cwd, guess)).approval;
}

const checksApprovals = sharedMap<{ until: number; approval: string[] }>("checks-approvals/2");
async function cachedChecksApproval(gh: Gh, repo: string, base: string, cwd: string, now: number, guess?: EnvironmentGuess, changed?: readonly string[]): Promise<string[]> {
  const key = `${repo}@${base}${changedKey(changed)}`;
  const kept = checksApprovals.get(key);
  if (kept && now < kept.until) return kept.approval;
  const read = await readChecksApproval(gh, repo, base, cwd, guess, changed);
  checksApprovals.set(key, { until: now + (read.complete ? EXPECTED_FOR_MS : INCOMPLETE_FOR_MS), approval: read.approval });
  return read.approval;
}

export async function expectedDeploy(gh: Gh, repo: string, base: string, cwd: string, roleOf: RoleLookup): Promise<ExpectedDeploy | undefined> {
  return (await readExpectedDeploy(gh, repo, base, cwd, roleOf)).expected;
}

// Which workflows start depends on the PR's changed files (path filters), so they are part of the key.
const changedKey = (changed?: readonly string[]) => (changed ? `#${[...changed].sort().join("\n")}` : "");

/**
 * The files a PR changes, for the workflows' path filters. Undefined when there may be more than one page (GitHub
 * lists at most 3,000), so path filters are then left alone rather than judged on part of the list.
 */
export async function prChangedFiles(gh: Gh, repo: string, pr: number, cwd: string): Promise<string[] | undefined> {
  const files = JSON.parse(await gh(["api", `repos/${repo}/pulls/${pr}/files?per_page=100`], cwd)) as { filename: string; previous_filename?: string }[];
  if (files.length >= 100) return undefined;
  return [...new Set(files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]))];
}

// Read once per repo and base branch for six hours; a read with a model answer missing is kept for ten minutes, then
// asked again (reading every workflow file again on every check spent most of the REST budget).
const EXPECTED_FOR_MS = 6 * 60 * 60_000;
const INCOMPLETE_FOR_MS = 10 * 60_000;
const expectations = sharedMap<{ until: number; expected: ExpectedDeploy | undefined }>("expected-deploys/2");
async function cachedExpectedDeploy(gh: Gh, repo: string, base: string, cwd: string, roleOf: RoleLookup, now: number, changed?: readonly string[]): Promise<ExpectedDeploy | undefined> {
  const key = `${repo}@${base}${changedKey(changed)}`;
  const kept = expectations.get(key);
  if (kept && now < kept.until) return kept.expected;
  const read = await readExpectedDeploy(gh, repo, base, cwd, roleOf, changed);
  expectations.set(key, { until: now + (read.complete ? EXPECTED_FOR_MS : INCOMPLETE_FOR_MS), expected: read.expected });
  return read.expected;
}

// A run whose jobs have all finished can't change (a rerun counts as a new attempt, read through the run list).
const jobsOf = (gh: Gh, repo: string, runID: number, cwd: string): Promise<JobView[]> =>
  cached(`jobs:${repo}:${runID}`, (jobs: JobView[]) => (jobs.length > 0 && jobs.every((j) => j.status === "completed") ? 6 * 60 * 60_000 : SHARED_MS), async () => {
    const { jobs } = JSON.parse(await gh(["api", `repos/${repo}/actions/runs/${runID}/jobs?per_page=100`], cwd)) as {
      jobs: { name: string; status: string; conclusion: string | null; started_at: string }[];
    };
    return jobs.map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion ?? "", startedAt: job.started_at }));
  });

/** The runs on a commit, shared for a few seconds by the checks that ask for them. */
const runsOnCommit = (gh: Gh, repo: string, sha: string, cwd: string): Promise<{ databaseId: number; workflowName: string; workflowDatabaseId: number; status: string; event: string }[]> =>
  cached(`runs:${repo}@${sha}`, SHARED_MS, () => listRuns(gh, repo, `head_sha=${sha}`, cwd));

/**
 * Workflow runs through the REST API rather than `gh run list`, so they can be asked for conditionally (an unchanged
 * list costs nothing); in `gh run list`'s shape.
 */
async function listRuns(gh: Gh, repo: string, query: string, cwd: string, perPage = 100): Promise<(RunView & { workflowDatabaseId: number; attempt?: number })[]> {
  const { workflow_runs: runs } = JSON.parse(await gh(["api", `repos/${repo}/actions/runs?${query}&per_page=${perPage}`], cwd)) as {
    workflow_runs: { id: number; name: string; workflow_id: number; status: string; conclusion: string | null; event: string; created_at: string; html_url: string; run_attempt?: number }[];
  };
  return runs.map((run) => ({
    databaseId: run.id, workflowName: run.name, workflowDatabaseId: run.workflow_id, status: run.status, conclusion: run.conclusion ?? "",
    event: run.event, createdAt: run.created_at, url: run.html_url, ...(run.run_attempt !== undefined ? { attempt: run.run_attempt } : {}),
  }));
}

async function failedLogTail(gh: Gh, repo: string, runID: number, cwd: string): Promise<string> {
  try {
    const log = await gh(["run", "view", String(runID), "--repo", repo, "--log-failed"], cwd);
    return logTail(log, 30).map((l) => `      ${l}`).join("\n");
  } catch (err) {
    debug("tolerated-error", { what: "failed log tail", repo, run: runID, error: err });
    return "      (failed job log unavailable)";
  }
}

export async function resolveRepo(gh: Gh, cwd: string): Promise<string> {
  return (await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd)).trim();
}

export function parsePrReference(ref: string): { repo?: string; pr: number } | undefined {
  const url = ref.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (url) return { repo: url[1], pr: Number(url[2]) };
  const short = ref.trim().match(/^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/);
  if (!short) return undefined;
  return short[1] ? { repo: short[1], pr: Number(short[2]) } : { pr: Number(short[2]) };
}

export async function currentBranchPrUrl(gh: Gh, cwd: string, repo?: string): Promise<string> {
  const args = ["pr", "view", "--json", "url", "--jq", ".url", ...(repo ? ["--repo", repo] : [])];
  return (await gh(args, cwd)).trim();
}

// Manual dispatches and schedules on a PR's commit are runs of their own, not the PR's checks or merge pipeline.
const PR_EVENTS = new Set(["pull_request", "pull_request_target", "push"]);

export async function prForRun(gh: Gh, repo: string, runID: string, cwd: string): Promise<number | undefined> {
  const { headSha: sha, event }: { headSha: string; event: string } = JSON.parse(await gh(["run", "view", runID, "--repo", repo, "--json", "headSha,event"], cwd));
  if (!PR_EVENTS.has(event)) return undefined;
  const pr = (await gh(["api", `repos/${repo}/commits/${sha}/pulls`, "--jq", ".[0].number // empty"], cwd)).trim();
  return pr ? Number(pr) : undefined;
}

async function runningWorkflows(gh: Gh, repo: string, sha: string | undefined, cwd: string): Promise<string[]> {
  if (!sha) return [];
  const runs = await runsOnCommit(gh, repo, sha, cwd);
  return [...new Set(runs.filter((r) => r.status !== "completed").map((r) => r.workflowName))];
}

async function runningBaseDeploys(gh: Gh, repo: string, base: string, cwd: string): Promise<RunWithJobs[]> {
  const listed: RunView[] = await cached(`base-runs:${repo}@${base}`, SHARED_MS, () =>
    listRuns(gh, repo, `branch=${encodeURIComponent(base)}&event=push`, cwd, 20));
  const running = listed.filter((run) => run.status !== "completed");
  return Promise.all(running.map(async (run) => ({ ...run, jobs: await jobsOf(gh, repo, run.databaseId, cwd) })));
}

/** The error lines of the PR's latest failed run: on the merge commit once merged, otherwise on the head commit. */
export async function failureExcerpt(gh: Gh, repo: string, pr: number, cwd: string): Promise<string> {
  const { headRefOid, mergeCommit } = JSON.parse(await gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,mergeCommit"], cwd)) as {
    headRefOid: string;
    mergeCommit: { oid: string } | null;
  };
  const sha = mergeCommit?.oid ?? headRefOid;
  const runs: { databaseId: number; conclusion: string; event: string }[] = JSON.parse(
    await gh(["run", "list", "--repo", repo, "--commit", sha, "--json", "databaseId,conclusion,event"], cwd),
  );
  // Only the PR's own pipeline; other runs on the commit (Dependabot updates, schedules) aren't this failure.
  const ownEvent = mergeCommit ? "push" : "pull_request";
  const failed = runs.filter((r) => r.conclusion === "failure" && r.event === ownEvent).sort((a, b) => b.databaseId - a.databaseId)[0];
  if (!failed) return "";
  return runFailureExcerpt(gh, repo, failed.databaseId, cwd);
}

/** The failed jobs' steps and the end of the failed log of one run. */
export async function runFailureExcerpt(gh: Gh, repo: string, runID: number, cwd: string): Promise<string> {
  const steps = await failedJobSteps(gh, repo, runID, cwd);
  const log = logTail(await gh(["run", "view", String(runID), "--repo", repo, "--log-failed"], cwd), 150).join("\n");
  return [...steps, "", "End of the failed log:", log].join("\n");
}

export interface StandaloneRun extends RunWithJobs {
  readonly headBranch: string;
  readonly workflowDatabaseId: number;
}

export async function viewRun(gh: Gh, repo: string, runID: number, cwd: string): Promise<StandaloneRun> {
  return JSON.parse(
    await gh(["run", "view", String(runID), "--repo", repo, "--json", "databaseId,workflowName,workflowDatabaseId,event,headBranch,status,conclusion,createdAt,url,attempt,jobs"], cwd),
  );
}

/** The open PR whose branch this is, if any. */
export async function branchPr(gh: Gh, repo: string, branch: string, cwd: string): Promise<number | undefined> {
  const [found] = JSON.parse(await gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--limit", "1", "--json", "number"], cwd)) as { number: number }[];
  return found?.number;
}

/** A workflow run without a PR, as text for the model and the listing plus its facts. */
export async function runSnapshot(gh: Gh, repo: string, runID: number, cwd: string, now = Date.now()): Promise<Snapshot> {
  let run: StandaloneRun;
  try {
    run = await viewRun(gh, repo, runID, cwd);
  } catch (err) {
    debug("read-failed", { repo, run: runID, what: "run", error: err });
    return { text: `Could not read the run: ${err instanceof Error ? err.message : String(err)}` };
  }
  // A run on a branch with an open PR is shown on that PR's line; the watch itself follows only the run.
  const pr = run.headBranch ? await tolerate(debug, "the PR for the run's branch", branchPr(gh, repo, run.headBranch, cwd), undefined, { repo, run: runID }) : undefined;
  const facts = { ...runFacts(run), ...(pr !== undefined ? { forPr: pr } : {}) };
  const lines = [
    `Run: ${run.workflowName} on ${run.headBranch} (${run.url})`,
    summaryLine(facts, now),
    `started ${run.createdAt} by ${run.event}, attempt ${run.attempt ?? 1}`,
    runLine(run),
    ...run.jobs.filter((j) => j.conclusion !== "skipped").map((j) => `      job ${j.name}: ${j.status} ${j.conclusion}`.trimEnd()),
  ];
  if (facts.deploy === "FAILED") lines.push(await failedLogTail(gh, repo, run.databaseId, cwd));
  return { text: lines.join("\n"), facts };
}

// The steps of each failed job, in order: lets the model see whether the steps that ship the service succeeded before
// a later one failed.
async function failedJobSteps(gh: Gh, repo: string, runID: number, cwd: string): Promise<string[]> {
  try {
    const { jobs }: { jobs: { name: string; conclusion: string; steps?: { name: string; conclusion: string }[] }[] } = JSON.parse(
      await gh(["run", "view", String(runID), "--repo", repo, "--json", "jobs"], cwd),
    );
    return jobs
      .filter((job) => job.conclusion === "failure")
      .flatMap((job) => [`Steps of failed job ${job.name}:`, ...(job.steps ?? []).map((step) => `  ${step.name}: ${step.conclusion}`)]);
  } catch (err) {
    debug("tolerated-error", { what: "failed job steps", repo, run: runID, error: err });
    return [];
  }
}

interface PipelineRun {
  readonly databaseId: number;
  readonly workflowName: string;
  readonly workflowDatabaseId: number;
}

/** The PR's own runs still in progress: on the merge commit once merged (push), otherwise on the head commit. */
export async function runningPipelines(gh: Gh, repo: string, pr: number, cwd: string): Promise<{ event: string; runs: PipelineRun[] }> {
  const { headRefOid, mergeCommit } = JSON.parse(await gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,mergeCommit"], cwd)) as {
    headRefOid: string;
    mergeCommit: { oid: string } | null;
  };
  const event = mergeCommit ? "push" : "pull_request";
  const runs: (PipelineRun & { status: string; event: string })[] = JSON.parse(
    await gh(["run", "list", "--repo", repo, "--commit", mergeCommit?.oid ?? headRefOid, "--json", "databaseId,workflowName,workflowDatabaseId,status,event"], cwd),
  );
  return { event, runs: runs.filter((r) => r.event === event && r.status !== "completed") };
}

/** Durations of the workflow's recent successful runs. */
export async function workflowDurations(gh: Gh, repo: string, workflow: number, event: string, cwd: string): Promise<number[]> {
  const runs: { createdAt: string; updatedAt: string }[] = JSON.parse(
    await gh(
      ["run", "list", "--repo", repo, "--workflow", String(workflow), "--event", event, "--status", "success", "--limit", "20", "--json", "createdAt,updatedAt"],
      cwd,
    ),
  );
  return runs.map((r) => Date.parse(r.updatedAt) - Date.parse(r.createdAt)).filter((d) => d > 0);
}

/** Which jobs and steps of a run are running, and for how long, for the stall check. */
export async function runProgress(gh: Gh, repo: string, runID: number, cwd: string, now = Date.now()): Promise<string> {
  const { workflowName, jobs } = JSON.parse(await gh(["run", "view", String(runID), "--repo", repo, "--json", "workflowName,jobs"], cwd)) as {
    workflowName: string;
    jobs: { name: string; status: string; conclusion: string; startedAt: string; steps: { name: string; status: string; conclusion: string }[] }[];
  };
  const minutes = (since: string) => Math.round((now - Date.parse(since)) / 60_000);
  const lines = jobs
    .filter((job) => job.status !== "completed")
    .map((job) => {
      const step = job.steps.find((s) => s.status === "in_progress");
      const done = job.steps.filter((s) => s.status === "completed").length;
      return `  job ${job.name}: ${job.status} for ${minutes(job.startedAt)} min; ${done}/${job.steps.length} steps done${step ? `; running "${step.name}"` : ""}`;
    });
  return [`${workflowName}:`, ...lines].join("\n");
}

// GitHub lists a job only once it is about to run, so a building pipeline doesn't show its deploy jobs yet. Its last
// successful merge run tells whether it deploys. Cached per process: a workflow's shape rarely changes.
const deploysCache = sharedMap<boolean>("usually-deploys/1");

async function workflowUsuallyDeploys(gh: Gh, repo: string, workflow: number, cwd: string): Promise<boolean> {
  const key = `${repo}/${workflow}`;
  const cached = deploysCache.get(key);
  if (cached !== undefined) return cached;
  const last: { databaseId: number }[] = JSON.parse(
    await gh(["run", "list", "--repo", repo, "--workflow", String(workflow), "--event", "push", "--status", "success", "--limit", "1", "--json", "databaseId"], cwd),
  );
  const deploys = last[0] ? (await jobsOf(gh, repo, last[0].databaseId, cwd)).some(isDeployJob) : false;
  deploysCache.set(key, deploys);
  return deploys;
}

/**
 * The active workflows a merge into the base branch can start, read from their files on that branch. GitHub's own
 * setups (path "dynamic/...": CodeQL, Pages, Dependabot) are left out: they scan or publish docs, never deploy the
 * service. Undefined when a file can't be read or understood, so the caller keeps waiting for runs as before.
 */
export async function mergeWorkflows(gh: Gh, repo: string, base: string, cwd: string, changed?: readonly string[]): Promise<number[] | undefined> {
  const { workflows } = JSON.parse(await gh(["api", `repos/${repo}/actions/workflows`], cwd)) as { workflows: { id: number; path: string; state: string }[] };
  const files = workflows.filter((w) => w.state === "active" && w.path.startsWith(".github/"));
  const starts = await Promise.all(
    files.map(async (w) => {
      const file = await tolerate(debug, "workflow file", gh(["api", `repos/${repo}/contents/${w.path}?ref=${encodeURIComponent(base)}`, "-H", "Accept: application/vnd.github.raw"], cwd), undefined, { repo, path: w.path });
      return file === undefined ? undefined : startsOnMerge(file, base, changed);
    }),
  );
  if (starts.includes(undefined)) return undefined;
  return files.filter((_, i) => starts[i]).map((w) => w.id);
}

/** What the model needs to judge a workflow: its name, file path, job names from its latest run, and the file itself. */
export async function workflowSummary(gh: Gh, repo: string, workflowID: number, cwd: string): Promise<WorkflowSummary> {
  const { name, path } = JSON.parse(await gh(["api", `repos/${repo}/actions/workflows/${workflowID}`], cwd)) as { name: string; path: string };
  // GitHub's default setups (path "dynamic/...") have no file in the repo.
  const file = path.startsWith(".github/")
    ? await tolerate(debug, "workflow file", gh(["api", `repos/${repo}/contents/${path}`, "-H", "Accept: application/vnd.github.raw"], cwd), "", { repo, path })
    : "";
  const [latest] = JSON.parse(await gh(["run", "list", "--repo", repo, "--workflow", String(workflowID), "--limit", "1", "--json", "databaseId"], cwd)) as {
    databaseId: number;
  }[];
  const jobs = latest ? (await jobsOf(gh, repo, latest.databaseId, cwd)).map((job) => job.name) : [];
  return { name, path, jobs, file };
}

/**
 * A later successful run of a failed pipeline, on a commit that contains the merge, deployed this change too (a
 * rollout that timed out, then the next merge's run went through). Only runs whose deploy jobs actually ran count.
 */
export async function laterDeploy(
  gh: Gh,
  repo: string,
  mergeSha: string,
  base: string,
  failed: readonly { workflowDatabaseId: number; createdAt: string }[],
  cwd: string,
): Promise<{ title: string; url: string } | undefined> {
  for (const run of failed) {
    const later: { databaseId: number; headSha: string; createdAt: string; url: string; displayTitle: string }[] = JSON.parse(
      await gh(
        ["run", "list", "--repo", repo, "--workflow", String(run.workflowDatabaseId), "--branch", base, "--event", "push", "--status", "success", "--created", `${run.createdAt.slice(0, 10)}..${new Date(Date.parse(run.createdAt) + 7 * 86_400_000).toISOString().slice(0, 10)}`, "--limit", "100", "--json", "databaseId,headSha,createdAt,url,displayTitle"],
        cwd,
      ),
    );
    // The earliest one is the run that actually deployed the change.
    for (const candidate of later.filter((r) => Date.parse(r.createdAt) > Date.parse(run.createdAt)).sort((a, b) => a.databaseId - b.databaseId)) {
      const { jobs }: { jobs: { name: string; conclusion: string }[] } = JSON.parse(await gh(["run", "view", String(candidate.databaseId), "--repo", repo, "--json", "jobs"], cwd));
      if (!jobs.some((job) => isDeployJob(job as JobView) && job.conclusion === "success")) continue;
      const status = (await gh(["api", `repos/${repo}/compare/${mergeSha}...${candidate.headSha}`, "--jq", ".status"], cwd)).trim();
      if (status === "ahead" || status === "identical") return { title: candidate.displayTitle, url: candidate.url };
    }
  }
  return undefined;
}

/** The oldest run of the workflow, older than the queued one, waiting for an environment approval. */
export async function blockingRun(gh: Gh, repo: string, queued: { databaseId: number; workflowDatabaseId: number }, cwd: string): Promise<PrFacts["blockedBy"]> {
  const waiting: { databaseId: number; createdAt: string; url: string; displayTitle: string }[] = JSON.parse(
    await gh(["run", "list", "--repo", repo, "--workflow", String(queued.workflowDatabaseId), "--status", "waiting", "--limit", "20", "--json", "databaseId,createdAt,url,displayTitle"], cwd),
  );
  const oldest = waiting.filter((run) => run.databaseId < queued.databaseId).sort((a, b) => a.databaseId - b.databaseId)[0];
  return oldest ? { title: oldest.displayTitle, url: oldest.url, since: Date.parse(oldest.createdAt) } : undefined;
}

// A finished job's log never changes; a rerun gets new job ids.
const planCache = sharedMap<string | null>("plans/1");

/** Terraform plan summaries from the PR's finished jobs; each job's log is read once. */
export async function finishedRunPlans(gh: Gh, repo: string, rollup: readonly CheckView[], cwd: string): Promise<{ plans: TerraformPlan[]; complete: boolean }> {
  const plans: TerraformPlan[] = [];
  let complete = true;
  for (const check of pipelineChecks(rollup)) {
    const job = check.detailsUrl?.match(/\/actions\/runs\/\d+\/job\/(\d+)/)?.[1];
    if (!job || (check.status ?? "").toUpperCase() !== "COMPLETED") continue;
    const key = `${repo}:${job}`;
    if (!planCache.has(key)) {
      let log: string | undefined;
      try {
        log = await gh(["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${job}/logs`], cwd);
      } catch (err) {
        debug("tolerated-error", { what: "job log for the plan summary", repo, job, error: err });
        // A deleted (410) or missing (404) log stays that way; asking again on every check won't bring it back.
        if (/HTTP 4(04|10)/.test(err instanceof Error ? err.message : String(err))) planCache.set(key, null);
        else complete = false;
        continue;
      }
      planCache.set(key, planSummary(log) ?? null);
    }
    const summary = planCache.get(key);
    if (summary) plans.push({ job: checkName(check), summary });
  }
  return { plans, complete };
}

const MY_PR_FIELDS = "repository,number,title,url,isDraft,createdAt,closedAt";

/** Open PRs the gh user created, in every repo. */
export async function myOpenPrs(gh: Gh, cwd: string): Promise<MyPr[]> {
  const raw: SearchedPr[] = JSON.parse(await gh(["search", "prs", "--author", "@me", "--state", "open", "--limit", "200", "--json", MY_PR_FIELDS], cwd));
  return raw.map(myPrFrom);
}

/** PRs the gh user created that merged on or after the given day (YYYY-MM-DD). */
export async function myMergedPrs(gh: Gh, since: string, cwd: string): Promise<MyPr[]> {
  const raw: SearchedPr[] = JSON.parse(
    await gh(["search", "prs", "--author", "@me", "--merged", "--merged-at", `>=${since}`, "--limit", "200", "--json", MY_PR_FIELDS], cwd),
  );
  return raw.map(myPrFrom);
}

/**
 * The PR's check runs that are queued with no jobs behind an older run of their workflow waiting for run approval
 * (one run per workflow at a time), with the run ahead of each.
 */
export async function blockedChecks(gh: Gh, repo: string, headSha: string, cwd: string): Promise<NonNullable<PrFacts["blockedChecks"]>> {
  const runs = await runsOnCommit(gh, repo, headSha, cwd);
  const queued = runs.filter((run) => ["pending", "queued", "requested"].includes(run.status));
  const blocked = await Promise.all(
    queued.map(async (run) => {
      if ((await jobsOf(gh, repo, run.databaseId, cwd)).length > 0) return undefined;
      const ahead = await blockingRun(gh, repo, { databaseId: run.databaseId, workflowDatabaseId: run.workflowDatabaseId }, cwd);
      return ahead ? { workflow: run.workflowName, ...ahead } : undefined;
    }),
  );
  return blocked.filter((b): b is NonNullable<typeof b> => b !== undefined);
}

// The plugin switches the shared cache on; without it (tests, scripts) every call is made.
let callCache: CallCache | undefined;
export const useCallCache = (cache: CallCache | undefined) => void (callCache = cache);
// What is still changing (run lists, a running run's jobs) is only shared by calls on their way at the same moment, never
// kept: keeping a running run's jobs for 20 s while its run list was fresh showed a finished run with a job still running.
// Asking each time is free when nothing changed (ETag, 304).
const SHARED_MS = 0;
function cached<T>(key: string, ttlMs: number | ((value: T) => number), read: () => Promise<T>): Promise<T> {
  return callCache ? callCache.get(key, ttlMs, read) : read();
}

const reviewSearch = async (gh: Gh, search: string, cwd: string) =>
  JSON.parse(await gh(["api", "graphql", "-f", `query=${REVIEW_SEARCH_QUERY}`, "-f", `q=${search}`], cwd));

/** The open PRs whose review is requested from the gh user, and those that need a review in their favourite repos. */
export async function reviewRequests(gh: Gh, me: string, cwd: string, favourites: readonly string[] = []): Promise<ReviewRequest[]> {
  const [requested, ...others] = await Promise.all([
    reviewSearch(gh, REQUESTED_SEARCH, cwd).then((answer) => reviewRequestsFrom(answer, me)),
    ...favouriteSearches(favourites).map((search) => reviewSearch(gh, search, cwd).then((answer) => reviewRequestsFrom(answer, me, false))),
  ]);
  return mergeReviews(requested!, others.flat());
}

const SUBMITTED: Record<ReviewEvent, string> = { APPROVE: "Approved", COMMENT: "Commented on", REQUEST_CHANGES: "Requested changes on" };

/**
 * Submits the user's review on the commit they reviewed. Reads the PR's head first and refuses when it moved on, so an
 * approval never covers commits the user didn't see. Returns what was done.
 */
export async function submitReview(gh: Gh, input: { readonly repo: string; readonly number: number; readonly event: ReviewEvent; readonly body: string; readonly sha: string }, cwd: string): Promise<string> {
  const head = (await gh(["pr", "view", String(input.number), "--repo", input.repo, "--json", "headRefOid", "--jq", ".headRefOid"], cwd)).trim();
  const stale = staleHead(input.sha, head);
  if (stale) throw new Error(stale);
  await gh(reviewArgs(input.repo, input.number, input.event, input.body, input.sha), cwd);
  return `${SUBMITTED[input.event]} ${input.repo}#${input.number}.`;
}

/** The organisation's repos that aren't archived, as owner/name. */
export async function orgRepos(gh: Gh, org: string, cwd: string): Promise<string[]> {
  const text = await gh(["repo", "list", org, "--no-archived", "--limit", "1000", "--json", "nameWithOwner", "--jq", ".[].nameWithOwner"], cwd);
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}
