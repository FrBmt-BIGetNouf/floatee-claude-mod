# Floatee mod for Claude Code

Your [Floatee](https://floatee.me) backlog above Claude Code's prompt, in the terminal and the desktop app.

- The project's open todos in a band above the prompt, or in a side pane on a wide screen
- **▶ Run** (`/todo #N`) and **▷ Guided** (`/todo-guided #N`) on each ticket, **Run next** and **Stop**
- The ticket in progress with its checklist, ticked from there
- **✎ New** ticket, **◐ Mine** filter, ↑ ↓ reorder, **◉ Watch** to process the todos as they come
- A toast when someone replies to a blocked ticket

## Install

In Claude Code:

```
/plugin marketplace add FrBmt-BIGetNouf/floatee-claude-mod
/plugin install floatee@floatee
```

Claude Code keeps it up to date. You can also download it from Floatee
(Settings → Your agent) and unzip it into `~/.claude/skills/`: one way or the other,
not both, or it shows twice.

## Requirements

- A `.floatee` file at the repo root (`token=flt_…`, `api=…`, `project=<slug>`): create a
  token in Floatee under Settings → Your agent.
- The `/todo`, `/todo-guided` and `/todo-auto` commands, from any Floatee agent kit (curl
  included), for the Run, Guided and Watch buttons. The list itself only needs `.floatee`.

## Safety

- The mod reads `.floatee` itself and never shows the token; it masks a token printed by
  any command, and keeps Claude from reading the file.
- It never creates a project (`create=0` on every request).
- One ticket in progress per session, and no closing before a check (tests, lint, build)
  passed or you replied.

More in the [docs](https://floatee.me/docs#claude-code).

## Development

This repository is published from the Floatee app's repository
(`public/agent-kit/claude-mod/`); changes go there. Check with:

```
claude plugin validate .
claude plugin test .
```

## License

MIT, see [LICENSE](LICENSE).
