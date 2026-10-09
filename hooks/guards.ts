// Floatee mod, guards: what the /todo skills can only ask, enforced on every
// tool call (the main loop and subagents alike). Each refusal tells the agent
// what to do instead.
//
// G1  the agent never reads `.floatee` (the token would enter the context)
// G1b a Floatee token in any tool output is masked before the model reads it
// G2  no call that could create a project by accident (no `.floatee`, a
//     `--project` override without `--no-create`, a raw API call without `create=0`)
// G3  the rendering of `floatee get` is never saved back as a body
// G5  one ticket in progress per session
// G4  no `floatee done` on that ticket before a verification command passed or
//     the user spoke since it was started. The defaults cover the common test /
//     lint / typecheck / build commands; `verify=cmd1, cmd2` in `.floatee` adds
//     the repo's own.
import type { Config } from './config'

// flt_ + 43 base64url chars (32 random bytes). Shorter look-alikes (doc
// placeholders, test fixtures) are left alone so files stay editable.
export const TOKEN_RE = /flt_[A-Za-z0-9_-]{40,}/g
const MASK = 'flt_[hidden by the floatee mod]'

// `.floatee` as a path, not as a word inside another name (floatee.mjs,
// Floatee/) nor an escaped regex (`grep "\.floatee"`).
const DOTFILE_RE = /(^|[^\w.\\-])\.floatee(?![\w.-])/
// Prose that merely names the file (a ticket body, a commit message): heredocs
// and quoted strings holding a space. A path is a single word.
const PROSE_RE = /<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2(?=\s|$)|"[^"\n]*\s[^"]*"|'[^'\n]*\s[^']*'/g
// An existence test is fine: it prints nothing of the file.
const EXISTS_RE = /(test\s+-[efs]|\[\s+-[efs])\s+["']?[^\s;&|"']*\.floatee["']?(\s*\])?/g

// One CLI invocation: the script (node floatee.mjs, python floatee.py,
// ./floatee.sh or floatee on the PATH), its subcommand and its arguments up to
// the next shell separator.
const CLI_RE = /(?:^|[\s;&|(`"'])(?:node\s+\S*floatee\.mjs|python3?\s+\S*floatee\.py|\S*floatee\.sh|floatee)\s+([a-z]+)([^\n;&|`)]*)/g
const PROJECT_CMDS = new Set(['next', 'claim', 'get', 'start', 'pending', 'reopen', 'done', 'wontfix', 'block', 'comment', 'snooze', 'wake', 'edit', 'update', 'rm', 'add', 'assign', 'reorder', 'search', 'ls', 'project', 'fetch'])
// What `floatee get` prints that a body never starts with: its heading and
// status line (at a line start, or right after the quote opening an argument).
const RENDERING_RE = /(^|["'])[ \t]*#\s*\[#\d+\][^\n]*\n-\s+status:/m

const VERIFY_DEFAULTS = [
	/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|type-check|check|build|generate)\b/,
	/\b(vue-tsc|tsc|eslint|vitest|jest|playwright|mocha|biome|stylelint)\b/,
	/\b(pytest|tox|nox|ruff|mypy|pyright|flake8)\b|\bpython3?\s+-m\s+(pytest|unittest)\b/,
	/\bcargo\s+(test|check|clippy|build)\b/,
	/\bgo\s+(test|vet|build)\b/,
	/\bphp(\.exe)?\s+-l\b|\b(phpunit|phpstan|psalm|pest)\b/,
	/\bmake\s+(test|check|lint)\b/,
	/\b(mvn|gradle|gradlew)\b.*\b(test|verify|check)\b/,
	/\bdotnet\s+(test|build)\b/,
	/\b(rspec|rubocop)\b|\brake\s+test\b/,
	/\bdeno\s+(test|check|lint)\b|\bswift\s+(test|build)\b/,
	/\bnuxi?\s+(generate|build|typecheck)\b/,
	/\bclaude\s+plugin\s+(test|validate)\b/,
]

type Call = { cmd: string; args: string; id: number | null }

// #669: what a command runs, its prose left out: a heredoc's body (a script,
// a comment's text) and a quoted string holding a space are data, unless the
// string is a shell's own command (`bash -c "…"`, `sh -c '…'`).
function runnable(command: string): string {
	return command.replace(PROSE_RE, (text: string, ...rest: unknown[]) => {
		const at = rest[rest.length - 2] as number
		return !text.startsWith('<<') && /(^|\s)-c\s+$/.test(command.slice(0, at)) ? text : ' '
	})
}

export function cliCalls(command: string): Call[] {
	const out: Call[] = []
	for (const m of runnable(command).matchAll(CLI_RE)) {
		const cmd = m[1] ?? ''
		const args = m[2] ?? ''
		if (!PROJECT_CMDS.has(cmd) && !['projects', 'workspaces', 'init', 'selfupdate', 'help'].includes(cmd)) continue
		const id = args.match(/^\s+#?(\d+)\b/)
		out.push({ cmd, args, id: id && id[1] ? Number(id[1]) : null })
	}
	return out
}

export function isVerification(command: string, extra: string[]): boolean {
	return VERIFY_DEFAULTS.some(re => re.test(command)) || extra.some(s => command.includes(s))
}

// A copy of a tool's record with every token masked; the same object when none.
export function mask(value: unknown): unknown {
	if (typeof value === 'string') return value.replace(TOKEN_RE, MASK)
	if (Array.isArray(value)) return value.map(mask)
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]))
	return value
}

