# Contributing

Telium is a monorepo for the whole system — client, homeserver, SFU, protocol — and [docs/development.md](docs/development.md) is the working setup guide: how to run the pieces, which tests cover which boundary, and what a change is expected to carry before review. The short version of the tests is in the [README](README.md#development).

Most work starts from [roadmap.md](roadmap.md) and [important-todo.md](important-todo.md); read the docs around what you are changing, because stale documentation is treated as a bug here.

## Where does this go?

Not everything belongs in a public issue. The fastest way to get ignored is to file in the wrong place, so:

| What you have | Where it goes |
| --- | --- |
| The client or a server did something wrong | [Bug report](.github/ISSUE_TEMPLATE/bug_report.yml) |
| Something Telium does not do that you wish it did | [Feature idea](.github/ISSUE_TEMPLATE/feature_request.yml) |
| Something that could expose an account, a server, or a message | Private disclosure — [SECURITY.md](SECURITY.md), never a public issue |
| A message or an account breaks a server's rules | Report it to that server's operators through the client; they are the ones who can act |
| Feedback that fits no template | A blank issue — the chooser lets you open one |
| A change | A pull request, with the docs and tests it makes untrue updated in the same PR |

## What makes a good bug report

The client writes most of one for you: *Settings → Connected servers → Copy diagnostics* produces a report deliberately built to be safe to paste into a public issue — no messages, no drafts, no names, no credentials — and the footer of the settings screen has the build line that says exactly which code you were running. Attach the first and quote the second.

For a homeserver, [docs/getting-help.md](docs/getting-help.md) lists the server-side equivalents.
