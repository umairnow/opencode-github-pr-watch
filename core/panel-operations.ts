import { prList, prSessionPrompt, type MyPr } from "./my-prs";
import { explainPrompt, reviewId, reviewProblem, type ReviewEvent, type ReviewRequest } from "./review-requests";
import type { Topic } from "./topics";
import type { Change } from "./store";
import type { WatchRowLike } from "./prs-view";

/**
 * Everything the pill and the PRs tab do, apart from rendering: each operation calls the app through the port, reports
 * that it is in progress (`track`) and what came of it (`say`). Tested with a fake port; the GUI only wires it up.
 */
export interface PanelPort {
  myPrs(merged: boolean): Promise<LoadedPrs>;
  /** Every session's watches, and the gh user. */
  watches(): Promise<{ readonly rows: readonly WatchRowLike[]; readonly me?: string; readonly paused?: string }>;
  myPrTopics(sessionID: string, merged: boolean): Promise<readonly Topic[]>;
  watch(sessionID: string, pr: string): Promise<string>;
  unwatch(id: string): Promise<void>;
  /** False when the watches were asked less than 20 seconds ago, and so don't check again. */
  checkNow(): Promise<boolean>;
  session(sessionID: string): Promise<{ readonly model: unknown; readonly agent: string | undefined }>;
  createSession(input: { readonly title: string; readonly directory: string; readonly model: unknown; readonly agent: string | undefined }): Promise<string>;
  prompt(sessionID: string, text: string): Promise<void>;
  openSession(server: string, sessionID: string): void;
  copy(text: string): Promise<void>;
  /** The PRs whose review is requested from the gh user, and those that need a review in the given favourite repos. */
  reviewRequests(favourites: readonly string[]): Promise<readonly ReviewRequest[]>;
  /** The repos of the given organisations. */
  orgRepos(orgs: readonly string[]): Promise<readonly string[]>;
  /** Submits the review on the given commit; refused when the PR has moved on. Returns what happened. */
  submitReview(input: { readonly repo: string; readonly number: number; readonly event: ReviewEvent; readonly body: string; readonly sha: string }): Promise<string>;
}

export interface Feedback {
  /** Shows the text as work in progress until the work settles; returns the work. */
  track<T>(text: string, work: Promise<T>): Promise<T>;
  /** Shows a short result. */
  say(text: string): void;
}

export interface LoadedPrs {
  readonly open: readonly MyPr[];
  readonly merged?: readonly MyPr[];
}

export interface PanelSession {
  readonly id: string;
  readonly directory: string;
  readonly server: { readonly id: string };
}

/** Why something failed, from what was thrown: an Error, or the plain objects the RPC client rejects with (for example on a network drop). */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const found = [err, (err as { error?: unknown } | null)?.error, (err as { data?: unknown } | null)?.data]
    .map((e) => (e as { message?: unknown } | null | undefined)?.message)
    .find((m): m is string => typeof m === "string" && m !== "");
  if (found) return found;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
const message = errorText;

