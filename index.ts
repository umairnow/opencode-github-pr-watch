import { analysedLines, commentPrompt, parseCommentAnalysis } from "./core/comment-analysis";
import { PR_BATCHER_VERSION, PrBatcher } from "./core/pr-batch";
import { enqueue, flushOutbox, registerDeliverer, releaseDeliverer, type Queued } from "./core/outbox";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileDebugLog, noDebugLog, tolerate, type DebugLog } from "./core/debug-log";
import { dispatchedRun, findWorkflowDispatches, runFromOutput, type Dispatch } from "./core/dispatch";
import { parseRunReference, runWatchID } from "./core/run-facts";
import { attachedRun, alreadyFinished } from "./core/attached-runs";
import { automaticStartAllowed, dropUnwatched, freshTrigger, isOrphaned, keepExisting, stillWanted, keepConcurrentChanges } from "./core/lifecycle";
import { PrWatch } from "./rpc";
import { sessionGroups, watchRows } from "./core/watch-rows";
import type { MyPr } from "./core/my-prs";
import { parsePlacements, parseTopics, placePrompt, prID, topicPlan, topicsPrompt, type Topic } from "./core/topics";
import { alignedDelay } from "./core/policy";
import { GH_MISSING, noWatchMessage } from "./core/gh-binary";
import { parseReplacement, replacementPrompt, type Candidate } from "./core/replacement";
import { Plugin } from "@opencode/plugin";
import { botAdvicePrompt, countRun, failureExpired, seenFailures, diagnosisPrompt, parseBotAdvice, parseDiagnosis, refreshHistory } from "./core/advice";
import { limitFromDurations, parseStallVerdict, stallPrompt } from "./core/timing";
import { environmentsPrompt, matchWorkflow, parseEnvironments, parseRole, rolePrompt, type WorkflowRole } from "./core/workflow-role";
import { configureGh, githubPaused, myMergedPrs, myOpenPrs, setGithubDebug, workflowSummary, type EnvironmentGuess, type RoleLookup, currentBranchPrUrl, failureExcerpt, runFailureExcerpt, runSnapshot, viewRun, runningPipelines, runProgress, workflowDurations, parsePrReference, prForRun, prSnapshot, resolveRepo, runGh, quickSnapshot, runGhFirst, type ReadPr, useCallCache, reviewRequests, submitReview, orgRepos } from "./core/github";
import { repoName, type ReviewEvent, type ReviewRequest } from "./core/review-requests";
import { findBranchUpdates, findPrMerges, findRunReruns , alreadyUpToDate , findBotRefreshes, commandDirectory, findGitPushes, findPrCreates, prUrlsIn } from "./core/merge-detection";
import { formatWatch } from "./core/listing";
import { beginCheck, claimOrphan, claimPolling, endCheck, dropMessagesFor, handToOwner, onCheckNow, ownsPolling, processState, releasePolling, requestChecks, resumeChanged, shouldAnnounceResume } from "./core/runtime";
import { messageKey, shouldSend } from "./core/dedupe";
import { resumedMessage, startFailed, startingMessage, startResult, watchStartedMessage } from "./core/messages";
import { pinProvider, resolveJudgeModel, type ModelRef, type SessionView } from "./core/model-guard";
import { awaitTrigger, tick, type Snapshot, type Watch, type WatchPorts, type WatchSettings, SNAPSHOT_VERSION } from "./core/watcher";
import { summaryLine, type PrFacts, setBookkeepingJobs } from "./core/pr-facts";
import { batchLabel, batchProgress, composeDigest, parsePrReferences, replaceMember, withoutMember, type Batch } from "./core/batch";
import { phaseOf, pollDelay, startDecision, type Trigger } from "./core/policy";

interface PrWatchOptions {
  /** Ordered substrings matched against model IDs from the session's own provider. */
  preferences?: string[];
  /** Report a deploy job as stuck after it has been unfinished this long. Default 30. */
  stuckMinutes?: number;
  /** Hand back when a build, auto-merge or deploy hasn't moved on after this long. Default 30. */
  maxMinutes?: number;
  /** Full path to gh, when it isn't on OpenCode's PATH or in /opt/homebrew/bin or /usr/local/bin. */
  ghPath?: string;
  /** Write a JSON-lines debug log of what each watch saw and decided: true (default, ~/.local/state/opencode-github-pr-watch/debug.jsonl), false, or a path. */
  debugLog?: boolean | string;
  /** Names of jobs that only detect changes or report a status (monorepo bookkeeping). Defaults cover common names. */
  bookkeepingJobs?: string[];
  /** Let the light model read new comments' text and summarise them for the session. Default false: see the warning in docs/configuration.md. */
  analyseComments?: boolean;
}

const ERROR_RETRY_MS = 60_000;
const BUSY_RETRY_MS = 15_000;

const phaseFields = (facts: PrFacts, now: number) => {
  const current = phaseOf(facts, now);
  return "phase" in current ? { phase: current.phase, phaseSince: now } : {};
};
// As long as a round of checks: everything one round says to a session comes as one message.
const DIGEST_WINDOW_MS = 30_000;
// A post to a session that hasn't answered in this time is taken as lost (its instance may have been disposed).
const DELIVERY_TIMEOUT_MS = 30_000;
const DELIVERY_RETRY_MS = 60_000;
const ROLE_WAIT_MS = 15_000;
const BATCH_PREFIX = "batch/";

const DEFAULT_PREFERENCES = ["haiku", "mini", "flash"];
const KEY_PREFIX = "watch/";
const RESUMED_PREFIX = "resumed/";
const optional = (unwatchedAt: number | undefined) => (unwatchedAt === undefined ? {} : { unwatchedAt });

