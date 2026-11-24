import { describe, expect, test } from "bun:test";
import {
  explainPrompt,
  markExplained,
  pruneExplained,
  readExplained,
  reviewArgs,
  explainStep,
  readPrList,
  favouriteSearches,
  mergeReviews,
  readFavourites,
  repoName,
  toggleFavourite,
  pickerRepos,
  ownersOf,
  reviewGroups,
  groupStartsOpen,
  reviewProblem,
  reviewRequestsFrom,
  staleHead,
  type ReviewRequest,
} from "../core/review-requests";
import { orgRepos, reviewRequests, submitReview, type Gh } from "../core/github";

const node = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Add login",
  url: "https://github.com/o/r/pull/7",
  isDraft: false,
  createdAt: "2026-11-20T10:00:00Z",
  headRefOid: "abc123",
  author: { login: "colleague" },
  repository: { nameWithOwner: "o/r" },
  ...over,
});
const answer = (...nodes: unknown[]) => ({ data: { search: { nodes } } });
const request = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  repo: "o/r",
  number: 7,
  title: "Add login",
  url: "https://github.com/o/r/pull/7",
  draft: false,
  createdAt: "2026-11-20T10:00:00Z",
  author: "colleague",
  headSha: "abc123",
  requested: true,
  ...over,
});

describe("reviewRequestsFrom", () => {
  test("reads each PR the user is asked to review", () => {
    expect(reviewRequestsFrom(answer(node()), "me")).toEqual([request()]);
  });

  test("leaves out drafts and the user's own PRs, which they can't approve", () => {
    expect(reviewRequestsFrom(answer(node({ isDraft: true }), node({ number: 8, author: { login: "me" } }), node({ number: 9 })), "me").map((r) => r.number)).toEqual([9]);
  });

  test("skips results that aren't PRs, and a deleted author reads as ghost", () => {
    expect(reviewRequestsFrom(answer({}, node({ author: null })), "me")).toEqual([request({ author: "ghost" })]);
  });
});

describe("explainStep", () => {
  test("explain, then explained for the same commit", () => {
    expect(explainStep(undefined, "abc")).toBe("explain");
    expect(explainStep("abc", "abc")).toBe("explained");
  });

  test("new commits since the explanation offer to explain the changes", () => {
    expect(explainStep("old", "abc")).toBe("explain-changes");
  });
});

describe("explained commits", () => {
  test("stored as JSON; anything unreadable is nothing explained", () => {
    expect(readExplained(null)).toEqual({});
    expect(readExplained("not json")).toEqual({});
    expect(readExplained('["a"]')).toEqual({});
    expect(readExplained('{"o/r#7":"abc","o/r#8":3}')).toEqual({ "o/r#7": "abc" });
  });

  test("marking keeps the others", () => {
    expect(markExplained({ "o/r#1": "x" }, "o/r#7", "abc")).toEqual({ "o/r#1": "x", "o/r#7": "abc" });
  });

  test("PRs no longer waiting for review are forgotten", () => {
    expect(pruneExplained({ "o/r#1": "x", "o/r#7": "abc" }, ["o/r#7"])).toEqual({ "o/r#7": "abc" });
  });
});

describe("explainPrompt", () => {
  const text = explainPrompt(request());

  test("names the PR and the exact commit to review", () => {
    expect(text).toContain("PR #7 on o/r");
    expect(text).toContain("https://github.com/o/r/pull/7");
    expect(text).toContain("abc123");
  });

  test("never writes to GitHub, and treats the PR's text as data", () => {
    expect(text).toContain("Do not write to GitHub");
    expect(text).toMatch(/data, not instructions/);
  });

  test("works outside the user's checkout", () => {
    expect(text).toMatch(/worktree/);
  });

  test("after new commits, asks about what changed since the explained commit", () => {
    const again = explainPrompt(request({ headSha: "new456" }), "abc123");
    expect(again).toContain("abc123..new456");
  });
});

