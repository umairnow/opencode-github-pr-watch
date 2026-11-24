# opencode-github-pr-watch

An OpenCode V2 plugin that watches GitHub pull requests and workflow runs in the background, and tells the session when something changes or a person has to act, until the change is deployed. The agent no longer has to poll with `sleep`.

Code reads the facts from `gh` and reports every change of where a PR is: checks passed or failed, review, merge, deploy. A light model from the session's own provider only judges what the rules don't cover, such as a failure's cause or something unexpected in a run.

> **Note:** this plugin grew out of my own day-to-day work, so it may assume naming or conventions (job names, how deploys and approvals are set up in GitHub Actions) that don't match yours. If something is reported wrongly or not at all, please [open an issue](https://github.com/anderssv/opencode-github-pr-watch/issues) with what you expected and what happened. I'll do my best to fix it. The [debug log](docs/configuration.md#debug-log) usually shows what the plugin saw and decided.

## Install

Requires OpenCode V2 (2.3 or later), the GitHub CLI `gh` logged in to the repos you watch, and a provider with a light model (haiku, mini, flash). Add it to `~/.config/opencode/opencode.json`:

```jsonc
{ "plugins": [{ "package": "opencode-github-pr-watch" }] }
```

## Use

- **`watch_pr`** with one or more PRs (`123`, `owner/repo#123`, a PR URL) or a workflow run link. Watches also start by themselves after `gh pr create`, `git push` to a branch with a PR, `gh pr merge`, `gh pr update-branch`, `gh run rerun` and `gh workflow run`.
- **`unwatch_pr`** stops a watch. **`list_pr_watches`** shows this session's watches and where each one is.
- **What you hear:** every change of step, so silence means nothing changed, and progress within a step as the PR's track (`Checks … 4/5 · Review · Merge · Deploy`), at most once a minute and without waking the agent.
- **A watch ends** when the PR is done: deployed, merged with no deploy, or closed. Something to fix (checks failed, changes requested) wakes the agent and the watch follows the fix; a review, a run approval or the merge only informs, and waits without a time limit. A watch with no change for 14 days ends.

In the OpenCode desktop app, a pill above the composer shows the session's watches, and a **PRs** tab in the side panel lists your open PRs and all watches, grouped by repo or by topic, and the PRs waiting for your review, which you can have explained in a new session and then review (comment, approve or request changes) from the panel. See [Desktop](docs/desktop.md).

![The PRs tab, grouped by topic](docs/images/prs-topics.png)

![The pill above the composer, opened](docs/images/pill.png)

## Options

All optional:

```jsonc
"options": {
  "preferences": ["haiku", "mini", "flash"], // which model of the session's provider judges changes
  "maxMinutes": 30,                           // time limit for a build or deploy with too little history
  "debugLog": true,                           // JSON-lines log of every decision; false, or a path
  "analyseComments": false                    // let the light model summarise new comments; read the warning first
}
```

`analyseComments` puts what other people's comments say (as a model's short summary) into the agent's context, a route for prompt injection. Read [the warning](docs/configuration.md#reading-comments-analysecomments) before turning it on.

The full list is in [Configuration](docs/configuration.md).

## Docs

- [How watching works](docs/how-it-works.md): what is reported and when, time limits, deploy detection, failures, automatic starts, the provider guard.
- [Desktop](docs/desktop.md): the pill and the PRs tab.
- [Configuration](docs/configuration.md): all options, the debug log, notifications.
- [Development](docs/development.md): tests, building the desktop bundle, publishing.

## License

MIT
