import { describe, expect, test } from "bun:test";
import { activities, errorText, panelOperations, type PanelPort } from "../core/panel-operations";
import type { Change } from "../core/store";
import type { MyPr } from "../core/my-prs";
import { explainPrompt, type ReviewRequest } from "../core/review-requests";

const pr = (repo: string, number: number): MyPr => ({ repo, number, title: `Fix ${number}`, url: `https://github.com/${repo}/pull/${number}`, draft: false, createdAt: "2026-11-10T10:00:00Z" });

// A fake of what the operations need from the app: RPC, sessions, tabs and the clipboard. Records every call.
class FakePort implements PanelPort {
  readonly calls: string[] = [];
  failing?: string;
  private fail(what: string) {
    this.calls.push(what);
    if (this.failing === what.split(" ")[0]) throw new Error(`${this.failing} broke`);
  }
  async myPrs(merged: boolean) {
    this.fail(`myPrs merged=${merged}`);
    return { open: [pr("o/r", 1)], merged: merged ? [pr("o/r", 2)] : [], watchedRows: [] };
  }
  async watches() {
    this.fail("watches");
    return { rows: [{ id: "o/r#1", label: "o/r#1 Fix 1", url: "u", detail: "x", tone: "pending" as const }], me: "me" };
  }
  async myPrTopics(sessionID: string, merged: boolean) {
    this.fail(`myPrTopics ${sessionID} merged=${merged}`);
    return [{ name: "CI", prs: ["o/r#1"] }];
  }
  async watch(sessionID: string, pr: string) {
    this.fail(`watch ${sessionID} ${pr}`);
    return `Watching ${pr}. summary: x. More text`;
  }
  async unwatch(id: string) { this.fail(`unwatch ${id}`); }
  recentCheck = false;
  async checkNow() {
    this.fail("checkNow");
    return !this.recentCheck;
  }
  async session(sessionID: string) {
    this.fail(`session ${sessionID}`);
    return { model: { providerID: "p", id: "m" }, agent: "build" };
  }
  async createSession(input: { title: string; directory: string; model: unknown; agent: string | undefined }) {
    this.fail(`createSession ${input.title} in ${input.directory} with ${JSON.stringify(input.model)} ${input.agent}`);
    return "ses_new";
  }
  async prompt(sessionID: string, text: string) { this.fail(`prompt ${sessionID} ${text}`); }
  openSession(server: string, sessionID: string) { this.calls.push(`open ${server} ${sessionID}`); }
  async copy(text: string) { this.fail(`copy ${text}`); }
  async reviewRequests(favourites: readonly string[]) {
    this.fail(`reviewRequests ${favourites.join(",")}`);
    return [request];
  }
  async orgRepos(orgs: readonly string[]) {
    this.fail(`orgRepos ${orgs.join(",")}`);
    return ["t/a"];
  }
  async submitReview(input: { repo: string; number: number; event: string; body: string; sha: string }) {
    this.fail(`submitReview ${input.repo}#${input.number} ${input.event} at ${input.sha}: ${input.body}`);
    return `Approved ${input.repo}#${input.number}.`;
  }
}

const request: ReviewRequest = { repo: "o/r", number: 7, title: "Add login", url: "https://github.com/o/r/pull/7", draft: false, createdAt: "", author: "colleague", headSha: "abc123", requested: true };

const setup = () => {
  const port = new FakePort();
  const log: string[] = [];
  const changes: Change[] = [];
  const ops = panelOperations(port, (change) => void changes.push(change), {
    track: (text, work) => {
      log.push(`… ${text}`);
      return work;
    },
    say: (text) => void log.push(text),
  });
  return { port, log, ops, changes };
};
const from = { id: "ses_1", directory: "/work", server: { id: "local" } };

describe("panel operations", () => {
  test("watch: says it is starting, then the first sentence of the answer", async () => {
    const { port, log, ops } = setup();
    await ops.watch("ses_1", pr("o/r", 7));
    expect(port.calls).toEqual(["watch ses_1 o/r#7"]);
    expect(log).toEqual(["… Starting watching o/r#7…", "Watching o/r#7"]);
  });

  test("stop says what it did", async () => {
    const { port, log, ops } = setup();
    await ops.stop("o/r#7");
    expect(port.calls).toEqual(["unwatch o/r#7"]);
    expect(log).toEqual(["… Stopping watching o/r#7…", "Stopped watching o/r#7."]);
  });

  test("a failed action says why and returns false; it doesn't throw", async () => {
    const { port, log, ops } = setup();
    port.failing = "watch";
    expect(await ops.watch("ses_1", pr("o/r", 7))).toBe(false);
    expect(log.at(-1)).toBe("Could not watch o/r#7: watch broke");
  });

  test("a session about a PR: the open session's model and agent, its folder, the summary request, then opened", async () => {
    const { port, ops } = setup();
    await ops.startSession(from, pr("o/r", 7));
    expect(port.calls).toEqual([
      "session ses_1",
      'createSession PR #7 on o/r in /work with {"providerID":"p","id":"m"} build',
      "prompt ses_new PR #7 on o/r: Fix 7 (https://github.com/o/r/pull/7). Summarize it.",
      "open local ses_new",
    ]);
  });

  test("copy: a - list of the group's PRs, and how many", async () => {
    const { port, log, ops } = setup();
    await ops.copy("o/r", [pr("o/r", 1), pr("o/r", 2)]);
    expect(port.calls).toEqual(["copy - Fix 1: https://github.com/o/r/pull/1\n- Fix 2: https://github.com/o/r/pull/2"]);
    expect(log).toEqual(["Copied 2 PRs from o/r."]);
  });

  test("refreshes go into the store, the same way a single watch's change does", async () => {
    const { log, ops, changes } = setup();
    await ops.refreshWatches();
    await ops.refreshPrs(true);
    expect(changes.map((c) => c.kind)).toEqual(["rows", "me", "paused", "prs"]);
    expect(changes[3]).toMatchObject({ kind: "prs", merged: [{ number: 2 }] });
    expect(log).toEqual(["… Loading your PRs…"]);
  });

  test("a PR refresh without the merged list leaves the store's merged list alone", async () => {
    const { ops, changes } = setup();
    await ops.refreshPrs(false);
    expect(changes).toEqual([{ kind: "prs", open: [pr("o/r", 1)] }]);
  });

  test("topics report progress; failed loads throw, so the tab can show the error", async () => {
    const { port, log, ops } = setup();
    expect(await ops.loadTopics("ses_1", false, false)).toEqual([{ name: "CI", prs: ["o/r#1"] }]);
    await ops.loadTopics("ses_1", false, true);
    expect(log).toEqual(["… Sorting your PRs into topics…", "… Updating the topics…"]);
    port.failing = "myPrs";
    await expect(ops.refreshPrs(false)).rejects.toThrow("myPrs broke");
  });
});