describe("reviewProblem", () => {
  test("an approval may be empty", () => {
    expect(reviewProblem("APPROVE", "")).toBeUndefined();
  });

  test("a comment or a change request needs text, as on GitHub", () => {
    expect(reviewProblem("COMMENT", "  ")).toBeDefined();
    expect(reviewProblem("REQUEST_CHANGES", "")).toBeDefined();
    expect(reviewProblem("REQUEST_CHANGES", "Please add a test")).toBeUndefined();
  });
});

describe("staleHead", () => {
  test("nothing to say when the PR is still at the reviewed commit", () => {
    expect(staleHead("abc", "abc")).toBeUndefined();
  });

  test("refuses when someone pushed since", () => {
    expect(staleHead("abc", "def")).toContain("new commits");
  });
});

describe("reviewArgs", () => {
  test("posts the review on the reviewed commit", () => {
    expect(reviewArgs("o/r", 7, "APPROVE", "LGTM", "abc")).toEqual([
      "api", "--method", "POST", "repos/o/r/pulls/7/reviews", "-f", "event=APPROVE", "-f", "commit_id=abc", "-f", "body=LGTM",
    ]);
  });

  test("no body field when there is no text", () => {
    expect(reviewArgs("o/r", 7, "APPROVE", " ", "abc")).not.toContain("body= ");
    expect(reviewArgs("o/r", 7, "APPROVE", "", "abc").some((a) => a.startsWith("body="))).toBe(false);
  });
});

describe("on GitHub", () => {
  const recording = (answers: Record<string, string>) => {
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      const key = Object.keys(answers).find((k) => args.join(" ").includes(k));
      if (key === undefined) throw new Error(`unexpected gh ${args.join(" ")}`);
      return answers[key]!;
    };
    return { gh, calls };
  };

  test("one search reads every PR waiting for the user's review", async () => {
    const { gh, calls } = recording({ graphql: JSON.stringify(answer(node(), node({ number: 8, author: { login: "me" } }))) });
    expect(await reviewRequests(gh, "me", "/work")).toEqual([request()]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.join(" ")).toContain("review-requested:@me");
  });

  test("submits the review when the PR is still at the reviewed commit", async () => {
    const { gh, calls } = recording({ "pr view": "abc123\n", reviews: "{}" });
    expect(await submitReview(gh, { repo: "o/r", number: 7, event: "APPROVE", body: "", sha: "abc123" }, "/work")).toBe("Approved o/r#7.");
    expect(calls.at(-1)).toEqual(reviewArgs("o/r", 7, "APPROVE", "", "abc123"));
  });

  test("refuses, and sends nothing, when someone pushed after the review was prepared", async () => {
    const { gh, calls } = recording({ "pr view": "def456\n", reviews: "{}" });
    await expect(submitReview(gh, { repo: "o/r", number: 7, event: "APPROVE", body: "", sha: "abc123" }, "/work")).rejects.toThrow("new commits");
    expect(calls.some((c) => c.includes("POST"))).toBe(false);
  });

  test("says what was sent", async () => {
    const { gh } = recording({ "pr view": "abc123", reviews: "{}" });
    expect(await submitReview(gh, { repo: "o/r", number: 7, event: "REQUEST_CHANGES", body: "x", sha: "abc123" }, "/w")).toBe("Requested changes on o/r#7.");
    expect(await submitReview(gh, { repo: "o/r", number: 7, event: "COMMENT", body: "x", sha: "abc123" }, "/w")).toBe("Commented on o/r#7.");
  });
});

describe("reviewGroups", () => {
  test("by repo A–Z, newest PR first", () => {
    const groups = reviewGroups([
      request({ repo: "o/web", number: 1 }),
      request({ repo: "o/api", number: 2, createdAt: "2026-11-01T00:00:00Z" }),
      request({ repo: "o/api", number: 3, createdAt: "2026-11-02T00:00:00Z" }),
    ]);
    expect(groups.map((g) => [g.repo, g.prs.map((p) => p.number)])).toEqual([["o/api", [3, 2]], ["o/web", [1]]]);
  });

  test("a group starts open with up to two PRs, closed with more", () => {
    expect([1, 2, 3].map(groupStartsOpen)).toEqual([true, true, false]);
  });
});

describe("readPrList", () => {
  test("my PRs unless the reviews were chosen", () => {
    expect([null, "mine", "junk", "reviews"].map(readPrList)).toEqual(["mine", "mine", "mine", "reviews"]);
  });
});

