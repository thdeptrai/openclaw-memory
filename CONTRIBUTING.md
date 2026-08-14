# Contributing

## Reporting issues

Before opening anything, check the existing issues (open and closed) — your problem or idea may already be there. If it's an installation problem, also check [SETUP.md](SETUP.md) first.

### Bugs

Use the bug report template. Two things we can't debug without:

- **Version or commit** — `git log -1 --format=%h` (or the release tag). "Latest" is not a version.
- **Logs** — output of `docker compose logs memolo` around the failure. No logs, no debugging.

A good report states what you expected, what happened, and the shortest steps to reproduce. If the server crashed, include the full stack trace, not just the last line.

### Feature requests

Use the feature request template. Focus on the problem you're trying to solve; the solution is what we discuss in the thread.

## Labels

| Label | Meaning |
|---|---|
| `bug` / `enhancement` | default issue type |
| `server` / `dashboard` / `sdk` / `plugin` | which component |
| `docker` / `setup` | deployment and installation problems |
| `question` | usage questions, not bugs |
| `good first issue` | friendly to newcomers, little context needed |
| `help wanted` | maintainer needs input, can't reproduce, or wants a hand |
| `duplicate` / `wontfix` / `invalid` | triage outcomes, closed with a short note |

Component labels are created by `scripts/create-github-labels.sh` (run once per repo, e.g. after a transfer).

## Commits

Conventional commits, matching the existing history:

- `feat:` new feature
- `fix:` bug fix
- `docs:` docs/comments
- `chore:` maintenance, deps, scripts
- `perf:`, `refactor:`, `test:`, `style:` — as expected

The description says what and why, not how. One logical change per commit (usually 1–4 files).

## Pull requests

- Branch from `master`: `feat/x`, `fix/x`, `docs/x`. No direct commits to master.
- One PR per thing. If the diff touches unrelated files, split it.
- Run the tests before asking for review: `node test-runner.js` against a running stack (see the header of that file for options), and the eval pipeline (`eval/`) if your change touches prompt or LLM logic.
- Fill in the PR description: what changed, why, and how you tested it.
- Wait for a review — don't merge your own PR.

## Triaging issues (maintainers)

- Apply the component label when it's obvious; leave it otherwise.
- Close duplicates with a link to the original issue.
- Use `help wanted` when you need more info or can't reproduce.
- Keep `good first issue` candidates small and self-contained, with a hint about where the relevant code lives.