describe("check now: the reload button makes every watch check GitHub", () => {
  test("says the watches are checking, or that they just did", async () => {
    const { port, log, ops } = setup();
    await ops.checkNow();
    port.recentCheck = true;
    await ops.checkNow();
    expect(port.calls).toEqual(["checkNow", "checkNow"]);
    expect(log).toEqual([
      "… Asking every watch to check GitHub…", "Every watch is checking GitHub now.",
      "… Asking every watch to check GitHub…", "The watches checked GitHub less than 20 seconds ago.",
    ]);
  });

  test("a failure says why", async () => {
    const { port, log, ops } = setup();
    port.failing = "checkNow";
    expect(await ops.checkNow()).toBe(false);
    expect(log.at(-1)).toBe("Could not ask the watches to check: checkNow broke");
  });
});

describe("reviews: explain a PR in its own session, then submit the review", () => {
  test("loading the PRs waiting for review reports progress", async () => {
    const { port, log, ops } = setup();
    expect(await ops.loadReviews(["o/a", "o/b"])).toEqual([request]);
    expect(port.calls).toEqual(["reviewRequests o/a,o/b"]);
    expect(log).toEqual(["… Loading the PRs waiting for your review…"]);
  });

  test("explain: a review session with the open session's model, asked to explain that commit, then opened", async () => {
    const { port, ops } = setup();
    expect(await ops.explain(from, request)).toBe(true);
    expect(port.calls).toEqual([
      "session ses_1",
      'createSession Review: o/r#7 Add login in /work with {"providerID":"p","id":"m"} build',
      `prompt ses_new ${explainPrompt(request)}`,
      "open local ses_new",
    ]);
  });

  test("explaining again after new commits asks about the changes since the explained commit", async () => {
    const { port, ops } = setup();
    await ops.explain(from, { ...request, headSha: "new456" }, "abc123");
    expect(port.calls[2]).toContain("abc123..new456");
  });

  test("a failed explanation says why and returns false, so the button stays on Explain", async () => {
    const { port, log, ops } = setup();
    port.failing = "createSession";
    expect(await ops.explain(from, request)).toBe(false);
    expect(log.at(-1)).toBe("Could not start a review session: createSession broke");
  });

  test("submit: sends the review on the reviewed commit and says what came of it", async () => {
    const { port, log, ops } = setup();
    expect(await ops.submitReview(request, "APPROVE", "LGTM")).toBe(true);
    expect(port.calls).toEqual(["submitReview o/r#7 APPROVE at abc123: LGTM"]);
    expect(log).toEqual(["… Submitting the review of o/r#7…", "Approved o/r#7."]);
  });

  test("a review GitHub would refuse is never sent", async () => {
    const { port, log, ops } = setup();
    expect(await ops.submitReview(request, "REQUEST_CHANGES", "")).toBe(false);
    expect(port.calls).toEqual([]);
    expect(log).toEqual(["A change request needs some text."]);
  });

  test("a refused review says why", async () => {
    const { port, log, ops } = setup();
    port.failing = "submitReview";
    expect(await ops.submitReview(request, "APPROVE", "")).toBe(false);
    expect(log.at(-1)).toBe("Could not submit the review of o/r#7: submitReview broke");
  });
});

describe("activities: the work in progress the top line shows", () => {
  test("listed while running, gone when done or failed, in order", async () => {
    const seen: string[][] = [];
    const tracker = activities((now) => seen.push(now));
    let finish!: () => void;
    const slow = tracker.track("Loading", new Promise<void>((resolve) => (finish = resolve)));
    await tracker.track("Quick", Promise.resolve()).catch(() => undefined);
    await tracker.track("Broken", Promise.reject(new Error("x"))).catch(() => undefined);
    finish();
    await slow;
    expect(seen).toEqual([["Loading"], ["Loading", "Quick"], ["Loading"], ["Loading", "Broken"], ["Loading"], []]);
  });
});

describe("errorText: why something failed, from whatever was thrown", () => {
  test("an Error, an RPC error object, a string, or anything else", () => {
    expect(errorText(new Error("gh failed"))).toBe("gh failed");
    expect(errorText({ message: "plugin reloading" })).toBe("plugin reloading");
    expect(errorText({ error: { message: "not found" } })).toBe("not found");
    expect(errorText({ data: { message: "timeout" } })).toBe("timeout");
    expect(errorText("plain")).toBe("plain");
    expect(errorText({ code: 502 })).toBe('{"code":502}');
  });
});