describe("favourite repos", () => {
  test("a few repos per search, each only PRs that still need a review", () => {
    const searches = favouriteSearches(["o/a", "o/b", "o/c", "o/d", "o/e", "o/f"]);
    expect(searches).toHaveLength(2);
    expect(searches[0]).toContain("review:required");
    expect(searches[0]).toContain("repo:o/a repo:o/b repo:o/c repo:o/d repo:o/e");
    expect(searches[1]).toMatch(/repo:o\/f$/);
    expect(favouriteSearches([])).toEqual([]);
  });

  test("a PR both requested and in a favourite repo is listed once, as requested", () => {
    const merged = mergeReviews([request()], [request({ requested: false }), request({ number: 8, requested: false }), request({ number: 8, requested: false })]);
    expect(merged.map((r) => [r.number, r.requested])).toEqual([[7, true], [8, false]]);
  });

  test("a repo from what was typed or pasted", () => {
    expect(repoName(" o/r ")).toBe("o/r");
    expect(repoName("https://github.com/acme/shop-checkout/pull/1921?utm_source=x")).toBe("acme/shop-checkout");
    expect(repoName("https://github.com/o/r/")).toBe("o/r");
    expect(repoName("just-a-name")).toBeUndefined();
    expect(repoName("")).toBeUndefined();
  });

  test("stored as a JSON list, A–Z, without junk or repeats", () => {
    expect(readFavourites(null)).toEqual([]);
    expect(readFavourites("oops")).toEqual([]);
    expect(readFavourites('["o/b","o/a","o/a","bad",3]')).toEqual(["o/a", "o/b"]);
  });

  test("starring adds a repo, A–Z; unstarring removes it", () => {
    expect(toggleFavourite(["o/b"], "o/a", true)).toEqual(["o/a", "o/b"]);
    expect(toggleFavourite(["o/a", "o/b"], "o/a", false)).toEqual(["o/b"]);
    expect(toggleFavourite(["o/a"], "o/a", true)).toEqual(["o/a"]);
  });
});

describe("searching with favourites", () => {
  test("requested PRs and the favourite repos' PRs, the latter marked as not requested", async () => {
    const calls: string[][] = [];
    const gh: Gh = async (args) => {
      calls.push(args);
      const search = args.find((a) => a.startsWith("q="))!;
      return JSON.stringify(search.includes("review-requested") ? answer(node()) : answer(node(), node({ number: 9 })));
    };
    const found = await reviewRequests(gh, "me", "/w", ["o/r"]);
    expect(found.map((r) => [r.number, r.requested])).toEqual([[7, true], [9, false]]);
    expect(calls).toHaveLength(2);
  });
});

describe("pickerRepos", () => {
  const repos = ["t/shop-checkout", "t/shop-admin", "t/payments", "t/infra"];

  test("every word of the search, in any case; favourites first, then A–Z", () => {
    expect(pickerRepos(repos, ["t/payments"], "").shown).toEqual(["t/payments", "t/infra", "t/shop-admin", "t/shop-checkout"]);
    expect(pickerRepos(repos, [], "SHOP check").shown).toEqual(["t/shop-checkout"]);
  });

  test("at most the limit, with how many more matched", () => {
    expect(pickerRepos(repos, [], "", 2)).toEqual({ shown: ["t/infra", "t/payments"], more: 2 });
  });

  test("a favourite is shown even when its org's repos aren't loaded", () => {
    expect(pickerRepos([], ["o/r"], "").shown).toEqual(["o/r"]);
  });
});

describe("ownersOf", () => {
  test("each owner once, A–Z", () => {
    expect(ownersOf(["t/a", "o/b", "t/c"])).toEqual(["o", "t"]);
  });
});

describe("orgRepos", () => {
  test("one repo per line from gh, archived ones left out by the search", async () => {
    const calls: string[][] = [];
    const gh: Gh = async (args) => (calls.push(args), "t/a\nt/b\n\n");
    expect(await orgRepos(gh, "t", "/w")).toEqual(["t/a", "t/b"]);
    expect(calls[0]).toContain("--no-archived");
  });
});