// What a refusal needs to know: the repo's config (null without one), the
// ticket this session works on and its G4 flags, and the file a write
// redirects its body from (`< file`), read by the caller.
export type Context = { config: Config | null; active: number | null; verified: boolean; heard: boolean; bodyFile: string }

// The file a shell command feeds on stdin (`< path`), if any.
export function redirectedFile(command: string): string | null {
	const file = command.match(/(?<![<0-9])<\s*["']?([^\s"'<>|;&()]+)/)
	return file && file[1] ? file[1] : null
}

// Why this call must not run, or null.
export function refusal(e: { tool: string } & Record<string, unknown>, ctx: Context): string | null {
	const { config } = ctx
	const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
	const READ_NOTE = 'The floatee mod keeps `.floatee` out of the conversation: it holds the API token. Use the `floatee` CLI, which reads it itself (`floatee project` shows the project).'

	// G1: the file itself, through the file tools or a shell command.
	if (['Read', 'Edit', 'NotebookEdit'].includes(e.tool) && /(^|[\\/])\.floatee$/.test(str('file_path') || str('notebook_path'))) return READ_NOTE
	if (e.tool === 'Grep' && (/(^|[\\/])\.floatee$/.test(str('path')) || /floatee/.test(str('glob')) && /^\.|[\\/]\./.test(str('glob')))) return READ_NOTE
	if (e.tool !== 'Bash') return null
	const command = str('command')
	if (DOTFILE_RE.test(command.replace(PROSE_RE, '').replace(EXISTS_RE, ''))) return `${READ_NOTE} To check that it exists: \`test -f .floatee\`.`

	const calls = cliCalls(command)

	// G2: nothing that could mint a project.
	if (!config && calls.some(c => PROJECT_CMDS.has(c.cmd)))
		return 'No `.floatee` in this repo: a Floatee call here could create a project by accident. Run `floatee projects` (creates nothing), agree on a slug with the user, then `floatee init --token flt_… --project <slug>`.'
	const override = calls.find(c => /--project\b/.test(c.args) && !/--no-create\b/.test(c.args))
	if (override) return '`--project` names a project that may not exist, and the CLI would create it. Add `--no-create` (a 404 instead), or check the slug with `floatee projects` first.'
	if (/\bcurl\b/.test(command) && /\/api\/v1\//.test(command) && /[?&]project=/.test(command) && !/[?&]create=0\b/.test(command))
		return 'A raw API call with `project=` creates that project when it does not exist. Use the `floatee` CLI, or add `create=0` to the query.'

	// G3: the rendering of `get` saved back as a body.
	const writes = calls.filter(c => ['edit', 'update', 'add'].includes(c.cmd))
	if (writes.length) {
		const piped = calls.some(c => c.cmd === 'get' && !/--raw\b/.test(c.args))
		if (piped || RENDERING_RE.test(`${command}\n${ctx.bodyFile}`))
			return 'This saves the rendering of `floatee get` (heading, status, comments) as the body, which corrupts the ticket. Start from `floatee get <id> --raw` (the body alone), or use `floatee edit <id> --append -m "…"` to add to it.'
	}

	// G5: one ticket at a time.
	const mine = ctx.active
	if (mine !== null) {
		const other = calls.find(c => c.cmd === 'claim' || c.cmd === 'start' && c.id !== mine)
		if (other) return `#${mine} is still in progress in this session: one ticket at a time. Close it (\`floatee done\`, \`block\` or \`wontfix\`) first; if the user wants to switch, release it with \`floatee pending ${mine}\`.`
	}

	// G4: verified, or the user spoke, before closing.
	const closing = calls.find(c => c.cmd === 'done' && c.id !== null && c.id === mine)
	if (closing && !ctx.verified && !ctx.heard)
		return `Nothing verified #${mine} yet: run the repo's checks (tests, lint, typecheck or build) and make sure they pass, or ask the user to check it and wait for their answer, then close. A repo with its own check command can list it in \`.floatee\` as \`verify=<command>\`.`
	return null
}

// The ticket this session works on after a call that ran: started (`start N`,
// or `claim`'s output heading), released (done / wontfix / block / pending),
// or unchanged.
export function nextActive(command: string, output: string, mine: number | null): number | null {
	let now = mine
	for (const c of cliCalls(command)) {
		if (c.cmd === 'start' && c.id !== null) now = c.id
		if (c.cmd === 'claim') { const m = output.match(/^#\s*\[#(\d+)\]/m); if (m && m[1]) now = Number(m[1]) }
		if (['done', 'wontfix', 'block', 'pending', 'reopen'].includes(c.cmd) && c.id !== null && c.id === now) now = null
	}
	return now
}