export function panelOperations(port: PanelPort, apply: (change: Change) => void, feedback: Feedback) {
  const { track, say } = feedback;
  // An action reports its own failure and returns false, so a click never leaves an unhandled error behind.
  const act = async (work: () => Promise<void>, failure: string): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (err) {
      say(`${failure}: ${message(err)}`);
      return false;
    }
  };

  return {
    /** Full refreshes put what they read into the store; they throw, so the tab can show the error. */
    refreshWatches: async () => {
      const { rows, me, paused } = await port.watches();
      apply({ kind: "rows", rows });
      if (me) apply({ kind: "me", me });
      apply({ kind: "paused", ...(paused ? { text: paused } : {}) });
    },
    refreshPrs: async (merged: boolean) => {
      const loaded = await track("Loading your PRs…", port.myPrs(merged));
      apply({ kind: "prs", open: loaded.open, ...(merged && loaded.merged ? { merged: loaded.merged } : {}) });
    },
    loadTopics: (sessionID: string, merged: boolean, hasTopics: boolean) =>
      track(hasTopics ? "Updating the topics…" : "Sorting your PRs into topics…", port.myPrTopics(sessionID, merged)),

    watch: (sessionID: string, pr: MyPr) => {
      const id = `${pr.repo}#${pr.number}`;
      return act(async () => say((await track(`Starting watching ${id}…`, port.watch(sessionID, id))).split(". ")[0]!), `Could not watch ${id}`);
    },
    checkNow: () =>
      act(async () => {
        const checking = await track("Asking every watch to check GitHub…", port.checkNow());
        say(checking ? "Every watch is checking GitHub now." : "The watches checked GitHub less than 20 seconds ago.");
      }, "Could not ask the watches to check"),
    stop: (id: string) =>
      act(async () => {
        await track(`Stopping watching ${id}…`, port.unwatch(id));
        say(`Stopped watching ${id}.`);
      }, `Could not stop watching ${id}`),

    /** A new session about the PR in the open session's folder, with its model and agent, asked to summarise it. */
    startSession: (from: PanelSession, pr: Pick<MyPr, "repo" | "number" | "title" | "url">) =>
      act(
        () =>
          track(
            `Starting a session about ${pr.repo}#${pr.number}…`,
            (async () => {
              const current = await port.session(from.id);
              const id = await port.createSession({ title: `PR #${pr.number} on ${pr.repo}`, directory: from.directory, model: current.model, agent: current.agent });
              await port.prompt(id, prSessionPrompt({ ...pr, draft: false, createdAt: "" }));
              port.openSession(from.server.id, id);
            })(),
          ),
        "Could not start a session",
      ),

    copy: (name: string, prs: readonly Pick<MyPr, "title" | "url">[]) =>
      act(async () => {
        await port.copy(prList(prs));
        say(`Copied ${prs.length} PR${prs.length === 1 ? "" : "s"} from ${name}.`);
      }, "Could not copy"),

    /** Throws, so the tab can show the error. */
    loadRepos: (orgs: readonly string[]) => track(`Loading the repos of ${orgs.join(", ")}…`, port.orgRepos(orgs)),
    /** Throws, so the tab can show the error. */
    loadReviews: (favourites: readonly string[]) => track("Loading the PRs waiting for your review…", port.reviewRequests(favourites)),

    /**
     * A new session that summarises and reviews the PR at its head commit, with the open session's model and agent, in
     * its folder. With the commit explained before, it asks about the changes since. True when the session started.
     */
    explain: (from: PanelSession, pr: ReviewRequest, previousSha?: string) =>
      act(
        () =>
          track(
            `Starting a review session for ${reviewId(pr)}…`,
            (async () => {
              const current = await port.session(from.id);
              const id = await port.createSession({ title: `Review: ${reviewId(pr)} ${pr.title}`, directory: from.directory, model: current.model, agent: current.agent });
              await port.prompt(id, explainPrompt(pr, previousSha));
              port.openSession(from.server.id, id);
            })(),
          ),
        "Could not start a review session",
      ),

    /** Sends the review on the commit the user had explained; a review GitHub would refuse is never sent. */
    submitReview: async (pr: ReviewRequest, event: ReviewEvent, body: string) => {
      const problem = reviewProblem(event, body);
      if (problem) {
        say(problem);
        return false;
      }
      return act(
        async () => say(await track(`Submitting the review of ${reviewId(pr)}…`, port.submitReview({ repo: pr.repo, number: pr.number, event, body, sha: pr.headSha }))),
        `Could not submit the review of ${reviewId(pr)}`,
      );
    },
  };
}

export type PanelOperations = ReturnType<typeof panelOperations>;

/** The work in progress, in the order it started; `onChange` gets the texts whenever one starts or settles. */
export function activities(onChange: (texts: string[]) => void) {
  let running: { id: number; text: string }[] = [];
  let next = 0;
  const changed = () => onChange(running.map((a) => a.text));
  return {
    track<T>(text: string, work: Promise<T>): Promise<T> {
      const id = ++next;
      running = [...running, { id, text }];
      changed();
      return work.finally(() => {
        running = running.filter((a) => a.id !== id);
        changed();
      });
    },
  };
}