export default Plugin.define({
  id: "pr-watch",
  async setup(ctx) {
    const options = ctx.options as PrWatchOptions;
    const directory = ctx.location.directory;
    const debug: DebugLog =
      options.debugLog === false
        ? noDebugLog
        : fileDebugLog(typeof options.debugLog === "string" ? options.debugLog : join(homedir(), ".local", "state", "opencode-github-pr-watch", "debug.jsonl"));
    debug("setup", { directory });
    // A model answer the code couldn't fully use: what was asked, which model, what was wrong, and what it said.
    const badAnswer = (call: string, model: { providerID: string; id: string }, text: string, fields: Record<string, unknown> = {}) => (problem: string) =>
      debug("model-answer-invalid", { call, model: `${model.providerID}/${model.id}`, problem, answer: text.slice(0, 1_000), ...fields });
    setGithubDebug(debug);
    setBookkeepingJobs(options.bookkeepingJobs);
    if (!(await configureGh(options.ghPath))) {
      console.error(`[pr-watch] ${GH_MISSING}; no PR can be watched until it is`);
      debug("gh-missing", { directory });
    }
    // A workflow's role (part of shipping the service, or docs/scans/analysis) is judged once by the guarded model and
    // stored per repo. Without a model it stays unknown and the job-based rules apply.
    // A slow first judgement must not hold up a watch: past the wait it goes on in the background and is stored for
    // the next poll, and the job-based rules apply until then.
    const judging = new Map<string, Promise<WorkflowRole | undefined>>();
    const cachedRoleLookup = (repo: string, cwd: string, model: ModelRef): RoleLookup => async (workflowID) => {
      const key = `workflow-role/${repo}/${workflowID}`;
      const stored = (await ctx.storage.get(key)) as WorkflowRole | undefined;
      if (stored) return stored;
      // The agent said this repo doesn't deploy: no roles, so the job-based rules decide.
      if (await ctx.storage.get(`no-deploy/${repo}`)) return undefined;
      let pending = judging.get(key);
      if (!pending) {
        pending = (async () => {
          const answer = await ctx.generate.text({
            prompt: rolePrompt(await workflowSummary(runGh, repo, workflowID, cwd)),
            model: { providerID: model.providerID, id: model.id },
          });
          const role = parseRole(answer.text, badAnswer("workflow role", model, answer.text, { repo, workflow: workflowID }));
          if (role) await ctx.storage.set(key, role);
          return role;
        })().finally(() => judging.delete(key));
        judging.set(key, pending);
      }
      return Promise.race([pending, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ROLE_WAIT_MS))]);
    };

    const roleLookup = async (repo: string, cwd: string, sessionID: string, pinned: Watch["pinned"]): Promise<RoleLookup | undefined> => {
      const resolved = resolveJudgeModel({
        pinned,
        session: await sessionView(sessionID),
        pluginDirectory: directory,
        catalog: await tolerate(debug, "model catalog", ports.catalog(), []),
        preferences: settings.preferences,
      });
      return resolved.ok ? cachedRoleLookup(repo, cwd, resolved.model) : undefined;
    };

    // The environments a workflow file uses for a pull request, when it sets them by an expression: the guarded
    // model reads the file once, and the answer is stored per file content.
    const environmentGuess = (cwd: string, model: ModelRef): EnvironmentGuess => async (file, base) => {
      const key = `workflow-envs/${createHash("sha256").update(`${base}\n${file}`).digest("hex").slice(0, 16)}`;
      const stored = (await ctx.storage.get(key)) as string[] | undefined;
      if (stored) return stored;
      const answer = await ctx.generate.text({ prompt: environmentsPrompt(file, base), model: { providerID: model.providerID, id: model.id } });
      const names = parseEnvironments(answer.text, badAnswer("workflow environments", model, answer.text, { cwd }));
      if (names) await ctx.storage.set(key, names as never);
      return names;
    };
    const guessLookup = async (cwd: string, sessionID: string, pinned: Watch["pinned"]): Promise<EnvironmentGuess | undefined> => {
      const resolved = resolveJudgeModel({
        pinned,
        session: await sessionView(sessionID),
        pluginDirectory: directory,
        catalog: await tolerate(debug, "model catalog", ports.catalog(), []),
        preferences: settings.preferences,
      });
      return resolved.ok ? environmentGuess(cwd, resolved.model) : undefined;
    };

    // Set with watch_pr's deployWorkflow="none": the repo deploys nothing, so a merge ends the watch.
    const marksNoDeploy = async (repo: string) => Boolean(await ctx.storage.get(`no-deploy/${repo}`));

    const settings: WatchSettings = {
      pluginDirectory: directory,
      preferences: options.preferences ?? DEFAULT_PREFERENCES,
      stuckMs: (options.stuckMinutes ?? 30) * 60_000,
      pipelineLimitMs: (options.maxMinutes ?? 30) * 60_000,
      analyseComments: options.analyseComments === true,
    };

    const sessionView = async (sessionID: string): Promise<SessionView> => {
      const session = await ctx.session.get({ sessionID });
      return { directory: session.location.directory, model: session.model };
    };

    const snapshotOf = async (watch: Watch) =>
      watch.run
        ? runSnapshot(runGh, watch.repo, watch.run, watch.pinned.directory)
        : withAttachedRuns(
            watch,
            await prSnapshot(runGh, watch.repo, watch.pr, watch.pinned.directory, Date.now(), await roleLookup(watch.repo, watch.pinned.directory, watch.sessionID, watch.pinned), await marksNoDeploy(watch.repo), await guessLookup(watch.pinned.directory, watch.sessionID, watch.pinned), readPr("background"), watch.lastFacts),
          );
    // Runs on the PR's branch followed in its watch. Only their state goes into the text: every finished job would
    // otherwise be a change for the model to judge. A run that can't be read is left out this time and stays attached.
    const withAttachedRuns = async (watch: Watch, snapshot: Snapshot): Promise<Snapshot> => {
      if (!watch.runs?.length || !snapshot.facts) return snapshot;
      const read = await Promise.all(
        watch.runs.map((run) => tolerate(debug, "attached run", viewRun(runGh, watch.repo, run, watch.pinned.directory), undefined, { id: watch.id, run })),
      );
      const runs = read.filter((run): run is NonNullable<typeof run> => run !== undefined).map(attachedRun);
      return {
        text: [snapshot.text, "runs on the PR's branch:", ...runs.map((run) => `  - ${run.workflow}: ${run.state} ${run.url}`)].join("\n"),
        facts: { ...snapshot.facts, attachedRuns: runs },
      };
    };
    // The watched PR in this session whose branch the run ran on, if any.
    const watchedPrForRun = async (repo: string, runID: number, sessionID: string, cwd: string): Promise<Watch | undefined> => {
      const run = await viewRun(runGh, repo, runID, cwd);
      const number = (await runGh(["pr", "list", "--repo", repo, "--head", run.headBranch, "--state", "open", "--json", "number", "--jq", ".[0].number // empty"], cwd)).trim();
      if (!number) return undefined;
      const existing = (await ctx.storage.get(KEY_PREFIX + `${repo}#${number}`)) as unknown as Watch | undefined;
      return existing && existing.sessionID === sessionID ? existing : undefined;
    };
    // A run watch follows that one run; a PR watch the runs on its head or merge commit.
    const pipelinesOf = async (watch: Watch) => {
      if (!watch.run) return runningPipelines(runGh, watch.repo, watch.pr, watch.pinned.directory);
      const run = await viewRun(runGh, watch.repo, watch.run, watch.pinned.directory);
      return { event: run.event, runs: run.status === "completed" ? [] : [run] };
    };

    // Bots split one update into several PRs; the diagnosis needs the others to recognise a half-applied one.
    const openFromSameBot = async (watch: Watch): Promise<string[]> => {
      if (watch.run || !watch.lastFacts?.authorIsBot || !watch.lastFacts.author) return [];
      const open: { number: number; title: string }[] = JSON.parse(
        await tolerate(debug, "the bot's other open PRs", runGh(["pr", "list", "--repo", watch.repo, "--author", watch.lastFacts.author, "--state", "open", "--limit", "30", "--json", "number,title"], watch.pinned.directory), "[]", { id: watch.id }),
      );
      return open.filter((pr) => pr.number !== watch.pr).map((pr) => `#${pr.number} ${pr.title}`);
    };

    const ports: WatchPorts = {
      debug,
      snapshot: snapshotOf,
      session: sessionView,
      catalog: async () => (await ctx.model.list({ location: { directory } })).data,
      // generate.text always runs in this plugin instance's location; the guard has already required that the
      // session and the pinned directory are that same location, so the provider config and credentials match.
      judge: async (model, _judgeDirectory, prompt) =>
        (await ctx.generate.text({ prompt, model: { providerID: model.providerID, id: model.id } })).text,
      diagnose: async (model, watch) => {
        const excerpt = watch.run
          ? await runFailureExcerpt(runGh, watch.repo, watch.run, watch.pinned.directory)
          : await failureExcerpt(runGh, watch.repo, watch.pr, watch.pinned.directory);
        if (!excerpt) return undefined;
        const answer = await ctx.generate.text({ prompt: diagnosisPrompt(excerpt, await openFromSameBot(watch)), model: { providerID: model.providerID, id: model.id } });
        return parseDiagnosis(answer.text, badAnswer("diagnosis", model, answer.text, { id: watch.id }));
      },
      phaseLimit: async (watch) => {
        const { event, runs } = await pipelinesOf(watch);
        const workflows = [...new Set(runs.map((r) => r.workflowDatabaseId))];
        const fallback = settings.pipelineLimitMs ?? 30 * 60_000;
        if (workflows.length === 0) return undefined;
        // The slowest of the workflows still running decides how long the phase may take.
        const limits = await Promise.all(
          workflows.map(async (w) => limitFromDurations(await workflowDurations(runGh, watch.repo, w, event, watch.pinned.directory), fallback)),
        );
        return limits.reduce((a, b) => (b.limitMs > a.limitMs ? b : a));
      },
      analyseComments: async (model, watch, comments) => {
        // The text is read here and only goes to the model; the session gets the model's plain-language lines.
        const query = `query($ids: [ID!]!) { nodes(ids: $ids) { id ... on PullRequestReviewComment { body line originalLine } ... on IssueComment { body } } }`;
        const answer = JSON.parse(
          await runGh(["api", "graphql", "-f", `query=${query}`, ...comments.flatMap((c) => ["-f", `ids[]=${c.id}`])], watch.pinned.directory),
        ) as { data: { nodes: ({ id: string; body?: string; line?: number | null; originalLine?: number | null } | null)[] } };
        const byId = new Map(answer.data.nodes.filter((n) => n !== null).map((n) => [n!.id, n!] as const));
        const toRead = comments.flatMap((c) => {
          const node = byId.get(c.id);
          if (!node?.body) return [];
          const line = node.line ?? node.originalLine ?? undefined;
          return [{ author: c.author, ...(c.path ? { path: c.path } : {}), ...(line ? { line } : {}), url: c.url, body: node.body.slice(0, 4_000) }];
        });
        if (toRead.length === 0) return undefined;
        const reply = await ctx.generate.text({ prompt: commentPrompt(toRead), model: { providerID: model.providerID, id: model.id } });
        const analysis = parseCommentAnalysis(reply.text, toRead.length, badAnswer("comments", model, reply.text, { id: watch.id }));
        return analysis ? analysedLines(toRead, analysis) : undefined;
      },
      evaluateStall: async (model, watch, _facts, basis) => {
        const { runs } = await pipelinesOf(watch);
        if (runs.length === 0) return undefined;
        const progress = (await Promise.all(runs.map((r) => runProgress(runGh, watch.repo, r.databaseId, watch.pinned.directory)))).join("\n");
        const answer = await ctx.generate.text({ prompt: stallPrompt(progress, basis), model: { providerID: model.providerID, id: model.id } });
        return parseStallVerdict(answer.text, badAnswer("stall", model, answer.text, { id: watch.id }));
      },
      lastAutoMergeActor: async (watch) => {
        const login = await runGh(
          ["api", `repos/${watch.repo}/issues/${watch.pr}/events?per_page=100`, "--jq", '[.[] | select(.event == "auto_merge_disabled")] | last | .actor.login // empty'],
          watch.pinned.directory,
        );
        return login.trim() || undefined;
      },
      adviseBot: async (model, watch, situation) => {
        const { body, author, comments, commits } = JSON.parse(
          await runGh(["pr", "view", String(watch.pr), "--repo", watch.repo, "--json", "body,author,comments,commits"], watch.pinned.directory),
        ) as { body: string; author: { login: string }; comments: { body: string; createdAt: string }[]; commits: { committedDate: string }[] };
        // A bot force-pushes its refresh, so replaced commits vanish from the PR; the timeline keeps each push.
        const pushes = (
          await tolerate(debug, "force-push times", runGh(["api", `repos/${watch.repo}/issues/${watch.pr}/timeline?per_page=100`, "--jq", '.[] | select(.event == "head_ref_force_pushed") | .created_at'], watch.pinned.directory), "", { id: watch.id })
        ).split("\n").filter(Boolean).map((time) => Date.parse(time));
        const history = refreshHistory(comments, [...commits.map((c) => Date.parse(c.committedDate)), ...pushes], Date.now());
        const answer = await ctx.generate.text({ prompt: botAdvicePrompt(author.login, situation, body, history), model: { providerID: model.providerID, id: model.id } });
        return parseBotAdvice(answer.text, badAnswer("bot advice", model, answer.text, { id: watch.id }));
      },
      replacementFor: async (model, watch) => {
        const view = JSON.parse(
          await runGh(["pr", "view", String(watch.pr), "--repo", watch.repo, "--json", "comments,headRefName,title,author"], watch.pinned.directory),
        ) as { comments: { body: string }[]; headRefName: string; title: string; author: { login: string } };
        const comments = view.comments.slice(-5).map((c) => c.body.slice(0, 500));
        const open = JSON.parse(
          await runGh(["pr", "list", "--repo", watch.repo, "--author", view.author.login, "--state", "open", "--limit", "50", "--json", "number,title,headRefName"], watch.pinned.directory),
        ) as Candidate[];
        const prompt = replacementPrompt({ title: view.title, branch: view.headRefName }, comments, open);
        const answer = await ctx.generate.text({ prompt, model: { providerID: model.providerID, id: model.id } });
        return parseReplacement(answer.text, open, comments, badAnswer("replacement", model, answer.text, { id: watch.id }));
      },
      countFailure: async (id, signature, failureKey) => {
        const facts = ((await ctx.storage.get(KEY_PREFIX + id)) as unknown as Watch | undefined)?.lastFacts;
        const key = `failures/${id}/${facts?.headSha ?? "merged"}/${signature}`;
        const stored = await ctx.storage.get(key);
        const { before, seen } = countRun(seenFailures(stored), failureKey);
        await ctx.storage.set(key, { seen, at: Date.now() } as never);
        return before;
      },
      notify: async (sessionID, text, wake = false) => {
        const key = messageKey(sessionID, text);
        const now = Date.now();
        if (!shouldSend((await ctx.storage.get(key)) as number | undefined, now)) return;
        await ctx.storage.set(key, now);
        collect(sessionID, text, wake);
      },
      current: async (watch) => {
        const stored = (await ctx.storage.get(KEY_PREFIX + watch.id)) as unknown as Watch | undefined;
        if (!stored || stored.token !== watch.token) return { owned: false };
        const live = await snapshotOf(watch);
        return live.facts ? { owned: true, facts: live.facts } : { owned: true };
      },
      now: () => Date.now(),
    };

    // Messages arriving close together (typically a batch of PRs changing at once) are sent as one digest.
    // A digest wakes the agent when any message in it asks to.
    const collect = (sessionID: string, text: string, wake: boolean) => {
      if (enqueue(processState().outbox, sessionID, text, wake)) setTimeout(() => void flush(sessionID), DIGEST_WINDOW_MS);
    };

    const batchesFor = async (messages: string[]) => {
      const ids = new Set(messages.map((m) => m.slice(0, m.indexOf(": "))));
      const { entries } = await ctx.storage.scan({ prefix: BATCH_PREFIX });
      return entries.map((e) => ({ key: e.key, batch: e.value as unknown as Batch })).filter(({ batch }) => batch.members.some((m) => ids.has(m)));
    };

    const forgetOldSends = async () => {
      const now = Date.now();
      const { entries } = await ctx.storage.scan({ prefix: "sent/" });
      for (const entry of entries) if (shouldSend(entry.value as number, now)) await ctx.storage.remove(entry.key);
      for (const entry of await scanAll("failures/")) if (failureExpired(entry.value, now)) await ctx.storage.remove(entry.key);
    };

    // Runs in whichever instance queued the messages, possibly one already replaced; the posting itself goes through
    // the newest live instance's deliverer.
    const flush = async (sessionID: string) => {
      try {
        const result = await flushOutbox(processState().outbox, sessionID, DELIVERY_TIMEOUT_MS);
        if (result === "retry") {
          debug("deliver-retry", { sessionID, retryMs: DELIVERY_RETRY_MS });
          setTimeout(() => void flush(sessionID), DELIVERY_RETRY_MS);
        }
      } catch (err) {
        console.error("[pr-watch] could not deliver messages:", err);
        debug("deliver-failed", { sessionID, error: err instanceof Error ? err.message : String(err) });
      }
    };

    const deliverQueued = async (sessionID: string, entry: Queued) => {
      void tolerate(debug, "cleaning up old sends and failure counts", forgetOldSends(), undefined);
      debug("deliver", { sessionID, messages: entry.messages.length, attempt: entry.attempts + 1 });
      // Another plugin instance may have queued these before the unwatch reached this one.
      const unwatched = new Map(
        (await scanAll(`unwatched/${sessionID}/`)).map((e) => [e.key.slice(`unwatched/${sessionID}/`.length), e.value as number] as const),
      );
      const kept = dropUnwatched(entry.messages, unwatched);
      if (kept.length < entry.messages.length) debug("deliver-dropped", { sessionID, reason: "unwatched", messages: entry.messages.filter((m) => !kept.includes(m)) });
      if (kept.length === 0) return;
      const now = Date.now();
      const batches = await batchesFor(kept);
      const progress = batches.map(({ batch }) => batchProgress(batch.label, batch.members.map((m) => batch.facts[m]), now));
      const digest = composeDigest(kept, progress);
      await ctx.session.synthetic({ sessionID, text: `[pr-watch] ${digest}`, delivery: "queue", resume: entry.wake });
      debug("delivered", { sessionID, messages: kept.length, wake: entry.wake });
      await removeFinishedBatches();
    };

    // Applies a change to every stored batch; one left with no members is removed.
    const updateBatches = async (change: (batch: Batch) => Batch) => {
      const { entries } = await ctx.storage.scan({ prefix: BATCH_PREFIX });
      for (const entry of entries) {
        const before = entry.value as unknown as Batch;
        const after = change(before);
        if (after === before) continue;
        if (after.members.length === 0) await ctx.storage.remove(entry.key);
        else await ctx.storage.set(entry.key, after as never);
      }
    };

    const removeFinishedBatches = async () => {
      const { entries } = await ctx.storage.scan({ prefix: BATCH_PREFIX });
      for (const entry of entries) {
        const batch = entry.value as unknown as Batch;
        const watched = await Promise.all(batch.members.map((m) => ctx.storage.get(KEY_PREFIX + m)));
        if (watched.every((w) => !w)) await ctx.storage.remove(entry.key);
      }
    };

    // Keep every live batch that includes this PR current, also from a separate watch (for example the deploy watch
    // after a merge), so the progress line never contradicts the message it is attached to.
    const recordBatchFacts = async (watch: Watch) => {
      if (!watch.lastFacts) return;
      const { entries } = await ctx.storage.scan({ prefix: BATCH_PREFIX });
      for (const entry of entries) {
        const batch = entry.value as unknown as Batch;
        if (!batch.members.includes(watch.id)) continue;
        await ctx.storage.set(entry.key, { ...batch, facts: { ...batch.facts, [watch.id]: watch.lastFacts } } as never);
      }
    };

    // Both plugin instances see the same command; only the first reports that it couldn't start a watch.
    const informOnce = async (sessionID: string, text: string) => {
      const key = messageKey(sessionID, text);
      const last = (await ctx.storage.get(key)) as number | undefined;
      if (last !== undefined && Date.now() - last < 60_000) return;
      await ctx.storage.set(key, Date.now());
      await inform(sessionID, text);
    };

    const inform = async (sessionID: string, text: string) => deliver(sessionID, text, false);
    // Waking the agent (resume) is for what it has to act on.
    const deliver = async (sessionID: string, text: string, wake: boolean) => {
      await ctx.session.synthetic({ sessionID, text: `[pr-watch] ${text}`, delivery: "queue", resume: wake });
    };

    // One poll loop per directory and process: this instance takes it over from any earlier instance.
    const shared = processState();
    const owner = Symbol(directory);
    const timers = claimPolling(shared, directory, owner);
    // Every stored watch of the directory, not only those with a timer, so a watch that missed its loop is picked up.
    onCheckNow(
      shared,
      directory,
      owner,
      () => void tolerate(debug, "check now", directoryWatches().then((watches) => watches.forEach((w) => schedule(w.id, 0))), undefined),
      (id, delayMs) => schedule(id, delayMs),
    );
    const owning = () => ownsPolling(shared, directory, owner);
    // Shared by every instance in the process, so PRs checked at the same moment share one call whichever directory they're in.
    useCallCache(shared.callCache);
    // Kept across reloads like the rest of the process state, but replaced when the batcher's code changes.
    if (shared.prReaders?.version !== PR_BATCHER_VERSION) {
      shared.prReaders = { version: PR_BATCHER_VERSION, first: new PrBatcher(runGhFirst, 200), background: new PrBatcher(runGh, 1_000) };
    }
    const readPr = (priority: "first" | "background"): ReadPr => (repo, pr, cwd) => processState().prReaders![priority].read(repo, pr, cwd);
    registerDeliverer(shared.outbox, owner, deliverQueued);

    const topicCache = new Map<string, Promise<Topic[]>>();
    // The gh user, to tell their PRs from others' among the watched ones; read once.
    let login: Promise<string> | undefined;
    const ghUser = () => {
      login ??= shared.callCache.get("gh-user", 6 * 60 * 60_000, () => runGh(["api", "user", "--jq", ".login"], directory).then((text) => text.trim()));
      login.catch(() => (login = undefined));
      return login;
    };
    // The last topics made with each model: new PRs join them rather than starting a whole new grouping.
    // Stored, so the first load after a restart keeps the grouping instead of making a new one.
    const lastTopics = {
      get: async (modelKey: string) => (await ctx.storage.get(`topics/${modelKey}`)) as readonly Topic[] | undefined,
      set: (modelKey: string, topics: readonly Topic[]) => ctx.storage.set(`topics/${modelKey}`, topics as never),
    };
    const searches = new Map<string, { at: number; prs: Promise<MyPr[]> }>();
    let reviewSearch: { at: number; key: string; prs: Promise<ReviewRequest[]> } | undefined;
    const cachedSearch = (key: string, search: () => Promise<MyPr[]>) => {
      const cached = searches.get(key);
      if (cached && Date.now() - cached.at < 60_000) return cached.prs;
      const prs = search();
      searches.set(key, { at: Date.now(), prs });
      // A failed search isn't kept: the next ask tries again.
      prs.catch(() => searches.delete(key));
      return prs;
    };

    const registration = await ctx.rpc.register(PrWatch, {
      list: async (input) => {
        const { sessionID } = input as { sessionID: string };
        const { entries } = await ctx.storage.scan({ prefix: KEY_PREFIX });
        return { watches: watchRows(entries.map((e) => e.value as unknown as Watch), sessionID, Date.now()) };
      },
      // Every session's watches, for the side panel. A title that can't be read (a deleted session) shows the id.
      listAll: async () => {
        const { entries } = await ctx.storage.scan({ prefix: KEY_PREFIX });
        const watches = entries.map((e) => e.value as unknown as Watch);
        const groups = sessionGroups(watches, Date.now());
        const sessions = await Promise.all(
          groups.map(async (group) => {
            const session = await tolerate(debug, "session title", ctx.session.get({ sessionID: group.sessionID }), undefined, { sessionID: group.sessionID });
            return {
              ...group,
              title: session?.title || group.sessionID,
              ...(session ? { directory: session.location.directory } : {}),
            };
          }),
        );
        return { sessions };
      },
      // The gh user's own PRs for the side panel. Search results are kept a minute, as every open panel asks.
      checkNow: async () => {
        const checking = requestChecks(shared, Date.now());
        debug("check-now", { checking });
        return { checking };
      },
      // Kept a minute like the other searches: every open panel asks.
      reviewRequests: async (input) => {
        const favourites = ((input as { favourites?: string[] }).favourites ?? []).filter((repo) => repoName(repo) === repo);
        const me = await ghUser();
        const key = favourites.join(",");
        if (!reviewSearch || reviewSearch.key !== key || Date.now() - reviewSearch.at >= 60_000) {
          const prs = reviewRequests(runGh, me, directory, favourites);
          reviewSearch = { at: Date.now(), key, prs };
          // A failed search isn't kept: the next ask tries again.
          prs.catch(() => (reviewSearch = undefined));
        }
        return { prs: await reviewSearch.prs };
      },
      // Repos change rarely: each organisation's list is kept an hour.
      orgRepos: async (input) => {
        const { orgs } = input as { orgs: string[] };
        const lists = await Promise.all(
          orgs.filter((org) => /^[A-Za-z0-9-]+$/.test(org)).map((org) => shared.callCache.get(`org-repos:${org}`, 60 * 60_000, () => orgRepos(runGh, org, directory))),
        );
        return { repos: lists.flat() };
      },
      // Only ever from the user's click in the review dialog; no tool exposes it, so the agent can't approve.
      submitReview: async (input) => {
        const review = input as { repo: string; number: number; event: ReviewEvent; body: string; sha: string };
        debug("review-submitting", { id: `${review.repo}#${review.number}`, event: review.event, sha: review.sha });
        const message = await submitReview(runGh, review, directory);
        debug("review-submitted", { id: `${review.repo}#${review.number}`, event: review.event, sha: review.sha });
        // The PR leaves the list once reviewed: read it again next time.
        reviewSearch = undefined;
        return { message };
      },
      // Every session's watches, with the session watching each: the one store the pill and the PRs tab both read.
      watches: async () => {
        const { entries } = await ctx.storage.scan({ prefix: KEY_PREFIX });
        const watches = entries.map((e) => e.value as unknown as Watch);
        const rows = (
          await Promise.all(
            sessionGroups(watches, Date.now()).map(async (group) => {
              const session = await tolerate(debug, "session title", ctx.session.get({ sessionID: group.sessionID }), undefined, { sessionID: group.sessionID });
              return group.watches.map((row) => ({ ...row, sessionID: group.sessionID, sessionTitle: session?.title || group.sessionID }));
            }),
          )
        ).flat();
        const me = await tolerate(debug, "gh user", ghUser(), undefined);
        const paused = githubPaused();
        return { rows, ...(me ? { me } : {}), ...(paused ? { paused } : {}) };
      },
      myPrs: async (input) => {
        const { merged } = input as { merged?: boolean };
        const cwd = directory;
        const open = await cachedSearch("open", () => myOpenPrs(runGh, cwd));
        const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
        const recent = merged ? await cachedSearch(`merged:${since}`, () => myMergedPrs(runGh, since, cwd)) : [];
        const { entries } = await ctx.storage.scan({ prefix: KEY_PREFIX });
        const watches = entries.map((e) => e.value as unknown as Watch);
        // Where each watched PR is, and the session watching it, so the list can show its status and link to it.
        const watchedRows = (
          await Promise.all(
            sessionGroups(watches, Date.now()).map(async (group) => {
              const session = await tolerate(debug, "session title", ctx.session.get({ sessionID: group.sessionID }), undefined, { sessionID: group.sessionID });
              return group.watches.map((row) => ({ ...row, sessionID: group.sessionID, sessionTitle: session?.title || group.sessionID }));
            }),
          )
        ).flat();
        return { open, merged: recent, watched: watches.map((w) => w.id), watchedRows };
      },
      // Topics for the gh user's PRs, from a light model of the panel session's own provider (the same guard as
      // watches). Kept for the same set of PRs, so the model is only asked again when the PRs change.
      myPrTopics: async (input) => {
        const { sessionID, merged } = input as { sessionID: string; merged?: boolean };
        const cwd = directory;
        const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
        const prs = [
          ...(await cachedSearch("open", () => myOpenPrs(runGh, cwd))),
          ...(merged ? await cachedSearch(`merged:${since}`, () => myMergedPrs(runGh, since, cwd)) : []),
        ];
        const session = await sessionView(sessionID);
        const pin = pinProvider(session, directory);
        if (!pin.ok) throw new Error(`no topics: ${pin.reason}`);
        const judge = resolveJudgeModel({ pinned: pin.pinned, session, pluginDirectory: directory, catalog: await ports.catalog(), preferences: settings.preferences });
        if (!judge.ok) throw new Error(`no topics: ${judge.reason}`);
        const modelKey = `${judge.model.providerID}/${judge.model.id}`;
        const key = `${modelKey}:${prs.map(prID).sort().join(",")}`;
        const cached = topicCache.get(key);
        if (cached) return { topics: await cached };
        const plan = topicPlan(await lastTopics.get(modelKey), prs);
        const ask = (prompt: string) => ctx.generate.text({ prompt, model: { providerID: judge.model.providerID, id: judge.model.id } });
        const topics = (async () => {
          let made: Topic[];
          if (plan.kind === "same") made = [...plan.topics];
          else if (plan.kind === "place") {
            const answer = await ask(placePrompt(plan.kept, plan.fresh));
            made = parsePlacements(answer.text, plan.kept, plan.fresh, badAnswer("topic placements", judge.model, answer.text, { sessionID }));
          } else {
            const answer = await ask(topicsPrompt(prs));
            made = parseTopics(answer.text, prs, badAnswer("topics", judge.model, answer.text, { sessionID }));
          }
          await lastTopics.set(modelKey, made);
          debug("topics", { sessionID, model: modelKey, plan: plan.kind, prs: prs.length, ...(plan.kind === "place" ? { placed: plan.fresh.map(prID) } : {}), topics: made.map((t) => `${t.name} (${t.prs.length})`) });
          return made;
        })();
        topicCache.set(key, topics);
        // A failed answer isn't kept: the next ask tries again.
        topics.catch(() => topicCache.delete(key));
        return { topics: await topics };
      },
      watch: async (input) => {
        const { sessionID, pr } = input as { sessionID: string; pr: string };
        debug("panel-watch", { sessionID, pr });
        return { message: await startWatch(sessionID, pr) };
      },
      unwatch: async (input) => {
        const { id } = input as { id: string };
        // Only ids of existing watches; a stop for anything else does nothing.
        if (await ctx.storage.get(KEY_PREFIX + id)) await unwatch(id);
        return {};
      },
    });
    // Tells the GUI one watch changed, with its new row (none when it stopped), so its store patches just that row.
    const changed = (sessionID: string, id: string) =>
      void tolerate(
        debug,
        "watch change event",
        (async () => {
          const watch = (await ctx.storage.get(KEY_PREFIX + id)) as unknown as Watch | undefined;
          const [row] = watch ? watchRows([watch], watch.sessionID, Date.now()) : [];
          const session = row ? await tolerate(debug, "session title", ctx.session.get({ sessionID }), undefined, { sessionID }) : undefined;
          await registration.events.emit("changed", { sessionID, id, ...(row ? { row: { ...row, sessionID, sessionTitle: session?.title || sessionID } } : {}) });
        })(),
        undefined,
      );

    const stop = async (id: string) => {
      const stopped = (await ctx.storage.get(KEY_PREFIX + id)) as unknown as Watch | undefined;
      clearTimeout(timers.get(id));
      timers.delete(id);
      await ctx.storage.remove(KEY_PREFIX + id);
      if (stopped) changed(stopped.sessionID, id);
    };

    // Each check decides when the next one runs: every minute while things move, less often while waiting on people.
    const schedule = (id: string, delayMs: number) => {
      if (!owning()) {
        if (handToOwner(shared, directory, id, delayMs)) debug("handed-to-owner", { id, directory });
        return;
      }
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => void step(id), delayMs));
    };

    // Another instance may be checking this watch (after a reload); then look again shortly instead of reporting twice.
    // The panel shows a line as updating from the moment its check starts (it may wait in the GitHub queue first).
    const announce = (id: string) =>
      void tolerate(debug, "updating event", ctx.storage.get(KEY_PREFIX + id).then((w) => {
        const watch = w as unknown as Watch | undefined;
        if (watch) changed(watch.sessionID, id);
      }), undefined);

    const step = async (id: string) => {
      if (!beginCheck(shared, id)) return schedule(id, BUSY_RETRY_MS);
      announce(id);
      try {
        await checkOnce(id);
      } finally {
        endCheck(shared, id);
        announce(id);
      }
    };

    const checkOnce = async (id: string) => {
      let delayMs = ERROR_RETRY_MS;
      try {
        const watch = (await ctx.storage.get(KEY_PREFIX + id)) as unknown as Watch | undefined;
        if (!watch) return void timers.delete(id);
        const result = await tick(watch, ports, settings);
        // A newer watch on the same PR may have replaced this one while it was checking; leave that one alone.
        const latest = (await ctx.storage.get(KEY_PREFIX + id)) as unknown as Watch | undefined;
        // A check that finishes after a reload handed the loop to a newer instance still saves what it found (and may
        // have said): dropping it made the new owner find the same change again and say it twice. Only one check of a
        // watch runs at a time (beginCheck), and the token guards against a replaced watch; the next check is the new
        // owner's (schedule hands it over).
        if (latest?.token !== watch.token) {
          if (latest) schedule(id, 0);
          return;
        }
        await recordBatchFacts(result.watch);
        if (result.stop) {
          await stop(id);
          if (result.follow !== undefined) {
            const started = await tolerate(debug, "following the replacement PR", startOne(watch.sessionID, `${watch.repo}#${result.follow}`, watch.pinned.directory), undefined, { id, follow: result.follow });
            if (started?.started) await updateBatches((batch) => (batch.members.includes(id) ? replaceMember(batch, id, started.started!.id, started.started!.facts) : batch));
          }
          return;
        }
        const saved = latest ? keepConcurrentChanges(watch, latest, result.watch) : result.watch;
        await ctx.storage.set(KEY_PREFIX + id, saved as never);
        changed(saved.sessionID, id);
        const runAttached = (saved.runs?.length ?? 0) > (result.watch.runs?.length ?? 0);
        // A run attached during the check is read right away instead of at the next (possibly a minute away) check.
        delayMs = runAttached ? 0 : result.delayMs > 0 ? alignedDelay(Date.now(), result.delayMs) : result.delayMs;
      } catch (err) {
        // The boundary for a check: whatever failed below, this watch keeps going and tries again shortly.
        console.error(`[pr-watch] ${id}:`, err);
        debug("check-failed", { id, error: err, stack: err instanceof Error ? err.stack : undefined, retryMs: delayMs });
      }
      schedule(id, delayMs);
    };

    const scanAll = async (prefix: string) => {
      const entries: { key: string; value: unknown }[] = [];
      let after: string | undefined;
      do {
        const page = await ctx.storage.scan({ prefix, ...(after ? { after } : {}) });
        entries.push(...page.entries);
        after = page.next;
      } while (after);
      return entries;
    };

    const directoryWatches = async () => {
      const now = Date.now();
      return (await scanAll(KEY_PREFIX))
        .map((e) => e.value as unknown as Watch)
        .filter((w) => w.pinned.directory === directory || (isOrphaned(w, directory, now) && claimOrphan(shared, w.id, directory)));
    };

    // Every setup (OpenCode runs it again per instance and reload) restarts the poll loop it now owns, but only the
    // first setup in the process announces it. The list is read from storage when sending, so an unwatch in between
    // is respected, and a note identical to the last one sent to the session is not repeated. Not awaited: posting
    // to a session must not hold up setup.
    for (const watch of await directoryWatches()) schedule(watch.id, 0);
    if (shouldAnnounceResume(shared, directory)) {
      void (async () => {
        const bySession = new Map<string, string[]>();
        for (const watch of await directoryWatches()) bySession.set(watch.sessionID, [...(bySession.get(watch.sessionID) ?? []), watch.id]);
        for (const [sessionID, ids] of bySession) {
          const message = resumedMessage(ids);
          debug("resumed", { directory, ids });
          if (!resumeChanged((await ctx.storage.get(RESUMED_PREFIX + sessionID)) as string | undefined, message)) continue;
          await ctx.storage.set(RESUMED_PREFIX + sessionID, message);
          await inform(sessionID, message);
        }
      })().catch((err) => {
        console.error("[pr-watch] could not announce resumed watches:", err);
        debug("resume-failed", { directory, error: err });
      });
    }

    // Stops a watch and drops its queued messages; used by unwatch_pr and by the stop button in the desktop pill.
    // An unwatch is remembered per session, so automatic triggers (a merge, a rerun) don't start the PR again there.
    const unwatchedKey = (sessionID: string, id: string) => `unwatched/${sessionID}/${id}`;
    const unwatchedAt = async (sessionID: string, id: string) => (await ctx.storage.get(unwatchedKey(sessionID, id))) as number | undefined;

    const unwatch = async (id: string, sessionID?: string) => {
      debug("unwatch", { id, sessionID });
      const owner = sessionID ?? ((await ctx.storage.get(KEY_PREFIX + id)) as unknown as Watch | undefined)?.sessionID;
      if (owner) await ctx.storage.set(unwatchedKey(owner, id), Date.now());
      await stop(id);
      for (const [sessionID, entry] of processState().outbox.queued) {
        entry.messages = dropMessagesFor(entry.messages, id);
        if (entry.messages.length === 0) processState().outbox.queued.delete(sessionID);
      }
      await removeFinishedBatches();
    };

    const startWatch = async (sessionID: string, prReference: string, cwd?: string, batchID?: string, trigger?: Trigger, startedBy?: string): Promise<string> =>
      (await startOne(sessionID, prReference, cwd, batchID, trigger, startedBy)).message;

    // The provider guard and the judging model for a session's watches; throws when watching would break the guard.
    const guarded = async (sessionID: string) => {
      const session = await sessionView(sessionID);
      const pin = pinProvider(session, directory);
      if (!pin.ok) throw new Error(`Refusing to watch: ${pin.reason}. No model will be called for this watch.`);
      const judge = resolveJudgeModel({
        pinned: pin.pinned,
        session,
        pluginDirectory: directory,
        catalog: await ports.catalog(),
        preferences: settings.preferences,
      });
      if (!judge.ok) throw new Error(`Refusing to watch: ${judge.reason}. No model will be called for this watch.`);
      return { session, pin, judge };
    };

    const startOne = async (
      sessionID: string,
      prReference: string,
      cwd?: string,
      batchID?: string,
      trigger?: Trigger,
      /** The command that started it; set for automatic starts. */
      startedBy?: string,
    ): Promise<{ message: string; started?: { id: string; title: string; facts: PrFacts } }> => {
      const runRef = parseRunReference(prReference);
      const ref = runRef ? { repo: runRef.repo, pr: 0 } : parsePrReference(prReference);
      if (!ref) throw new Error(`Not a PR or run reference: ${prReference}`);

      const { session, pin, judge } = await guarded(sessionID);

      const repo = ref.repo ?? (await resolveRepo(runGh, cwd ?? session.directory));
      const automatic = startedBy !== undefined;
      if (runRef) {
        const repoOfRun = ref.repo ?? (await resolveRepo(runGh, cwd ?? session.directory));
        const target = await tolerate(debug, "the watched PR for the run's branch", watchedPrForRun(repoOfRun, runRef.run, sessionID, cwd ?? session.directory), undefined, { run: runRef.run });
        if (target) {
          const read = await tolerate(debug, "the run to attach", viewRun(runGhFirst, repoOfRun, runRef.run, cwd ?? session.directory), undefined, { run: runRef.run });
          const ended = read ? alreadyFinished(attachedRun(read)) : undefined;
          if (ended) return { message: `${target.id}: ${ended}; nothing left to follow.` };
          // The run belongs to a PR this session watches: follow it there instead of in a row of its own.
          if (!target.runs?.includes(runRef.run)) await ctx.storage.set(KEY_PREFIX + target.id, { ...target, runs: [...(target.runs ?? []), runRef.run] } as never);
          if (target.pinned.directory === directory) schedule(target.id, 0);
          changed(sessionID, target.id);
          debug("run-attached", { id: target.id, run: runRef.run, startedBy });
          return { message: `Following run ${runRef.run} in the watch of ${target.id}${startedBy ? ` (started by ${startedBy})` : ""}.` };
        }
      }
      const id = runRef ? runWatchID(repo, runRef.run) : `${repo}#${ref.pr}`;
      const now = Date.now();
      if (!automaticStartAllowed({ automatic, ...optional(await unwatchedAt(sessionID, id)) })) {
        debug("start-skipped", { id, sessionID, startedBy, reason: "unwatched in this session" });
        return { message: "" };
      }
      if (!automatic) await ctx.storage.remove(unwatchedKey(sessionID, id));
      const existing = (await ctx.storage.get(KEY_PREFIX + id)) as unknown as Watch | undefined;
      if (existing && keepExisting({ automatic, sessionID, existing })) {
        // The running watch reports what the trigger leads to (merged, deploy started); it only needs the trigger's grace.
        const kept: Watch = {
          ...existing,
          ...(trigger ? { awaiting: { trigger, since: now } } : {}),
          ...(trigger === "update-branch" ? { expectedCommitSince: now } : {}),
        };
        await ctx.storage.set(KEY_PREFIX + id, kept as never);
        if (existing.pinned.directory === directory) schedule(id, 0);
        debug("start-kept", { id, sessionID, startedBy, trigger });
        return { message: "" };
      }
      const replaced = Boolean(existing);
      // An open PR started by hand starts from one quick read; the first full check, right after, fills in the rest.
      // A trigger (merge, rerun) needs the full read to decide whether there is anything to watch.
      const quick = !runRef && !trigger ? await quickSnapshot(runGhFirst, repo, ref.pr, pin.pinned.directory, now, readPr("first")) : undefined;
      const snapshot = quick ?? (runRef
        ? await runSnapshot(runGhFirst, repo, runRef.run, pin.pinned.directory, now)
        : await prSnapshot(runGhFirst, repo, ref.pr, pin.pinned.directory, now, cachedRoleLookup(repo, pin.pinned.directory, judge.model), await marksNoDeploy(repo), environmentGuess(pin.pinned.directory, judge.model), readPr("first")));
      if (!snapshot.facts) throw new Error(snapshot.text);
      const summary = summaryLine(snapshot.facts, now);
      const decision = startDecision(snapshot.facts, now, trigger ? { trigger } : {});
      debug("start", { id, sessionID, startedBy, trigger, start: decision.start, ...(decision.start ? {} : { reason: decision.reason }), summary });
      if (!decision.start) {
        if (replaced) await stop(id);
        const ended = replaced ? " Stopped the earlier watch." : "";
        return { message: `Not watching ${id}: ${decision.reason}. ${summary}.${ended}` };
      }

      const watch: Watch = {
        token: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        id, sessionID, repo, pr: ref.pr, pinned: pin.pinned,
        ...(runRef ? { run: runRef.run } : {}),
        startedAt: now, lastChangeAt: now, lastCheckedAt: now,
        lastSnapshot: snapshot.text, lastFacts: snapshot.facts,
        ...(batchID ? { batchID } : {}),
        ...(quick ? { provisional: true } : {}),
        snapshotVersion: SNAPSHOT_VERSION,
        ...(trigger ? { awaiting: { trigger, since: now } } : decision.awaiting ? { awaiting: decision.awaiting } : {}),
        ...(trigger === "update-branch" ? { expectedCommitSince: now } : {}),
        ...phaseFields(snapshot.facts, now),
      };
      if (!stillWanted({ startedAt: now, ...optional(await unwatchedAt(sessionID, id)) })) {
        debug("start-skipped", { id, sessionID, startedBy, reason: "unwatched while starting" });
        return { message: "" };
      }
      await ctx.storage.set(KEY_PREFIX + id, watch as never);
      changed(sessionID, id);
      schedule(id, quick ? 0 : pollDelay(snapshot.facts, now, watch.awaiting !== undefined));
      const title = snapshot.text.split("\n")[0]!.replace(/^(PR|Run): /, "").replace(/ \(https:\/\/\S+\)$/, "");
      const prefix = replaced ? "Replaced the earlier watch. " : "";
      return { message: prefix + watchStartedMessage(id, judge.model, summary, startedBy), started: { id, title, facts: snapshot.facts } };
    };

    // The agent's answer when the model couldn't tell which workflow deploys: stored per repo, it overrides the model.
    const rememberDeployWorkflow = async (repo: string, given: string, cwd: string): Promise<void> => {
      if (given.trim().toLowerCase() === "none") {
        await ctx.storage.set(`no-deploy/${repo}`, true);
        return;
      }
      const { workflows } = JSON.parse(await runGh(["api", `repos/${repo}/actions/workflows?per_page=100`], cwd)) as {
        workflows: { id: number; name: string; path: string }[];
      };
      const id = matchWorkflow(given, workflows);
      if (id === undefined) throw new Error(`No workflow called "${given}" in ${repo}; its workflows: ${workflows.map((w) => w.name).join(", ")}`);
      await ctx.storage.remove(`no-deploy/${repo}`);
      await ctx.storage.set(`workflow-role/${repo}/${id}`, "deploy");
    };

    const startMany = async (sessionID: string, text: string, deployWorkflow?: string): Promise<string> => {
      const tokens = text.split(/[\s,]+/).filter(Boolean);
      const runs = tokens.filter((token) => parseRunReference(token));
      if (runs.length > 0) {
        const lines = await Promise.all(
          tokens.map((token) => startWatch(sessionID, token).catch((err) => `${token}: ${err instanceof Error ? err.message : String(err)}`)),
        );
        return lines.join("\n");
      }
      const { refs, invalid } = parsePrReferences(text);
      if (refs.length === 0) throw new Error(`No PR references in: ${text}`);
      if (deployWorkflow) {
        const cwd = (await sessionView(sessionID)).directory;
        for (const repo of new Set(await Promise.all(refs.map(async (ref) => ref.repo ?? (await resolveRepo(runGh, cwd)))))) {
          await rememberDeployWorkflow(repo, deployWorkflow, cwd);
        }
      }
      if (refs.length === 1 && invalid.length === 0) return startWatch(sessionID, text.trim());

      const batchID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const lines: string[] = invalid.map((token) => `Not a PR reference: ${token}`);
      const started: { id: string; title: string; facts: PrFacts }[] = [];
      // All at once: the process's GitHub queue keeps the number of calls running together down.
      const results = await Promise.all(refs.map(async (ref) => {
        const reference = ref.repo ? `${ref.repo}#${ref.pr}` : String(ref.pr);
        try {
          return await startOne(sessionID, reference, undefined, batchID);
        } catch (err) {
          return { message: `${reference}: ${err instanceof Error ? err.message : String(err)}` };
        }
      }));
      for (const result of results) {
        lines.push(result.message);
        if ("started" in result && result.started) started.push(result.started);
      }
      if (started.length > 1) {
        const label = batchLabel(started.map((s) => s.title));
        const facts = Object.fromEntries(started.map((s) => [s.id, s.facts]));
        const ids = new Set(started.map((s) => s.id));
        await updateBatches((batch) => [...ids].reduce((b, id) => withoutMember(b, id), batch));
        await ctx.storage.set(BATCH_PREFIX + batchID, { label, members: started.map((s) => s.id), facts } as never);
        lines.push(`Watching these ${started.length} as a batch; updates arriving together are combined. ${batchProgress(label, started.map((s) => s.facts), Date.now())}`);
      }
      return lines.join("\n");
    };

    // GitHub creates the run a few seconds after the dispatch is accepted.
    const findDispatchedRun = async (repo: string, dispatch: Dispatch, since: number, cwd: string) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const runs = JSON.parse(
          await runGh(
            ["run", "list", "--repo", repo, "--workflow", dispatch.workflow, "--event", "workflow_dispatch", ...(dispatch.ref ? ["--branch", dispatch.ref] : []), "--limit", "5", "--json", "databaseId,event,createdAt"],
            cwd,
          ),
        );
        const found = dispatchedRun(runs, since);
        if (found !== undefined) return found;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      return undefined;
    };

    const commandStarts = new Map<string, number>();
    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool === "shell" || event.tool === "bash") commandStarts.set(event.id, Date.now());
    });

    await ctx.tool.hook("execute.after", async (event) => {
      const startedAt = commandStarts.get(event.id);
      commandStarts.delete(event.id);
      if ((event.tool !== "shell" && event.tool !== "bash") || event.status !== "completed") return;
      const input = event.input as { command?: string; workdir?: string };
      const merges = findPrMerges(input.command ?? "");
      const reruns = findRunReruns(input.command ?? "");
      // A comment asking a bot to rebase or recreate leads to a new commit, just like a branch update.
      const updates = [
        ...findBranchUpdates(input.command ?? "").map((update) => ({ ...update, by: "gh pr update-branch" })),
        ...findBotRefreshes(input.command ?? "").map((update) => ({ ...update, by: "gh pr comment to the bot" })),
      ];
      const dispatches = findWorkflowDispatches(input.command ?? "");
      const creates = findPrCreates(input.command ?? "");
      const pushed = findGitPushes(input.command ?? "");
      if (merges.length === 0 && reruns.length === 0 && updates.length === 0 && dispatches.length === 0 && creates.length === 0 && !pushed) return;
      debug("command", {
        sessionID: event.sessionID, command: (input.command ?? "").slice(0, 500), merges, reruns, updates, dispatches,
        ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }),
      });
      const finishedAt = Date.now();
      // With one update in the command, gh's answer is about that PR.
      const nothingUpdated = updates.length === 1 && alreadyUpToDate(JSON.stringify(event.result));
      const dispatchedAt = startedAt ?? finishedAt;
      const command = { ...(startedAt === undefined ? {} : { startedAt }), finishedAt };

      // A `cd` the command opens with moves where its gh calls ran, which decides the repository without --repo.
      const cwd = commandDirectory(input.command ?? "", input.workdir ?? (await sessionView(event.sessionID)).directory, homedir());
      // A new PR, or new commits on a branch with one: watch it, like after a merge. A push to a branch without a PR
      // (main, a branch not yet opened) is nothing to watch, so it says nothing.
      if (creates.length > 0) {
        for (const url of prUrlsIn(JSON.stringify(event.result ?? ""))) {
          try {
            const note = await startWatch(event.sessionID, url, cwd, undefined, undefined, "gh pr create");
            if (note) await inform(event.sessionID, note);
          } catch (err) {
            debug("no-watch", { sessionID: event.sessionID, after: "create", error: err instanceof Error ? err.message : String(err) });
            await informOnce(event.sessionID, noWatchMessage("creation", url, err instanceof Error ? err.message : String(err)));
          }
        }
      }
      if (pushed) {
        const url = await tolerate(debug, "the pushed branch's PR", currentBranchPrUrl(runGh, cwd), undefined, { cwd });
        if (url) {
          try {
            const note = await startWatch(event.sessionID, url, cwd, undefined, undefined, "git push");
            if (note) await inform(event.sessionID, note);
          } catch (err) {
            debug("no-watch", { sessionID: event.sessionID, after: "push", error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      for (const merge of merges) {
        try {
          const reference = merge.pr
            ? merge.repo && /^\d+$/.test(merge.pr) ? `${merge.repo}#${merge.pr}` : merge.pr
            : await tolerate(debug, "the current branch's PR", currentBranchPrUrl(runGh, cwd, merge.repo), undefined, { cwd });
          if (!reference) continue;
          const note = await startWatch(event.sessionID, reference, cwd, undefined, undefined, "gh pr merge");
          if (note) await inform(event.sessionID, note);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          debug("no-watch", { sessionID: event.sessionID, after: "merge", error: message });
          await informOnce(event.sessionID, noWatchMessage("merge", merge.repo ? `${merge.repo}#${merge.pr}` : merge.pr || "the current branch's PR", message));
        }
      }
      for (const update of updates) {
        try {
          const reference = update.pr
            ? update.repo && /^\d+$/.test(update.pr) ? `${update.repo}#${update.pr}` : update.pr
            : await tolerate(debug, "the current branch's PR", currentBranchPrUrl(runGh, cwd, update.repo), undefined, { cwd });
          if (!reference) continue;
          const note = await startWatch(event.sessionID, reference, cwd, undefined, nothingUpdated ? undefined : freshTrigger("update-branch" as const, command), update.by);
          if (note) await inform(event.sessionID, note);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          debug("no-watch", { sessionID: event.sessionID, after: "branch update", error: message });
          await informOnce(event.sessionID, noWatchMessage("branch update", update.repo ? `${update.repo}#${update.pr}` : update.pr || "the current branch's PR", message));
        }
      }
      for (const rerun of reruns) {
        try {
          const repo = rerun.repo ?? (await resolveRepo(runGh, cwd));
          const pr = await prForRun(runGh, repo, rerun.run, cwd);
          const reference = pr === undefined ? `https://github.com/${repo}/actions/runs/${rerun.run}` : `${repo}#${pr}`;
          const note = await startWatch(event.sessionID, reference, cwd, undefined, freshTrigger("rerun" as const, command), `gh run rerun ${rerun.run}`);
          if (note) await inform(event.sessionID, note);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          debug("no-watch", { sessionID: event.sessionID, after: "rerun", error: message });
          await informOnce(event.sessionID, noWatchMessage("rerun", `run ${rerun.run}`, message));
        }
      }
      for (const dispatch of dispatches) {
        try {
          const repo = dispatch.repo ?? (await resolveRepo(runGh, cwd));
          // With one dispatch, the run link gh printed is that dispatch's run.
          const printed = dispatches.length === 1 ? runFromOutput(JSON.stringify(event.result)) : undefined;
          const run = printed ?? (await findDispatchedRun(repo, dispatch, dispatchedAt, cwd));
          if (run === undefined) throw new Error(`no run of ${dispatch.workflow} showed up within a minute`);
          const note = await startWatch(event.sessionID, `https://github.com/${repo}/actions/runs/${run}`, cwd, undefined, undefined, `gh workflow run ${dispatch.workflow}`);
          if (note) await inform(event.sessionID, note);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          debug("no-watch", { sessionID: event.sessionID, after: "workflow dispatch", error: message });
          await informOnce(event.sessionID, noWatchMessage("workflow dispatch", dispatch.workflow, message));
        }
      }
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "watch_pr",
        description:
          "Watch GitHub pull requests in the background until a person has to act or they are in production: " +
          "waiting for review or an environment approval (no time limit, daily reminder on working days), a branch build, auto-merge, and the deploy after merge. " +
          "Follows the PR until it is done (deployed, merged with no deploy, or closed): something to fix (checks failed, changes requested, deploy failed) " +
          "wakes the agent with a suggestion and the watch follows the fix; a review, a run approval or the merge only informs. " +
          "Every change of where the PR is gets a message, including checks finishing (passed or failed), so no message means nothing changed; " +
          "Progress within a step is sent as the PR's track (PR, checks, review, merge, deploy), at most once a minute, without waking the agent. " +
          "Also watches a single workflow run without a PR (a manual dispatch), given its run link, until it succeeds, fails or waits for approval. " +
          "Starts automatically after gh pr create, git push to a branch with a PR, gh pr merge, gh pr update-branch, gh run rerun and gh workflow run. Use this instead of polling with sleep. " +
          "Answers at once; the first status (or why it isn't watched) follows as a message within about 15 seconds, so don't wait or poll for it.",
        input: {
          type: "object",
          properties: {
            pr: {
              type: "string",
              description:
                'One or more PRs: a number, "owner/repo#123" or a GitHub PR URL, or workflow run links (https://github.com/owner/repo/actions/runs/123), separated by spaces, commas or newlines. ' +
                "Several PRs started together are reported as a batch.",
            },
            deployWorkflow: {
              type: "string",
              description:
                "Only when a watch said it couldn't tell which workflow deploys the repo: the name or file of the workflow that deploys it " +
                '(read the repo\'s .github/workflows), or "none" if the repo doesn\'t deploy. Remembered for the repo.',
            },
          },
          required: ["pr"],
          additionalProperties: false,
        },
        async execute(rawInput, context) {
          const input = rawInput as { pr: string; deployWorkflow?: string };
          // What fails at once (no references, the provider guard) is the answer; the first check, which takes
          // 10-15 seconds of gh calls, runs in the background and its result comes as a message.
          if (parsePrReferences(input.pr).refs.length === 0 && !input.pr.split(/[\s,]+/).some((token) => parseRunReference(token))) {
            throw new Error(`No PR references in: ${input.pr}`);
          }
          await guarded(context.sessionID);
          const sessionID = context.sessionID;
          void (async () => {
            const result = await startMany(sessionID, input.pr, input.deployWorkflow).then(startResult, (err: unknown) => startFailed(input.pr, err));
            debug("start-reported", { sessionID, pr: input.pr, wake: result?.wake ?? false });
            if (result) await deliver(sessionID, result.text, result.wake);
          })().catch((err: unknown) => debug("start-report-failed", { sessionID, pr: input.pr, error: err }));
          return { content: startingMessage(input.pr.trim()) };
        },
      });

      editor.add({
        name: "unwatch_pr",
        description: "Stop watching a GitHub pull request started with watch_pr.",
        input: {
          type: "object",
          properties: { pr: { type: "string", description: '"owner/repo#123", a PR number, a GitHub PR URL or a workflow run link.' } },
          required: ["pr"],
          additionalProperties: false,
        },
        async execute(rawInput, context) {
          const input = (rawInput as { pr: string }).pr;
          const run = parseRunReference(input);
          const ref = run ? undefined : parsePrReference(input);
          if (!run && !ref) throw new Error(`Not a PR or run reference: ${input}`);
          const repo = run?.repo ?? ref?.repo ?? (await resolveRepo(runGh, (await sessionView(context.sessionID)).directory));
          const id = run ? runWatchID(repo, run.run) : `${repo}#${ref!.pr}`;
          await unwatch(id, context.sessionID);
          return { content: `Stopped watching ${id}.` };
        },
      });

      editor.add({
        name: "list_pr_watches",
        description:
          "List the pull requests currently watched by watch_pr, with their last known state and when it was last checked. " +
          "The state is from the last poll, not live. Shows this session's watches; pass allSessions for every session's. " +
          "Pass tail to show only the last lines of each state (where the deploy jobs are).",
        input: {
          type: "object",
          properties: {
            tail: { type: "integer", minimum: 1, description: "Show only the last N lines of each watch's state, plus the PR title, summary, approval and up-to-date lines." },
            allSessions: { type: "boolean", description: "Also list the watches of other sessions." },
          },
          additionalProperties: false,
        },
        async execute(rawInput, context) {
          const { tail, allSessions } = rawInput as { tail?: number; allSessions?: boolean };
          const { entries } = await ctx.storage.scan({ prefix: KEY_PREFIX });
          const watches = entries.map((e) => e.value as unknown as Watch).filter((w) => allSessions || w.sessionID === context.sessionID);
          if (watches.length === 0) {
            const elsewhere = entries.length - watches.length;
            return { content: `No PRs are being watched in this session.${elsewhere > 0 ? ` ${elsewhere} in other sessions (allSessions: true lists them).` : ""}` };
          }
          return {
            content: watches
              .map((w) => formatWatch(w, tail, Date.now()))
              .join("\n\n"),
          };
        },
      });
    });

    return () => {
      releasePolling(shared, directory, owner);
      releaseDeliverer(shared.outbox, owner);
    };
  },
});
