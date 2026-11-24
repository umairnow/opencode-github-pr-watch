import type { MyPr } from "./my-prs";
import type { LoadedPrs, PanelPort } from "./panel-operations";
import type { Tone } from "./panel-text";

/**
 * Made-up PRs and watches for screenshots: the GUI uses this port instead of the app's when the localStorage flag
 * `pr-watch.demo` is "true". Nothing here reaches GitHub or a model.
 */
export const DEMO_KEY = "pr-watch.demo";

export interface DemoRow {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly detail: string;
  readonly tone: Tone;
  readonly runUrl?: string;
  readonly runLinks?: readonly { readonly label: string; readonly url: string }[];
  readonly sessionID?: string;
  readonly sessionTitle?: string;
  readonly author?: string;
  readonly state?: "OPEN" | "MERGED" | "CLOSED";
}

const DAY = 86_400_000;
const ago = (now: number, days: number) => new Date(now - days * DAY).toISOString();
const url = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

export function demoData(sessionID: string, now: number): LoadedPrs & { readonly rows: readonly DemoRow[]; readonly sessionRows: readonly DemoRow[]; readonly me: string } {
  const pr = (repo: string, number: number, title: string, days: number, extra: Partial<MyPr> = {}): MyPr => ({
    repo, number, title, url: url(repo, number), draft: false, createdAt: ago(now, days), ...extra,
  });
  const open = [
    pr("acme/shop", 412, "Add gift cards to checkout", 2),
    pr("acme/shop", 418, "Cache product images at the edge", 0),
    pr("acme/shop", 405, "Try a new search ranking", 9, { draft: true }),
    pr("acme/api", 77, "Rate limit the public endpoints", 4),
    pr("acme/api", 81, "Upgrade the web framework", 1),
    pr("acme/infra", 23, "Move the database to the new region", 6),
  ];
  const merged = [
    pr("acme/shop", 399, "Fix rounding in the cart total", 5, { closedAt: ago(now, 1) }),
    pr("acme/api", 70, "Log request IDs", 8, { closedAt: ago(now, 3) }),
  ];
  const here = { sessionID, sessionTitle: "Checkout work" };
  const sessionRows: DemoRow[] = [
    { id: "acme/shop#412", label: "acme/shop#412 Add gift cards to checkout", url: url("acme/shop", 412), detail: "deploying 3/5 · prod", tone: "pending", runUrl: "https://github.com/acme/shop/actions/runs/1", author: "demo", state: "OPEN", ...here },
    { id: "acme/api#77", label: "acme/api#77 Rate limit the public endpoints", url: url("acme/api", 77), detail: "waiting for code review", tone: "waiting", author: "demo", state: "OPEN", ...here },
    { id: "acme/api#81", label: "acme/api#81 Upgrade the web framework", url: url("acme/api", 81), detail: "checks failed: integration-tests", tone: "failed", runUrl: "https://github.com/acme/api/actions/runs/2", author: "demo", state: "OPEN", ...here },
  ];
  const rows: DemoRow[] = [
    ...sessionRows,
    { id: "acme/infra#23", label: "acme/infra#23 Move the database to the new region", url: url("acme/infra", 23), detail: "ready for merge", tone: "done", author: "demo", state: "OPEN", sessionID: "ses_other", sessionTitle: "Database move" },
    { id: "acme/shop#420", label: "acme/shop#420 Bump the image library from 4.1 to 4.2", url: url("acme/shop", 420), detail: "checks running 4/6", tone: "pending", author: "dependabot", state: "OPEN", sessionID: "ses_other", sessionTitle: "Dependency updates" },
    { id: "acme/shop run 9001", label: "acme/shop run 9001 Nightly end-to-end tests", url: "https://github.com/acme/shop/actions/runs/9001", detail: "running 12/20 jobs", tone: "pending", runUrl: "https://github.com/acme/shop/actions/runs/9001", ...here },
  ];
  return { open, merged, rows, sessionRows, me: "demo" };
}

/** A port that serves the demo data and accepts every action without doing anything. */
export function demoPort(sessionID: () => string, now: () => number): PanelPort {
  return {
    myPrs: async (merged) => {
      const data = demoData(sessionID(), now());
      return { open: data.open, ...(merged ? { merged: data.merged } : {}) };
    },
    watches: async () => {
      const data = demoData(sessionID(), now());
      return { rows: data.rows, me: data.me };
    },
    myPrTopics: async () => [
      { name: "Checkout", prs: ["acme/shop#412", "acme/shop#399", "acme/shop#405"] },
      { name: "Performance", prs: ["acme/shop#418", "acme/api#77"] },
      { name: "Upgrades and infrastructure", prs: ["acme/api#81", "acme/shop#420", "acme/infra#23", "acme/api#70"] },
    ],
    watch: async (_, pr) => `Watching ${pr}. Demo mode`,
    unwatch: async () => undefined,
    checkNow: async () => true,
    session: async () => ({ model: undefined, agent: undefined }),
    createSession: async () => "ses_demo",
    prompt: async () => undefined,
    openSession: () => undefined,
    copy: async () => undefined,
    reviewRequests: async () => [
      { repo: "acme/api", number: 88, title: "Rate limit the login endpoint", url: "https://github.com/acme/api/pull/88", draft: false, createdAt: new Date(now() - 5 * 3_600_000).toISOString(), author: "colleague", headSha: "4f2a9c1e0b7d", requested: true },
      { repo: "acme/web", number: 31, title: "Bump the design system", url: "https://github.com/acme/web/pull/31", draft: false, createdAt: new Date(now() - 26 * 3_600_000).toISOString(), author: "renovate", headSha: "9b1d07aa3c2e", requested: false },
    ],
    orgRepos: async () => ["acme/api", "acme/infra", "acme/shop", "acme/web"],
    submitReview: async (input) => `Demo mode: nothing sent for ${input.repo}#${input.number}`,
  };
}
