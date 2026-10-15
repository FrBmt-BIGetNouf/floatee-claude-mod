// Icons: ⨳ Floatee; states ⊙ pending, ⊛ in progress, ⊝ blocked; actions
// ▶ run, ▷ guided run, ◉ watch, ■ stop, ⟳ refresh, + - fold, ↑ ↓ reorder.
//
// Floatee mod, step 1: the project's open todos in one band above the prompt —
// each row with its state and actions (↑ ↓ reorder, ▶ Run = `/todo #N`, ▷ Guided = `/todo-guided #N`), plus
// "Run next" (`/todo`) and "Stop" (ends the running turn); `/todo-auto` is
// for setups without the mod, ◉ Watch (F9) is its band counterpart. It folds to its header line ([+]/[-]), folded at first; the engine's own
// [-] hides it whole and cannot be removed. Toasts announce what changed between
// two refreshes (claimed, blocked, closed, back in the queue, new). The UI is in
// English, like Floatee's.
//
// Step 2, the guards (G1–G5, decided in guards.ts, hooked here since a plugin
// has one hooks module and `$` never crosses an import): `.floatee` never read
// by the agent, tokens masked in outputs, no project created by accident, no
// `get` rendering saved as a body, one ticket per session, no `done` unverified.
//
// Then: the session's ticket in the system prompt (F8, context.ts), and in the
// band its checklist, each box pressable, and the time since the claim (F3,
// checklist.ts); a reply on a blocked todo toasted, with ↻ Resume (F10,
// replies.ts). ◉ Watch runs todos as they arrive, one autonomous run
// each while Claude is idle, within limits (F9, watch.ts).
//
// Reads the repo's `.floatee` (walking up from the session's directory, like the
// CLI). The token stays in this module: never in $.state, a log, a toast or a
// prompt. Every request carries `create=0` — the mod never creates a project.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, RenderNode } from 'claude-code'

import type { Box, Entry, Item } from '../types'
import { firstLine, reasonOf, replyOf } from './replies'
import { afterRun, WATCH_ARGS, WATCH_OFF } from './watch'
import { dropTag, namesType, parseTicket } from './newticket'
import { blocks } from './markdown'
import { wakeAt, wakeLabel } from './snooze'
import type { Block, Span } from './markdown'
import { boxes, claimedAt, elapsed, toggle, visible } from './checklist'
import { parseConfig } from './config'
import { ticketContext } from './context'
import type { ApiItem } from './context'
import type { Config } from './config'
import { cliCalls, isVerification, mask, nextActive, redirectedFile, refusal, TOKEN_RE } from './guards'

const items = atom({ plugin: 'floatee', key: 'items' } as const, [])
const error = atom({ plugin: 'floatee', key: 'error' } as const, null)
const isBusy = atom({ plugin: 'floatee', key: 'isBusy' } as const, false)
const launched = atom({ plugin: 'floatee', key: 'launched' } as const, null)
const project = atom({ plugin: 'floatee', key: 'project' } as const, null)
const order = atom({ plugin: 'floatee', key: 'order' } as const, [])
const isCollapsed = atom({ plugin: 'floatee', key: 'isCollapsed' } as const, true)
const turnId = atom({ plugin: 'floatee', key: 'turnId' } as const, null)
// Guards (guards.ts): the ticket this session works on and G4's flags.
const active = atom({ plugin: 'floatee', key: 'active' } as const, null)
const verified = atom({ plugin: 'floatee', key: 'verified' } as const, false)
const heard = atom({ plugin: 'floatee', key: 'heard' } as const, false)
const ticket = atom({ plugin: 'floatee', key: 'ticket' } as const, null)
// F3: its checklist under its row, and the clock the elapsed time reads.
const checklist = atom({ plugin: 'floatee', key: 'checklist' } as const, null)
const now = atom({ plugin: 'floatee', key: 'now' } as const, 0)
const isChecklistOpen = atom({ plugin: 'floatee', key: 'isChecklistOpen' } as const, false)
// F10: replies on blocked todos, and those already announced.
const blocked = atom({ plugin: 'floatee', key: 'blocked' } as const, {})
const notified = atom({ plugin: 'floatee', key: 'notified' } as const, {})
// F9: the watcher.
const watch = atom({ plugin: 'floatee', key: 'watch' } as const, WATCH_OFF)
// #680: the new-ticket field.
// #751: its type, tags and place in the list, chosen in the form.
const DRAFT_OFF = { isOpen: false, text: '', isSending: false, type: 'todo' as const, tags: [] as string[], position: 'top' as const, isTagging: false, tagText: '', assignee: null, project: null, snooze: null, picking: null, choices: null, isSnoozing: false, whenText: '' }
const draft = atom({ plugin: 'floatee', key: 'draft' } as const, DRAFT_OFF)
// #747: a ticket's sheet, open in place of the list.
// #748: the band shows a ticket's last entries of activity, a comment cut to a few lines.
const ENTRIES = 4
const COMMENT_LINES = 3
const SHEET_OFF = { id: null, step: null, text: '', isSending: false, body: null, feed: null, reply: '', isComposing: false, editing: null, deleting: null, isPosting: false, isAll: false, assignee: null, project: null, picking: null, choices: null, tagText: '', isTagging: false, isSnoozing: false, whenText: '', isDeleting: false, isEditing: false, editLine: null, lineText: '' }
const sheet = atom({ plugin: 'floatee', key: 'sheet' } as const, SHEET_OFF)
// #679: the list in the band above the prompt, or in a pane (docked beside the
// transcript on a wide fullscreen terminal). Remembered across sessions.
const layout = atom({ plugin: 'floatee', key: 'layout' } as const, 'band')
const PANE = 'floatee'
const others = atom({ plugin: 'floatee', key: 'others' } as const, [])
// #750: the open items asleep (snoozed), apart: the pane lists them, a sheet wakes them.
const sleepers = atom({ plugin: 'floatee', key: 'sleepers' } as const, [])
const folds = atom({ plugin: 'floatee', key: 'folds' } as const, {})
const detail = atom({ plugin: 'floatee', key: 'detail' } as const, null)
// #669: only the tickets assigned to me (this token or its owner), remembered;
// and the end of a rate-limit pause (429), 0 when none.
const isMine = atom({ plugin: 'floatee', key: 'isMine' } as const, false)
const pausedUntil = atom({ plugin: 'floatee', key: 'pausedUntil' } as const, 0)
// #751: a dialog of the engine's is up (AskUserQuestion, a plan to approve): it holds
// the keys, so a field of ours would take no click and no typing meanwhile.
const asked = atom({ plugin: 'floatee', key: 'asked' } as const, 0)
const DIALOG_TOOLS = ['AskUserQuestion', 'ExitPlanMode']

// Inert launchers. The theme's `inactive` draws close to plain text on some
// terminals; a fixed mid grey reads as disabled on dark and light alike.
const GREY = '#6c6c6c'
// #692: Floatee's yellow, not the theme's `warning` (orange): the app's dark
// primary (duck, #FCE588) on a dark background; on a light one it washes out,
// a deeper gold stands in. Spelled rgb(), as a theme spells its colors: a hex
// came out as a duller yellow in some terminals.
const HONEY = 'rgb(252,229,136)'
const GOLD = 'rgb(154,114,0)'
let brand = HONEY
async function readBrand($: EngineInterface) {
	const rows = await $.config.list().catch(() => [])
	const theme = rows.find(row => row.key === 'theme')?.value
	brand = typeof theme === 'string' && theme.startsWith('light') ? GOLD : HONEY
}
const SHOWN = 6            // rows drawn before "+N more"
const BOXES = 5            // checklist lines drawn before "+N more"
const NARROW = 100         // band columns below which labels shrink to glyphs (#669)
const NARROW_PANE = 60     // the same in the pane
const FOLDED_EXTRA = 20    // folded, the columns the ticket in progress needs on top
const REFRESH_MS = 60_000  // background refresh while the session is open
// Faster while our ticket is open or the watcher on, Claude idle: boxes ticked
// in Floatee and new todos show up soon. Every request counts against the
// token's per-minute cap (8 on Free, shared with the agent's CLI calls): one
// list read per beat, two a minute, the boxes come with it.
const WATCH_MS = 30_000

// Titles are raw markdown (the body's first line): drop the emphasis markers and
// TipTap's backslash escapes so the band reads as text.
function plainTitle(md: string): string {
	return md
		.replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, '$1')
		.replace(/\*\*|__|~~|`/g, '')
		.replace(/^\s*[#>]+\s*/, '')
		.trim()
}

// The repo's config, read at session.start; module-local, never in $.state.
let config: Config | null = null
// When the list was last read, and until when the API asked us to wait (429).
let lastRefresh = 0
let quietUntil = 0
// Set when the filter changes: the next list is a new baseline, not news.
let rebase = false

// Where the .floatee was found: the repo the kit lives in.
let repoRoot: { dir: string; sep: string } | null = null

// #670: the band's buttons run the kit's /todo commands. Missing in this
// repo, say once how to get them rather than fail on the first press.
async function checkKit($: EngineInterface) {
	if (!repoRoot) return
	const { dir, sep } = repoRoot
	const missing: string[] = []
	for (const name of ['todo', 'todo-guided', 'todo-auto']) {
		const at = [dir, '.claude', 'commands', `${name}.md`].join(sep)
		if (!(await $.fs.exists(at).catch(() => true))) missing.push(`/${name}`)
	}
	if (missing.length) $.ui.toast(`Floatee: ${missing.join(', ')} missing in this repo: they come with the Floatee agent kit (floatee.me/settings/agent).`, TOAST)
}

// Walking up from the session's directory, like the CLI. Windows paths too
// (Claude Desktop): `C:\Workspace\repo`, its own separator kept.
async function findConfig($: EngineInterface): Promise<Config | null> {
	let dir = await $.session.cwd()
	const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
	for (let i = 0; i < 30; i++) {
		const path = `${dir}${sep}.floatee`
		if (await $.fs.exists(path)) { repoRoot = { dir, sep }; return parseConfig(await $.fs.read(path)) }
		const up = dir.replace(/[\\/][^\\/]+$/, '')
		if (!up || up === dir) return null
		dir = up
	}
	return null
}

async function fail($: EngineInterface, problem: string) {
	await update($, error, () => problem)
}

// What changed since the last fetch, as toasts: claimed, blocked, closed, new.
// `before` is the list kept in $.state, which outlives a reload of this module:
// empty only at the session's first fetch, when announcing would list the
// whole backlog.
const TOAST = { timeoutMs: 8000 }
function announce($: EngineInterface, before: Item[], after: Item[]) {
	if (before.length === 0) return
	const was = new Map(before.map(i => [i.id, i]))
	const now = new Map(after.map(i => [i.id, i]))
	const fresh = after.filter(i => !was.has(i.id) && i.status === 'pending')
	for (const item of after) {
		const old = was.get(item.id)
		if (!old || old.status === item.status) continue
		if (item.status === 'in_progress') $.ui.toast(`#${item.id} claimed: ${item.title}`, TOAST)
		else if (item.status === 'blocked') $.ui.toast(`#${item.id} blocked: ${item.title}`, TOAST)
		else if (item.status === 'pending' && old.status !== 'pending') $.ui.toast(`#${item.id} is back in the queue`, TOAST)
	}
	for (const old of before) {
		if (!now.has(old.id) && old.status === 'in_progress') $.ui.toast(`#${old.id} closed: ${old.title}`, TOAST)
	}
	if (fresh.length === 1 && fresh[0]) $.ui.toast(`New todo #${fresh[0].id}: ${fresh[0].title}`, TOAST)
	else if (fresh.length > 1) $.ui.toast(`${fresh.length} new todos in the backlog`, TOAST)
}

async function refresh($: EngineInterface) {
	if (!config) return
	// The elapsed time (F3) moves on with each refresh, offline included.
	const at = await $.clock.now().catch(() => null)
	if (at !== null) {
		await update($, now, () => at)
		lastRefresh = at
		if (at < quietUntil) return
	}
	// Every open item (all types), so a reorder can send the project's whole order.
	const mineOnly = await read($, isMine)
	const url = `${config.api}/items?project=${encodeURIComponent(config.project)}&format=json&limit=200&sleeping=include&create=0${mineOnly ? '&assignee=me' : ''}`
	let res
	try {
		res = await $.http.fetch(url, { headers: { Authorization: `Bearer ${config.token}` } })
	} catch {
		await fail($, 'offline, retrying each minute')
		return
	}
	if (res.status === 401) { await fail($, 'invalid token: check token= in .floatee'); return }
	// Over the per-minute cap: wait as told, the band keeps what it shows.
	if (res.status === 429) {
		const wait = Number(res.headers['retry-after'] ?? 60)
		if (at !== null) quietUntil = at + (Number.isFinite(wait) ? wait : 60) * 1000
		await update($, pausedUntil, () => quietUntil)
		return
	}
	await update($, pausedUntil, () => 0)
	if (res.status === 404) { await fail($, 'unknown project: check project= in .floatee'); return }
	if (!res.ok) { await fail($, `error ${res.status}`); return }
	let all: Array<{ id: number; title: string; status: string; type: string; sortOrder: number; bodyMd?: string; commentCount?: number; workspaceSlug?: string; tags?: string[]; checklist?: { done: number; total: number }; updatedAt?: number; snoozeUntil?: number | null }>
	try { all = JSON.parse(res.text) } catch { await fail($, 'unreadable response'); return }
	all.sort((a, b) => a.sortOrder - b.sortOrder)
	// #750: the sleeping ones come along, kept apart (the list is the awake).
	const rows = all.filter(r => !r.snoozeUntil)
	const toItem = (r: typeof rows[number]): Item => ({
		id: r.id, title: plainTitle(r.title), status: r.status as Item['status'], ws: r.workspaceSlug ?? null,
		type: r.type as Item['type'], tags: r.tags ?? [], boxes: r.checklist?.total ? r.checklist : null,
		updatedAt: r.updatedAt ? r.updatedAt * 1000 : null, comments: r.commentCount ?? 0,
		...(r.snoozeUntil ? { until: r.snoozeUntil } : {}),
	})
	const isOpen = (r: typeof rows[number]) => ['pending', 'in_progress', 'blocked'].includes(r.status)
	const open: Item[] = rows.filter(r => r.type === 'todo' && isOpen(r)).map(toItem)
	if (!rebase) announce($, await read($, items), open)
	rebase = false
	await update($, items, () => open)
	await update($, others, () => rows.filter(r => (r.type === 'idea' || r.type === 'note') && isOpen(r)).map(toItem))
	await update($, sleepers, () => all.filter(r => r.snoozeUntil && isOpen(r)).map(toItem))
	// A reorder sends the project's whole order: only a full list holds it.
	if (!mineOnly) await update($, order, () => rows.map(r => r.id))
	await update($, error, () => null)
	// #743: our ticket closed or released elsewhere (the web, another
	// terminal): the session lets it go, or the buttons stay off.
	if (await released($, all)) {
		await update($, active, () => null)
		await update($, verified, () => false)
		await update($, heard, () => false)
		await loadTicket($)
	}
	// F3: our ticket's boxes ride in the list (its body); a full read only when
	// the claim time is still missing.
	const mine = await read($, active)
	const row = rows.find(r => r.id === mine)
	const held = await read($, checklist)
	if (mine !== null && held?.id === mine && typeof row?.bodyMd === 'string') {
		const body = row.bodyMd
		await update($, checklist, c => (c && c.id === mine ? { ...c, boxes: boxes(body) } : c))
	} else if (mine !== null) {
		await loadChecklist($)
	}
	await watchReplies($, rows.filter(r => r.type === 'todo' && r.status === 'blocked'))
	await maybeWatch($)
}

// Whether the session's ticket is no longer in progress: its row says so, or,
// out of the list (closed, deleted, or not mine in the "mine" list), one read
// tells. A failed read keeps it, unless the ticket is gone.
async function released($: EngineInterface, rows: Array<{ id: number; status: string }>): Promise<boolean> {
	const mine = await read($, active)
	if (mine === null) return false
	const row = rows.find(r => r.id === mine)
	if (row) return row.status !== 'in_progress'
	try { return (await fetchItem($, mine)).status !== 'in_progress' } catch (err) { return (err as Error).message === '404' }
}

// F9: the watcher starts a run when it is on, Claude idle, nothing queued, no
// ticket of ours open and a todo waiting.
async function maybeWatch($: EngineInterface) {
	const w = await read($, watch)
	if (!w.isOn || w.inTurn !== null) return
	if (await read($, isBusy) || await read($, launched) !== null || await read($, active) !== null || await read($, error) !== null) return
	if (!(await read($, items)).some(i => i.status === 'pending')) return
	await update($, watch, v => ({ ...v, inTurn: 0 }))
	$.ui.toast('Watch: running the next todo', TOAST)
	await launch($, null, 'todo-auto', WATCH_ARGS)
}

async function toggleWatch($: EngineInterface) {
	const w = await read($, watch)
	await update($, watch, () => (w.isOn ? WATCH_OFF : { ...WATCH_OFF, isOn: true }))
	const cap = config?.watchMax ?? null
	$.ui.toast(w.isOn ? 'Watch off' : `Watch on: todos run as they arrive${cap ? ` (up to ${cap})` : ''}`, TOAST)
	if (!w.isOn) await refresh($)
}

// F10: a blocked todo whose comment count moved is read whole, to see who
// spoke since the block (READS_PER_REFRESH at most, the rest at the next
// refresh: every read counts against the per-minute cap). A new reply is
// toasted once, its time kept in $.state so a reload doesn't toast it again.
const READS_PER_REFRESH = 2
async function watchReplies($: EngineInterface, rows: Array<{ id: number; title: string; commentCount?: number }>) {
	const was = await read($, blocked)
	const next: typeof was = {}
	let reads = 0
	for (const row of rows) {
		const count = row.commentCount ?? 0
		const seen = was[row.id]
		// (A record from before #679 has no `why`: read once more.)
		if (seen && seen.comments === count && seen.why !== undefined) { next[row.id] = seen; continue }
		if (count === 0) { next[row.id] = { comments: 0, reply: null, why: null }; continue }
		if (reads >= READS_PER_REFRESH) { if (seen) next[row.id] = seen; continue }
		reads++
		try {
			const item = await fetchItem($, row.id)
			next[row.id] = { comments: count, reply: replyOf(item.activity as never), why: reasonOf(item.activity as never) }
		} catch {
			if (seen) next[row.id] = seen
		}
	}
	await update($, blocked, () => next)
	const told = await read($, notified)
	for (const row of rows) {
		const reply = next[row.id]?.reply
		if (!reply || told[row.id] === reply.at) continue
		$.ui.toast(`Reply on #${row.id} from ${reply.by}: ${plainTitle(row.title)}`, TOAST)
		await update($, notified, n => ({ ...n, [row.id]: reply.at }))
	}
}

// Queue `/todo [#N]` — run by the engine once the session is idle. One launch
// at a time: the band shows it as such until the turn it started completes.
async function launch($: EngineInterface, id: number | null, command: 'todo' | 'todo-guided' | 'todo-auto' = 'todo', note = '') {
	const pending = await read($, launched)
	if (pending !== null) { $.ui.toast(pending ? `#${pending} is already queued` : 'A todo is already queued'); return }
	if (await read($, isBusy)) { $.ui.toast('Claude is busy: try again when the turn ends'); return }
	await update($, launched, () => id ?? 0)
	const args = id === null ? note : `#${id}`
	try {
		await $.command.run({ command, args })
	} catch {
		// Not runnable as a command here: hand it over as a typed prompt.
		await $.prompt.submit({ text: `/${command}${args ? ` ${args}` : ''}`, asUser: true })
	}
}

// End the running turn (a watcher's run included), its tools stopped.
async function stop($: EngineInterface) {
	// Stop means stop: the watcher too.
	if ((await read($, watch)).isOn) { await update($, watch, () => WATCH_OFF); $.ui.toast('Watch off', TOAST) }
	const id = await read($, turnId)
	if (!id) return
	await $.turn.abort({ turnId: id }).catch(() => $.ui.toast('Nothing to stop'))
}

// The person checked the ticket this session works on: their press is G4's
// "the user spoke", then the agent is asked to close it (resolution note and
// tags are its to write, as /todo's step 5).
async function close($: EngineInterface, id: number) {
	if (await read($, isBusy)) { $.ui.toast('Claude is busy: try again when the turn ends'); return }
	await update($, heard, () => true)
	await $.prompt.submit({ text: `#${id} is checked: close it.`, asUser: true })
}

// Put the session's ticket back in the queue (F11): pending again, with a
// comment saying why. Only the ticket this session started (`active`), and only
// while the band still sees it in progress, so a ticket closed or reopened
// elsewhere meanwhile is left alone. `fresh` re-reads the backlog first (not
// at session end, whose budget is 1.5 s: the two writes go out together).
const RELEASED = {
	end: 'Released by the floatee mod: the Claude Code session ended before this ticket was closed. It is back in the queue.',
	band: 'Released from the Claude Code band: back in the queue.',
}
async function release($: EngineInterface, why: keyof typeof RELEASED, fresh: boolean) {
	const id = await read($, active)
	if (id === null || !config) return
	if (fresh) await refresh($)
	await update($, active, () => null)
	await update($, ticket, () => null)
	await update($, checklist, () => null)
	const item = (await read($, items)).find(i => i.id === id)
	if (item?.status !== 'in_progress') return
	const base = `${config.api}/items/${id}`
	const query = `?project=${encodeURIComponent(config.project)}&create=0`
	const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }
	const [status] = await Promise.all([
		$.http.fetch(base + query, { method: 'PATCH', headers, body: JSON.stringify({ status: 'pending' }) }),
		$.http.fetch(`${base}/comments${query}`, { method: 'POST', headers, body: JSON.stringify({ body_md: RELEASED[why] }) }),
	])
	if (!status.ok) { $.ui.toast(`Could not release #${id} (${status.status})`); return }
	// Said here; the next refresh must not say it again.
	await update($, items, l => l.map(i => (i.id === id ? { ...i, status: 'pending' as const } : i)))
	$.ui.toast(`#${id} is back in the queue`, TOAST)
}

// A ticket's page in the web app; null when its workspace is unknown.
function pageOf(item: Item): string | null {
	return config && item.ws ? `${config.web}/i/${encodeURIComponent(item.ws)}/${item.id}` : null
}

// Open a URL in the person's browser, with the host's own opener: no shell, the
// URL one argument. WSL hands it to Windows (explorer.exe exits 1 even when it
// opened it); Windows, macOS and Linux their usual one.
async function openPage($: EngineInterface, url: string) {
	const openers: string[][] = []
	if (await $.env.get('WSL_DISTRO_NAME')) openers.push(['explorer.exe', url], ['wslview', url])
	else if (await $.env.get('OS') === 'Windows_NT') openers.push(['rundll32', 'url.dll,FileProtocolHandler', url])
	else {
		const os = await $.process.run(['uname', '-s']).then(r => r.stdout.trim(), () => '')
		openers.push(os === 'Darwin' ? ['open', url] : ['xdg-open', url])
	}
	for (const argv of openers) {
		try {
			const { exitCode } = await $.process.run(argv, { timeoutMs: 10_000 })
			if (exitCode === 0 || argv[0] === 'explorer.exe') return
		} catch { /* not there: the next one */ }
	}
	$.ui.toast(`Could not open a browser: ${url}`)
}

// #680: create the ticket typed in the band's field, at the top of the
// queue, where it is seen first. The field stays open with its text on a failure.
async function createTicket($: EngineInterface, text: string) {
	if (!config || (await read($, draft)).isSending) return
	const t = parseTicket(text)
	if (!t) { $.ui.toast('Nothing to create: type a title first'); return }
	// #751: the form's type unless the text names one; its tags and the text's.
	const form = await read($, draft)
	const type = namesType(text) ? t.type : form.type
	const tags = [...new Set([...(form.tags ?? []), ...t.tags])]
	// #751: its project (this one unless chosen), assignee and wake-up.
	const where = form.project?.value ?? config.project
	await update($, draft, d => ({ ...d, text, isSending: true }))
	try {
		const res = await $.http.fetch(`${config.api}/items?project=${encodeURIComponent(where)}&format=json&create=0`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				body_md: t.body, type, tags, position: form.position ?? 'top',
				...(form.assignee ? { assignee_handle: form.assignee.value } : {}),
				...(form.snooze ? { snooze_until: form.snooze } : {}),
			}),
		})
		if (!res.ok) {
			// The API's own words when it gives some (snooze is Pro).
			let said = ''
			try { const err = JSON.parse(res.text) as { detail?: string }; said = err.detail ?? '' } catch { /* no body */ }
			$.ui.toast(said ? `Could not create the ticket: ${said}` : `Could not create the ticket (${res.status})`)
			await update($, draft, d => ({ ...d, isSending: false }))
			return
		}
		const made = JSON.parse(res.text) as { id?: number }
		await update($, draft, () => DRAFT_OFF)
		$.ui.toast(`Created #${made.id ?? '?'}${where === config.project ? '' : ` in ${form.project?.label ?? where}`}: ${plainTitle(t.body.split('\n')[0] ?? '')}`, TOAST)
		await refresh($)
	} catch {
		$.ui.toast('Could not create the ticket: offline')
		await update($, draft, d => ({ ...d, isSending: false }))
	}
}

// #747: a ticket's sheet — its type and status changed from the band or the pane.
type Status = Item['status'] | 'done' | 'wontfix'
const STATUS_LABELS: Record<Status, string> = { pending: 'pending', in_progress: 'in progress', blocked: 'blocked', done: 'done', wontfix: "won't fix" }
// A todo goes through every state; an idea or a note is open or closed.
const statusesOf = (item: Item): Status[] => item.type === 'todo' ? ['pending', 'in_progress', 'blocked', 'done', 'wontfix'] : ['pending', 'done', 'wontfix']

async function openSheet($: EngineInterface, id: number) {
	await update($, draft, () => DRAFT_OFF)
	await update($, sheet, () => ({ ...SHEET_OFF, id }))
	await loadSheet($, id)
}

// Its body, read whole (the box lines count from its top), and #748 its
// activity, as the site's feed draws it.
async function loadSheet($: EngineInterface, id: number) {
	try {
		const item = await fetchItem($, id)
		await update($, sheet, s => (s.id === id ? { ...s, body: item.bodyMd, feed: feedOf(item), assignee: item.assigneeName ?? null, project: item.projectName ?? null } : s))
	} catch { /* the sheet goes without it */ }
}

// #749: a ticket's tags, assignee and project, changed from its sheet.
async function setTags($: EngineInterface, item: Item, tags: string[]) {
	if (!await patchItem($, item.id, { tags })) return
	await refresh($)
	await loadSheet($, item.id)
}

// The tags typed in the field (commas or spaces between them, a leading +
// dropped), added to the ticket's.
async function addTags($: EngineInterface, item: Item, text: string) {
	const typed = text.split(/[\s,]+/).map(t => t.replace(/^\+/, '').trim()).filter(Boolean)
	await update($, sheet, s => ({ ...s, tagText: '', isTagging: false }))
	if (!typed.length) return
	await setTags($, item, [...new Set([...(item.tags ?? []), ...typed])])
}

// Assign or move: the choices read when asked (the project's assignees, the
// workspace's other projects), as a row of buttons.
async function pickMeta($: EngineInterface, item: Item, what: 'assignee' | 'project') {
	if (!config) return
	await update($, sheet, s => ({ ...s, picking: what, choices: null, isTagging: false }))
	try {
		const choices = await choicesOf($, what, config.project, p => p.slug !== config!.project && (!item.ws || p.workspace?.slug === item.ws))
		await update($, sheet, s => (s.id === item.id && s.picking === what ? { ...s, choices } : s))
	} catch {
		$.ui.toast(`Could not read the ${what === 'assignee' ? 'assignees' : 'projects'}`)
		await update($, sheet, s => ({ ...s, picking: null }))
	}
}

// Who can be assigned in `project` (me, its members and agents, nobody), or
// the live projects `keep` keeps. Throws when the API says no.
type Project = { slug: string; name: string; archived?: boolean; workspace?: { slug?: string } }
async function choicesOf($: EngineInterface, what: 'assignee' | 'project', project: string, keep: (p: Project) => boolean = () => true): Promise<Array<{ value: string; label: string }>> {
	if (!config) return []
	const get = async (path: string) => {
		const res = await $.http.fetch(`${config!.api}/${path}${path.includes('?') ? '&' : '?'}format=json&create=0`, { headers: { Authorization: `Bearer ${config!.token}` } })
		if (!res.ok) throw new Error(String(res.status))
		return JSON.parse(res.text) as unknown
	}
	if (what === 'assignee') {
		const got = (await get(`project?project=${encodeURIComponent(project)}`)) as { assignees?: Array<{ handle: string; name: string; type: string }> }
		return [{ value: 'me', label: 'me' }, ...(got.assignees ?? []).map(a => ({ value: a.handle, label: a.type === 'token' ? `${a.name} (agent)` : a.name })), { value: '', label: 'nobody' }]
	}
	return ((await get('projects')) as Project[]).filter(p => !p.archived && keep(p)).map(p => ({ value: p.slug, label: p.name }))
}

// #751: the New form's assign / move choices.
async function pickNew($: EngineInterface, what: 'assignee' | 'project') {
	if (!config) return
	const d0 = await read($, draft)
	await update($, draft, d => ({ ...d, picking: what, choices: null, isTagging: false, isSnoozing: false }))
	try {
		const choices = await choicesOf($, what, d0.project?.value ?? config.project)
		await update($, draft, d => (d.picking === what ? { ...d, choices } : d))
	} catch {
		$.ui.toast(`Could not read the ${what === 'assignee' ? 'assignees' : 'projects'}`)
		await update($, draft, d => ({ ...d, picking: null }))
	}
}

async function assign($: EngineInterface, item: Item, handle: string) {
	await update($, sheet, s => ({ ...s, picking: null, choices: null }))
	if (!await patchItem($, item.id, { assignee_handle: handle })) return
	$.ui.toast(handle ? `#${item.id} is assigned` : `#${item.id} is unassigned`, TOAST)
	await loadSheet($, item.id)
}

// A move takes the ticket out of this project's list: the sheet closes.
async function moveTo($: EngineInterface, item: Item, slug: string, name: string) {
	if (!config) return
	await update($, sheet, s => ({ ...s, picking: null, choices: null }))
	try {
		const res = await $.http.fetch(`${config.api}/project?project=${encodeURIComponent(slug)}&format=json&create=0`, { headers: { Authorization: `Bearer ${config.token}` } })
		if (!res.ok) throw new Error(String(res.status))
		const target = JSON.parse(res.text) as { id?: string }
		if (!target.id) throw new Error('no id')
		if (!await patchItem($, item.id, { project_id: target.id })) return
	} catch {
		$.ui.toast(`Could not move #${item.id}`)
		return
	}
	$.ui.toast(`#${item.id} moved to ${name}`, TOAST)
	await update($, sheet, () => SHEET_OFF)
	await refresh($)
}

// #750: put a ticket to sleep until `epoch` (s), or wake it (null). The
// API's refusal (snooze is Pro) is shown as it words it.
async function snooze($: EngineInterface, item: Item, epoch: number | null) {
	if (!config) return
	try {
		const res = await $.http.fetch(`${config.api}/items/${item.id}?project=${encodeURIComponent(config.project)}&format=json&create=0`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ snooze_until: epoch }),
		})
		if (!res.ok) {
			let said = ''
			try { const err = JSON.parse(res.text) as { detail?: string; error?: string }; said = err.detail ?? err.error ?? '' } catch { /* no body */ }
			$.ui.toast(said ? `#${item.id}: ${said}` : `Could not ${epoch === null ? 'wake' : 'snooze'} #${item.id} (${res.status})`)
			return
		}
	} catch {
		$.ui.toast(`Could not ${epoch === null ? 'wake' : 'snooze'} #${item.id}: offline`)
		return
	}
	const at = await $.clock.now().catch(() => Date.now())
	$.ui.toast(epoch === null ? `#${item.id} is awake` : `#${item.id} sleeps until ${wakeLabel(epoch, at)}`, TOAST)
	await update($, sheet, s => ({ ...s, isSnoozing: false, whenText: '' }))
	await refresh($)
	await loadSheet($, item.id)
}

// The field's text read as a delay or a date; a toast when it doesn't.
async function snoozeTyped($: EngineInterface, item: Item, text: string) {
	const at = await $.clock.now().catch(() => Date.now())
	const epoch = wakeAt(text, at)
	if (typeof epoch !== 'number') { $.ui.toast(epoch.error); return }
	await snooze($, item, epoch)
}

// Delete, once asked (`isDeleting`): the ticket goes to the site's trash.
async function deleteItem($: EngineInterface, item: Item) {
	if (!config) return
	try {
		const res = await $.http.fetch(`${config.api}/items/${item.id}?project=${encodeURIComponent(config.project)}&create=0`, {
			method: 'DELETE', headers: { Authorization: `Bearer ${config.token}` },
		})
		if (!res.ok) { $.ui.toast(`Could not delete #${item.id} (${res.status})`); return }
	} catch {
		$.ui.toast(`Could not delete #${item.id}: offline`)
		return
	}
	$.ui.toast(`#${item.id} is deleted`, TOAST)
	await update($, sheet, () => SHEET_OFF)
	await refresh($)
}

// #752: one line of the body written (`text` at line `at`; `null` deletes
// it; `insert` adds it after), on a fresh read: a body changed meanwhile is
// not overwritten, the sheet reloads it instead. The first line is the title.
async function writeLine($: EngineInterface, id: number, at: number, text: string | null, insert = false) {
	const s0 = await read($, sheet)
	if (s0.body === null || s0.isSending) return
	await update($, sheet, s => ({ ...s, isSending: true }))
	const done = (patch: Partial<typeof s0>) => update($, sheet, s => (s.id === id ? { ...s, isSending: false, ...patch } : s))
	let fresh: FullItem
	try { fresh = await fetchItem($, id) } catch { $.ui.toast(`Could not read #${id}`); await done({}); return }
	if (fresh.bodyMd !== s0.body) {
		$.ui.toast(`#${id} changed meanwhile: reloaded, nothing overwritten`)
		await done({ body: fresh.bodyMd, feed: feedOf(fresh), editLine: null, lineText: '' })
		return
	}
	const lines = fresh.bodyMd.split('\n')
	if (insert) lines.splice(at + 1, 0, text ?? '')
	else if (text === null) lines.splice(at, 1)
	else lines[at] = text
	const body = lines.join('\n')
	if (!body.split('\n')[0]!.trim()) { $.ui.toast('The first line is the title: it cannot be empty'); await done({}); return }
	if (!await patchItem($, id, { body_md: body })) { await done({}); return }
	// An inserted line opens for typing; otherwise the line closes.
	await done({ body, ...(insert ? { editLine: at + 1, lineText: '' } : { editLine: null, lineText: '' }) })
	await refresh($)
}

// #748: the site's labels, for the feed's events.
const STATUS_NAMES: Record<string, string> = { pending: 'Pending', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', wontfix: "Won't fix" }
const TYPE_NAMES: Record<string, string> = { todo: 'Todo', idea: 'Idea', note: 'Note' }

// A ticket's activity, newest first, its opening last (as on the site): a
// comment with its markdown, an event in a line, a resolution with its note
// (the one in the event, else the ticket's on its latest resolution).
function feedOf(item: FullItem): Entry[] {
	const all = item.activity ?? []
	const isResolution = (a: (typeof all)[number]) => a.kind === 'status_change' && (a.meta?.to === 'done' || a.meta?.to === 'wontfix')
	const latest = all.filter(isResolution).at(-1)
	const entries = all.map((a, n): Entry => {
		const m = a.meta ?? {}
		const event = a.kind === 'comment' ? ''
			: a.kind === 'status_change' ? `${STATUS_NAMES[m.from ?? ''] ?? m.from} → ${STATUS_NAMES[m.to ?? ''] ?? m.to}`
			: a.kind === 'promoted' ? `promoted ${TYPE_NAMES[m.from ?? ''] ?? m.from} → ${TYPE_NAMES[m.to ?? ''] ?? m.to}`
			: a.kind === 'snoozed' ? 'snoozed 💤'
			: a.kind === 'woke_up' ? 'woke up'
			: a.kind === 'moved' ? 'moved project'
			: a.kind === 'assigned' ? (m.to ? `assigned to ${m.to}` : 'unassigned')
			: a.kind.replace('_', ' ')
		const note = isResolution(a) ? (m.note?.trim() ? m.note : a === latest ? item.resolutionNote || null : null) : null
		return {
			key: a.id ?? n, kind: a.kind, seq: a.kind === 'comment' ? a.seq ?? null : null,
			author: a.authorName ?? (a.authorType === 'agent' ? 'Agent' : 'Member'), at: (a.createdAt ?? 0) * 1000,
			body: a.kind === 'comment' ? a.bodyMd : note, event, isEdited: Boolean(m.editedAt), canEdit: a.canEdit === true,
			isWontfix: m.to === 'wontfix',
		}
	}).filter(e => e.kind !== 'comment' || (e.body && e.seq))
	const opening: Entry = { key: -1, kind: 'opened', seq: null, author: item.createdByName ?? 'Unknown', at: (item.createdAt ?? 0) * 1000, body: null, event: 'opened', isEdited: false, canEdit: false, isWontfix: false }
	return [...entries.reverse(), opening]
}

// One PATCH on a ticket; a toast says what failed. True when it went through.
async function patchItem($: EngineInterface, id: number, body: Record<string, unknown>): Promise<boolean> {
	if (!config) return false
	try {
		const res = await $.http.fetch(`${config.api}/items/${id}?project=${encodeURIComponent(config.project)}&format=json&create=0`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		if (!res.ok) { $.ui.toast(`Could not update #${id} (${res.status})`); return false }
		return true
	} catch {
		$.ui.toast(`Could not update #${id}: offline`)
		return false
	}
}

async function setType($: EngineInterface, item: Item, type: Item['type']) {
	if (type === item.type) return
	if (!await patchItem($, item.id, { type })) return
	$.ui.toast(`#${item.id} is now ${type === 'idea' ? 'an idea' : `a ${type}`}`, TOAST)
	await refresh($)
}

// A pick in the status list: pending and in progress act at once; blocked,
// done and won't fix ask for their text first (the sheet's next step).
async function pickStatus($: EngineInterface, item: Item, to: Status) {
	if (to === 'blocked' || to === 'done' || to === 'wontfix') {
		await update($, sheet, s => ({ ...s, step: to, text: '' }))
		return
	}
	await update($, sheet, s => ({ ...s, step: null }))
	if (to === item.status) return
	const busy = await read($, isBusy)
	if (to === 'in_progress') {
		// In progress means someone works on it: this session, as ▶ Run.
		if (busy || await read($, launched) !== null || await read($, active) !== null) {
			$.ui.toast('Claude is on another ticket: try again when it is closed')
			return
		}
		await update($, sheet, () => SHEET_OFF)
		await launch($, item.id)
		return
	}
	// Back to pending: the session's own ticket goes the ↩ Release way.
	if (item.id === await read($, active)) {
		if (busy) { $.ui.toast('Claude is busy: try again when the turn ends'); return }
		await update($, sheet, () => SHEET_OFF)
		await release($, 'band', true)
		return
	}
	if (!await patchItem($, item.id, { status: 'pending' })) return
	$.ui.toast(`#${item.id} is back in the queue`, TOAST)
	await update($, sheet, () => SHEET_OFF)
	await refresh($)
}

// The step's confirm: blocked with its why (required, a comment), done or
// won't fix with a resolution note (optional); `verify` hands the closing to
// Claude, who checks the work first.
async function confirmStatus($: EngineInterface, item: Item, how: 'blocked' | 'done' | 'wontfix' | 'verify', text: string) {
	if (!config || (await read($, sheet)).isSending) return
	const note = text.trim()
	if (how === 'blocked' && !note) { $.ui.toast('Say why it is blocked first'); return }
	if (how === 'verify') {
		if (await read($, isBusy) || await read($, launched) !== null) { $.ui.toast('Claude is busy: try again when the turn ends'); return }
		await update($, sheet, () => SHEET_OFF)
		await $.prompt.submit({
			text: `Verify #${item.id}: run the repo's checks (tests, lint, typecheck or build) and make sure the work matches the ticket. If it holds, close it as done${note ? ` with this resolution note: ${note}` : ''}. If something fails, tell me and leave it open.`,
			asUser: true,
		})
		return
	}
	await update($, sheet, s => ({ ...s, text, isSending: true }))
	if (how === 'blocked') {
		try {
			const res = await $.http.fetch(`${config.api}/items/${item.id}/comments?project=${encodeURIComponent(config.project)}&create=0`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ body_md: note }),
			})
			if (!res.ok) { $.ui.toast(`Could not comment on #${item.id} (${res.status})`); await update($, sheet, s => ({ ...s, isSending: false })); return }
		} catch {
			$.ui.toast(`Could not comment on #${item.id}: offline`)
			await update($, sheet, s => ({ ...s, isSending: false }))
			return
		}
	}
	const body = how === 'blocked' ? { status: 'blocked' } : { status: how, resolution_note: note || null }
	if (!await patchItem($, item.id, body)) { await update($, sheet, s => ({ ...s, isSending: false })); return }
	$.ui.toast(`#${item.id} is ${STATUS_LABELS[how]}`, TOAST)
	await update($, sheet, () => SHEET_OFF)
	await refresh($)
}

// #748: a comment posted, or the one being edited saved (`editing`); the
// thread read again after.
async function sendComment($: EngineInterface, id: number, text: string) {
	const s0 = await read($, sheet)
	const body = text.trim()
	if (!config || s0.isPosting || !body) return
	const at = s0.editing
	await update($, sheet, s => ({ ...s, reply: text, isPosting: true }))
	if (!await commentCall($, id, at === null ? 'POST' : 'PATCH', at, { body_md: body })) { await update($, sheet, s => ({ ...s, isPosting: false })); return }
	await update($, sheet, s => (s.id === id ? { ...s, reply: '', isComposing: false, editing: null, isPosting: false } : s))
	await loadSheet($, id)
	await refresh($)
}

// ✎: the comment back in the field, to fix and send again. The field is one
// line: a comment on several is fixed on the site.
async function editComment($: EngineInterface, item: Item, c: Entry) {
	if (!c.seq || !c.body) return
	if (c.body.includes('\n')) {
		$.ui.toast(`c${c.seq} runs on several lines: fix it on the site`)
		const url = pageOf(item)
		if (url) await openPage($, url)
		return
	}
	await update($, sheet, s => ({ ...s, reply: c.body!, isComposing: true, editing: c.seq, deleting: null }))
}

// ✕ asked first (`deleting`), then this.
async function deleteComment($: EngineInterface, id: number, seq: number) {
	if (!await commentCall($, id, 'DELETE', seq)) return
	await update($, sheet, s => (s.id === id ? { ...s, deleting: null, ...(s.editing === seq ? { editing: null, reply: '', isComposing: false } : {}) } : s))
	await loadSheet($, id)
	await refresh($)
}

// One write on a ticket's comments; a toast says what failed.
async function commentCall($: EngineInterface, id: number, method: 'POST' | 'PATCH' | 'DELETE', seq: number | null, body?: Record<string, unknown>): Promise<boolean> {
	if (!config) return false
	try {
		const res = await $.http.fetch(`${config.api}/items/${id}/comments${seq === null ? '' : `/c${seq}`}?project=${encodeURIComponent(config.project)}&create=0`, {
			method,
			headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
			...(body ? { body: JSON.stringify(body) } : {}),
		})
		if (!res.ok) { $.ui.toast(`Could not ${method === 'DELETE' ? 'delete' : 'save'} the comment on #${id} (${res.status})`); return false }
		return true
	} catch {
		$.ui.toast(`Could not ${method === 'DELETE' ? 'delete' : 'save'} the comment on #${id}: offline`)
		return false
	}
}

// Move a todo one row up (-1) or down (+1) in the band: just above / below its
// neighbour, in the project's full order (ideas and notes keep their places),
// sent whole to /items/reorder.
async function move($: EngineInterface, id: number, dir: -1 | 1) {
	if (!config) return
	const list = await read($, items)
	const at = list.findIndex(i => i.id === id)
	const neighbour = list[at + dir]
	if (at < 0 || !neighbour) return
	const ids = (await read($, order)).filter(x => x !== id)
	const n = ids.indexOf(neighbour.id)
	ids.splice(dir < 0 ? Math.max(0, n) : n + 1, 0, id)
	// Optimistic: redraw now, the refresh below brings the server's truth.
	await update($, items, l => { const c = [...l]; const [m] = c.splice(at, 1); if (m) c.splice(at + dir, 0, m); return c })
	try {
		const res = await $.http.fetch(`${config.api}/items/reorder?project=${encodeURIComponent(config.project)}&create=0`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ order: ids, position: 'top' }),
		})
		if (!res.ok) $.ui.toast(`Reorder failed (${res.status})`)
	} catch {
		$.ui.toast('Reorder failed: offline')
	}
	await refresh($)
}

// The body a Floatee write redirects from a file (`edit N -m - < body.md`),
// for G3; empty when there is none.
async function bodyFile($: EngineInterface, command: string): Promise<string> {
	if (!cliCalls(command).some(c => ['edit', 'update', 'add'].includes(c.cmd))) return ''
	const file = redirectedFile(command)
	if (!file) return ''
	const path = file.startsWith('/') ? file : `${await $.session.cwd()}/${file}`
	try { return (await $.fs.exists(path)) ? await $.fs.read(path) : '' } catch { return '' }
}

type FullItem = ApiItem & {
	resolutionNote?: string | null
	createdByName?: string | null
	assigneeName?: string | null
	projectName?: string | null
	createdAt?: number
	activity?: Array<{ kind: string; seq?: number | null; bodyMd: string | null; authorName: string | null; authorType: string; id?: number; meta?: { from?: string; to?: string; note?: string; editedAt?: number } | null; createdAt?: number; canEdit?: boolean }>
}

// One item, whole (body and activity); throws when the API says no.
async function fetchItem($: EngineInterface, id: number): Promise<FullItem> {
	if (!config) throw new Error('no config')
	const res = await $.http.fetch(`${config.api}/items/${id}?project=${encodeURIComponent(config.project)}&format=json&create=0`, { headers: { Authorization: `Bearer ${config.token}` } })
	if (!res.ok) throw new Error(String(res.status))
	const item = JSON.parse(res.text) as FullItem
	if (typeof item?.bodyMd !== 'string') throw new Error('not an item')
	return item
}

async function setChecklist($: EngineInterface, item: FullItem) { await setChecklistOf($, item) }
async function setChecklistOf($: EngineInterface, item: FullItem) {
	await update($, checklist, () => ({ id: item.id, boxes: boxes(item.bodyMd), since: claimedAt(item.activity) }))
	// #679: the pane details it too: its description's first lines (the title,
	// boxes and code left out) and its last comment.
	const lines = item.bodyMd.split('\n').slice(1)
	let inFence = false
	const intro = lines.filter(l => {
		if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; return false }
		return !inFence && l.trim() !== '' && !/^\s*[-*+]\s+\[[ xX]\]/.test(l)
	}).slice(0, 3).map(firstLine)
	const said = (item.activity ?? []).filter(a => a.kind === 'comment' && a.bodyMd?.trim()).pop()
	await update($, detail, () => ({ id: item.id, intro, last: said ? { by: said.authorName ?? 'someone', text: firstLine(said.bodyMd ?? '') } : null }))
}

// F3: the session's ticket's boxes, re-read with the band (the agent may tick
// them meanwhile). A failed fetch keeps what is drawn.
async function loadChecklist($: EngineInterface) {
	const id = await read($, active)
	if (id === null) { await update($, checklist, () => null); return }
	try { await setChecklist($, await fetchItem($, id)) } catch { /* keep the last one */ }
}

// F8: load the session's ticket for the system prompt (none when `active` is
// null), and its checklist from the same fetch. A failed fetch keeps the
// earlier text for the same ticket.
async function loadTicket($: EngineInterface) {
	const id = await read($, active)
	if (id === null || !config) {
		await update($, ticket, () => null)
		await update($, checklist, () => null)
		await update($, detail, () => null)
		return
	}
	try {
		const item = await fetchItem($, id)
		await update($, ticket, () => ({ id, text: ticketContext(item) }))
		await setChecklist($, item)
	} catch {
		await update($, ticket, t => (t?.id === id ? t : null))
	}
}

// A box pressed in the band: flip it in the ticket's body, read fresh so an
// edit made meanwhile is kept, the rest of the markdown untouched. The system
// prompt's copy (F8) stays as loaded: it says "when loaded".
async function tick($: EngineInterface, id: number, box: Box) {
	if (!config) return
	await update($, checklist, c => c && c.id === id
		? { ...c, boxes: c.boxes.map(b => (b.line === box.line ? { ...b, isDone: !b.isDone } : b)) }
		: c)
	// #747: a box pressed in a ticket's sheet; the session's checklist is its
	// own ticket's alone.
	const ours = id === await read($, active)
	const sheetBody = (body: string) => update($, sheet, s => (s.id === id ? { ...s, body } : s))
	await update($, sheet, s => (s.id === id && s.body !== null ? { ...s, body: toggle(s.body, box) ?? s.body } : s))
	const setChecklist = async (item: FullItem) => { await sheetBody(item.bodyMd); if (ours) await setChecklistOf($, item) }
	try {
		const item = await fetchItem($, id)
		const body = toggle(item.bodyMd, box)
		if (body === null) { $.ui.toast(`#${id} changed meanwhile: box not updated`); await setChecklist(item); return }
		const res = await $.http.fetch(`${config.api}/items/${id}?project=${encodeURIComponent(config.project)}&format=json&create=0`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ body_md: body }),
		})
		if (!res.ok) { $.ui.toast(`Could not update #${id} (${res.status})`); await setChecklist(item); return }
		await setChecklist({ ...item, bodyMd: body })
	} catch {
		$.ui.toast(`Could not update #${id}: offline`)
		if (ours) await loadChecklist($)
	}
}

// After a shell command ran: a passing check verifies the ticket in progress;
// start / claim / done… move the session's ticket.
async function track($: EngineInterface, command: string, output: string) {
	const mine = await read($, active)
	if (mine !== null && isVerification(command, config?.verify ?? [])) await update($, verified, () => true)
	const now = nextActive(command, output, mine)
	if (now === mine) return
	// A todo the watcher's run got done.
	if (mine !== null && now === null && cliCalls(command).some(c => c.cmd === 'done' && c.id === mine)) {
		await update($, watch, w => (w.inTurn === null ? w : { ...w, done: w.done + 1, inTurn: w.inTurn + 1 }))
	}
	await update($, active, () => now)
	await update($, verified, () => false)
	await update($, heard, () => false)
	// The band shows the claim / close now, not at the next refresh; the
	// system prompt follows the ticket.
	await refresh($).catch(() => undefined)
	await loadTicket($)
}

// #688: the band stacks with other mods'. What the hooks after ours draw
// (`next(e)`) sits above the list, so the band reads the same whichever mod
// loads first, and shares its rows. The engine's own band is an empty Box.
function isBlank(node: RenderNode): boolean {
	if (typeof node === 'string') return node.trim() === ''
	if (node.type !== 'Box' && node.type !== 'Text') return false
	return (node.children ?? []).every(isBlank)
}

// Rows a tree takes, roughly: a column adds its children up, a row takes its
// tallest, a Text its lines; borders, paddings and margins add theirs.
function rowsOf(node: RenderNode): number {
	if (typeof node === 'string') return node.split('\n').length
	const props = ('props' in node ? node.props : undefined) as Record<string, unknown> | undefined
	const children = 'children' in node && Array.isArray(node.children) ? node.children as RenderNode[] : []
	if (node.type === 'Text') return children.filter(c => typeof c === 'string').join('').split('\n').length
	if (node.type !== 'Box') return 1
	const own = children.map(rowsOf)
	const body = props?.flexDirection === 'column' ? own.reduce((a, b) => a + b, 0) : Math.max(0, ...own)
	const n = (k: string) => (typeof props?.[k] === 'number' ? props[k] as number : 0)
	const edges = (k: string) => (n(`${k}Top`) || n(`${k}Y`) || n(k)) + (n(`${k}Bottom`) || n(`${k}Y`) || n(k))
	return body + edges('padding') + edges('margin') + (props?.borderStyle ? 2 : 0)
}

type Site = { isPane: boolean; busy: boolean; maxRows: number; bodyColumns: number }

async function saveLayout($: EngineInterface, to: 'band' | 'pane') {
	await update($, layout, () => to)
	await $.store.set('layout', to).catch(() => undefined)
}

async function toggleMine($: EngineInterface) {
	const on = !await read($, isMine)
	await update($, isMine, () => on)
	await $.store.set('mine', on).catch(() => undefined)
	rebase = true
	await refresh($)
}

// The person's press: placed at any width.
async function setLayout($: EngineInterface, to: 'band' | 'pane') {
	await saveLayout($, to)
	if (to === 'pane') await $.ui.open({ id: PANE, title: 'Floatee' })
	else await $.ui.close({ id: PANE })
}

// The list, in the band or the pane (#679): header (title, count, Run next, Refresh), then one row per open
// todo in manual order — left the id and the title, right the state and the
// row's actions.
async function draw($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], site: Site) {
	const slug = await read($, project)
	if (!slug) return null

	const elements = $.ui.resolve(e)
	const { Box, Button, Text } = elements
	// No Input on the mobile app: no field there. (Its table may still name
	// it: the surface tells.)
	const hasFields = e.surface !== 'mobile'
	const Input = hasFields && 'Input' in elements ? elements.Input : null
	// #751: under a dialog, a field says why it takes nothing, instead of staying deaf.
	const isAsked = await read($, asked) > 0
	const field = (input: unknown) => (isAsked
		? <Text color="yellow" wrap="wrap">⏸ Answer Claude's question first: this field takes typing again once it's closed.</Text>
		: input)
	const typed = await read($, draft)
	// (Over SHEET_OFF: a sheet a previous version left in the state lacks the fields since.)
	const opened = { ...SHEET_OFF, ...await read($, sheet) }
	// A ticket's `#id` opens its page in the web app (#677): a bare Button,
	// not a Link, which a terminal without OSC 8 draws with the URL spelled
	// out beside it. A Button takes no color: the id draws plain. Plain text
	// when its workspace is unknown.
	const idOf = (item: Item, color: string, bold?: boolean) => {
		const url = pageOf(item)
		return url
			? <Button key={`open-${item.id}`} label={`#${item.id}`} plain onPress={() => openPage($, url)} />
			: <Text color={color} bold={bold}>{`#${item.id}`}</Text>
	}
	const list = await read($, items)
	const problem = await read($, error)
	const mineOnly = await read($, isMine)
	const paused = await read($, pausedUntil)
	// The engine's own word on whether a turn runs; our flag can lag a reload.
	const busy = site.busy
	const sent = await read($, launched)
	const folded = !site.isPane && await read($, isCollapsed)
	// The ticket this session works on: closed from the band, and while it
	// is open no other one is launched (G5). Ours first, even before a
	// refresh has seen its claim.
	const mine = await read($, active)
	const watching = await read($, watch)
	// F10: blocked todos with a reply waiting: Resume in Run's place.
	const watched = await read($, blocked)
	const replyIds = list.filter(i => i.status === 'blocked' && watched[i.id]?.reply).map(i => i.id)
	const current = list.find(i => i.id === mine) ?? list.find(i => i.status === 'in_progress')
	const waiting = list.filter(i => i.status === 'pending' && i.id !== mine).length
	// A ticket in progress (maybe another agent's) doesn't hold the queue back.
	const canLaunch = !problem && waiting > 0 && !busy && sent === null && mine === null
	// Otherwise (Claude works, a launch is queued, a ticket of ours is open)
	// the launchers stay in view, greyed and inert: a Button has no disabled
	// state, so a Text drawn like one.
	const isHeld = !problem && waiting > 0 && !canLaunch
	// Close: a whole Button, the band's main action on our ticket. The
	// terminal colors a Button in one way only, primary = the accent (blue):
	// it takes no color of ours, and drawing it bare between colored brackets
	// leaves the brackets unpressable. Folded too it keeps its chrome, to stay
	// blue (a bare Button draws plain): `[ ✓ ]` beside the compact `[▶]`.
	const closeButton = (id: number, isShort: boolean) => (
		<Button key={`close-${id}`} label={isShort ? '✓' : '✓ Close'} variant="primary" dimColor={busy} onPress={() => close($, id)} />
	)
	// #669: on a narrow terminal (or pane) the labels give way to their glyph,
	// so the titles keep some room.
	// Terminal only: Desktop draws native buttons in its own font, where a
	// glyph alone reads as nothing and the cell count says little.
	const narrow = e.surface === 'terminal' && site.bodyColumns < (site.isPane ? NARROW_PANE : NARROW)
	// Folded, the ticket in progress shares the line: a little more room
	// is asked before the labels show in full.
	const short = narrow || (folded && e.surface === 'terminal' && site.bodyColumns < NARROW + FOLDED_EXTRA)
	const label = (long: string, g: string) => (narrow ? g : long)
	// Short, buttons are drawn without chrome: we write the brackets ourselves.
	const chip = short ? true : undefined
	// #678: Claude Desktop draws every Button as a native button, plain or
	// not: brackets there would sit inside it. They are the terminal's alone,
	// on the glyphs and on the greyed stand-ins.
	const isTerminal = e.surface === 'terminal'
	const glyph = (g: string) => isTerminal ? `[${g}]` : g
	const greyed = (label: string) => isTerminal ? `[ ${label} ]` : label
	// The yellow frame, the band's look, in the pane too (inside the engine's).
	const frame = { borderStyle: 'round' as const, borderColor: brand, paddingX: 1 }
	const cap = site.isPane ? Infinity : SHOWN

	// Header. The first line: title + counts (+ the ticket in progress when
	// folded) on the left; on the right the main action (Stop while Claude
	// works, else Run next), Refresh, band/pane and the fold toggle. Unfolded,
	// a second line flush right (Watch, Mine, New), then a blank one before
	// the tickets.
	const chip2 = narrow ? true : undefined
	const header = (
		<Box flexDirection="column" marginBottom={folded ? 0 : 1}>
			<Box justifyContent="space-between" gap={1}>
				{/* Title and count never shrink (they would break mid-word); only the
				    ticket in progress gives way, truncated, down to nothing. */}
				<Box gap={1} flexShrink={1} overflow="hidden">
					<Box gap={1} flexShrink={0}>
						<Text color={brand} bold>⨳ Floatee</Text>
						{problem
							? <Text color="error">{problem}</Text>
							: <Text dimColor>{`${list.length === 0 ? 'nothing open' : `${list.length} open`}${mineOnly ? ' · mine' : ''}`}</Text>}
						{/* #669: over the per-minute cap, the list waits as the API said. */}
						{paused > 0 && <Text color="warning">{short ? '⏸' : '⏸ rate limited'}</Text>}
					</Box>
					{folded && replyIds.length > 0 && (
							<Box flexShrink={0}><Text color="warning">{`✉ ${replyIds.map(id => `#${id}`).join(' ')}`}</Text></Box>
					)}
					{folded && current && (
						<Box flexShrink={1} overflow="hidden">
							<Box gap={1} flexShrink={1} overflow="hidden">
								<Box gap={1} flexShrink={0}>
									<Text color="success">·</Text>
									{idOf(current, 'success')}
								</Box>
								<Text color="success" wrap="truncate-end">{current.title}</Text>
							</Box>
						</Box>
					)}
				</Box>
				<Box gap={short ? 0 : 1} flexShrink={0}>
					{/* Folded, the buttons shrink to a bracketed glyph, side by side
					    ([■][▶][»][⟳][+]); the fold toggle reads [+]/[-] like the engine's. */}
					{busy && <Button key="stop" label={short ? glyph('■') : '■ Stop'} plain={chip} onPress={() => stop($)} />}
					{folded && mine !== null && closeButton(mine, short)}
					{/* With Mine on, "next" is my first waiting ticket, not the project's. */}
					{canLaunch && <Button key="next" label={short ? glyph('▶') : '▶ Run next'} plain={chip} variant="primary" onPress={() => launch($, mineOnly ? list.find(i => i.status === 'pending' && i.id !== mine)?.id ?? null : null)} />}
					{isHeld && <Text color={GREY}>{short ? glyph('▶') : greyed('▶ Run next')}</Text>}
					<Button key="refresh" label={short ? glyph('⟳') : '⟳ Refresh'} plain={chip} dimColor onPress={() => refresh($)} />
					{/* #679: the list moves to a pane and back. */}
					{site.isPane
						? <Button key="layout" label="⇤ Band" dimColor onPress={() => setLayout($, 'band')} />
						: <Button key="layout" label={short ? glyph('⇥') : '⇥ Pane'} plain={chip} dimColor onPress={() => setLayout($, 'pane')} />}
					{!site.isPane && <Button key="fold" label={isTerminal ? (folded ? '[+]' : '[-]') : (folded ? '+' : '−')} plain dimColor onPress={() => update($, isCollapsed, v => !v)} />}
				</Box>
			</Box>
			{!folded && <Box justifyContent="flex-end" gap={narrow ? 0 : 1}>
				{/* F9: Watch, blue while on, with its count against the limit. */}
				{watching.isOn
					? <Button key="watch" label={narrow ? '◉' : `◉ Watching ${watching.done}${config?.watchMax ? `/${config.watchMax}` : ''}`} variant="primary" onPress={() => toggleWatch($)} />
					: <Button key="watch" label={narrow ? glyph('◉') : '◉ Watch'} plain={chip2} onPress={() => toggleWatch($)} />}
				{mineOnly
					? <Button key="mine" label={narrow ? '◐' : '◐ Mine'} variant="primary" onPress={() => toggleMine($)} />
					: <Button key="mine" label={narrow ? glyph('◐') : '◐ Mine'} plain={chip2} dimColor onPress={() => toggleMine($)} />}
				{Input && <Button key="new" label={narrow ? glyph('✎') : '✎ New'} plain={chip2} onPress={async () => { await update($, sheet, () => SHEET_OFF); await update($, draft, d => ({ ...d, isOpen: true })) }} />}
			</Box>}
		</Box>
	)
	// #680: the new-ticket mode takes the whole band, folded or not: the
	// field, what it understands, Create and Cancel.
	// A press leaves the keys in the prompt and $.ui.focus is refused ("that
	// site does not hold the keyboard"): a click on the band gives them, and
	// autoFocus lands them in the field.
	// (The engine always draws ` ⏎ <submitLabel>` after a focused field: an
	// empty label leaves the bare ⏎.)
	if (Input && typed.isOpen) {
		const nowMs = (await read($, now)) ?? 0
		const text = typed.text
		const parsed = parseTicket(text)
		const newType = namesType(text) && parsed ? parsed.type : typed.type ?? 'todo'
		const newTags = [...new Set([...(typed.tags ?? []), ...(parsed?.tags ?? [])])]
		const newLabel = (name: string) => <Box flexShrink={0}><Text dimColor>{name.padEnd(8)}</Text></Box>
		// Assignee and project as the sheet's: the choice, then its options on a press.
		const newPick = (what: 'assignee' | 'project', name: string, value: string, action: string) => (
			<Box flexDirection="column">
				<Box gap={1}>
					{newLabel(name)}
					<Text wrap="truncate-end">{value}</Text>
					{typed.picking !== what && <Button key={`new-${what}`} label={action} dimColor onPress={() => pickNew($, what)} />}
				</Box>
				{typed.picking === what && (
					<Box gap={1} flexWrap="wrap" paddingLeft={9}>
						{typed.choices === null && <Text dimColor>…</Text>}
						{typed.choices?.map(c => (
							<Button key={`new-${what}-${c.value || 'none'}`} label={c.label}
								onPress={() => update($, draft, d => ({ ...d, picking: null, choices: null, ...(what === 'assignee' ? { assignee: c } : { project: c, ...(d.project?.value !== c.value ? { assignee: null } : {}) }) }))} />
						))}
						<Button key={`new-${what}-cancel`} label="Cancel" dimColor onPress={() => update($, draft, d => ({ ...d, picking: null, choices: null }))} />
					</Box>
				)}
			</Box>
		)
		// A band too short for it all keeps the field: the blank lines go
		// first, then the settings (the text's +tag and !type still work).
		const isRoomy = site.isPane || site.maxRows >= 21
		const hasSettings = site.isPane || site.maxRows >= 16
		const newHead = (name: string) => (
			<Box key={`new-section-${name}`} flexDirection="column" marginTop={isRoomy ? 1 : 0}>
				<Text dimColor wrap="truncate-end">{'─'.repeat(Math.max(10, site.bodyColumns - 4))}</Text>
				<Text color={brand} bold>{name}</Text>
				{isRoomy && <Text> </Text>}
			</Box>
		)
		return (
			<Box flexDirection="column" {...frame}>
				<Box justifyContent="space-between" gap={1}>
					<Box gap={1} flexShrink={1} overflow="hidden">
						<Text color={brand} bold>⨳ Floatee</Text>
						<Text dimColor wrap="truncate-end">{`new ticket in ${slug}`}</Text>
					</Box>
					<Box gap={1} flexShrink={0}>
						<Button key="new-cancel" label="✕ Cancel" dimColor onPress={() => update($, draft, () => DRAFT_OFF)} />
						<Button key="new-create" label={typed.isSending ? '… Creating' : '✓ Create'} variant="primary" dimColor={typed.isSending} onPress={() => createTicket($, text)} />
					</Box>
				</Box>
				{/* #751: the ticket's settings first, then its content, each under a
				    rule, as the sheet's sections. */}
				{hasSettings && newHead('Settings')}
				{/* (A !type or +tag typed shows here too; the text's type wins.) */}
				{hasSettings && <Box flexDirection="column">
					<Box gap={1}>
						{newLabel('Type')}
						{(['todo', 'idea', 'note'] as const).map(v => (
							<Button key={`new-type-${v}`} label={v} variant={v === newType ? 'primary' : undefined} dimColor={v !== newType}
								onPress={() => (namesType(text) ? $.ui.toast(`The text says !${newType}: take it out to choose here`) : update($, draft, d => ({ ...d, type: v })))} />
						))}
					</Box>
					<Box gap={1} flexWrap="wrap">
						{newLabel('Tags')}
						{newTags.length === 0 && !typed.isTagging && <Text dimColor>none</Text>}
						{newTags.map(t => (
							<Button key={`new-tag-${t}`} label={`+${t} ✕`} plain
								onPress={() => update($, draft, d => ({ ...d, tags: (d.tags ?? []).filter(x => x !== t), text: dropTag(d.text, t) }))} />
						))}
						{!typed.isTagging && <Button key="new-tag-add" label="+ tag" dimColor onPress={() => update($, draft, d => ({ ...d, isTagging: true, tagText: '' }))} />}
					</Box>
					{typed.isTagging && (
						<Box gap={1}>
							{newLabel('')}
							<Box flexGrow={1}>
								{field(<Input key="new-tag" value={typed.tagText ?? ''} submitLabel="" autoFocus placeholder="tags, comma or space between"
									onInput={v => { void update($, draft, d => ({ ...d, tagText: v })) }}
									onSubmit={v => { void update($, draft, d => ({ ...d, isTagging: false, tagText: '', tags: [...new Set([...(d.tags ?? []), ...v.split(/[\s,]+/).map(x => x.replace(/^\+/, '').trim().toLowerCase()).filter(Boolean)])] })) }} />)}
							</Box>
							<Button key="new-tag-cancel" label="Cancel" dimColor onPress={() => update($, draft, d => ({ ...d, isTagging: false, tagText: '' }))} />
						</Box>
					)}
					<Box gap={1}>
						{newLabel('Position')}
						{(['top', 'bottom'] as const).map(v => (
							<Button key={`new-position-${v}`} label={`${v === 'top' ? '↑' : '↓'} ${v}`} variant={v === (typed.position ?? 'top') ? 'primary' : undefined} dimColor={v !== (typed.position ?? 'top')}
								onPress={() => update($, draft, d => ({ ...d, position: v }))} />
						))}
					</Box>
					{newPick('assignee', 'Assignee', typed.assignee?.label ?? 'default (this token)', 'assign')}
					{newPick('project', 'Project', typed.project?.label ?? slug, 'change')}
					<Box gap={1} flexWrap="wrap">
						{newLabel('Sleep')}
						{typed.snooze
							? <Box gap={1}>
								<Text color="suggestion">{`💤 until ${wakeLabel(typed.snooze, nowMs)}`}</Text>
								<Button key="new-snooze-clear" label="✕" plain dimColor onPress={() => update($, draft, d => ({ ...d, snooze: null }))} />
							</Box>
							: <Box gap={1}>
								<Text dimColor>awake</Text>
								{([['1 day', 86400], ['3 days', 3 * 86400], ['1 week', 7 * 86400]] as const).map(([name, sec]) => (
									<Button key={`new-snooze-${sec}`} label={name} dimColor onPress={() => update($, draft, d => ({ ...d, snooze: Math.floor((nowMs) / 1000) + sec }))} />
								))}
								{!typed.isSnoozing && <Button key="new-snooze-date" label="date…" dimColor onPress={() => update($, draft, d => ({ ...d, isSnoozing: true, whenText: '', isTagging: false, picking: null }))} />}
							</Box>}
					</Box>
					{typed.isSnoozing && !typed.snooze && (
						<Box gap={1}>
							{newLabel('')}
							<Box flexGrow={1}>
								{field(<Input key="new-when" value={typed.whenText ?? ''} submitLabel="" autoFocus placeholder="2026-11-03, 2026-11-03T09:00, 2w…"
									onInput={v => { void update($, draft, d => ({ ...d, whenText: v })) }}
									onSubmit={v => {
										const epoch = wakeAt(v, nowMs)
										if (typeof epoch !== 'number') { $.ui.toast(epoch.error); return }
										void update($, draft, d => ({ ...d, snooze: epoch, isSnoozing: false, whenText: '' }))
									}} />)}
							</Box>
							<Button key="new-when-cancel" label="Cancel" dimColor onPress={() => update($, draft, d => ({ ...d, isSnoozing: false, whenText: '' }))} />
						</Box>
					)}
				</Box>}
				{newHead('Content')}
				{field(<Input key="new-ticket" value={text} placeholder="Click here, then type the title…" submitLabel="" {...(typed.isTagging ? {} : { autoFocus: true as const })}
					onInput={v => { void update($, draft, d => ({ ...d, text: v })) }}
					onSubmit={v => { void createTicket($, v) }} />)}
				{isRoomy && <Text> </Text>}
				<Text color="gray" wrap="wrap">First line = title · Alt+Enter: new line · +tag · !idea !note · Enter: create</Text>
			</Box>
		)
	}
	if (folded && opened.id === null) return <Box {...frame} flexDirection="column">{header}</Box>

	// Frame (2) + header (2 and a blank) + the "+N" line (1) must fit the rows granted.
	// The pane draws every row and the whole checklist: its body scrolls.
	const room = site.isPane ? 10_000 : Math.max(0, site.maxRows - 6)
	// F3: under our row, a line with the progress and the time since the
	// claim, then its boxes. They take rows from the list, never all of them:
	// short of room, the checklist gives way.
	const held = await read($, checklist)
	const card = !problem && mine !== null && held?.id === mine ? held : null
	const ticked = await read($, now)
	const asleep = await read($, sleepers)
	// Past BOXES boxes, a last line counts what's left out and opens the
	// whole list, as far as the rows granted go (our row, the summary and
	// that line kept).
	const isOpen = await read($, isChecklistOpen)
	const hasToggle = !site.isPane && (card?.boxes.length ?? 0) > BOXES
	const view = card ? site.isPane ? visible(card.boxes, card.boxes.length, true) : visible(card.boxes, isOpen ? Math.max(BOXES, room - 3) : BOXES, isOpen) : null
	const extra = view ? 1 + view.shown.length + (hasToggle || view.more + view.checked > 0 ? 1 : 0) : 0
	// #693: the session's ticket leads, apart from the queue: a section of
	// its own in the pane, the first row of the band. Always drawn; the
	// others share what rows are left.
	const ours = problem || mine === null || room < 1 ? null : list.find(i => i.id === mine) ?? null
	const spare = room - (ours ? 1 : 0)
	const showCard = ours !== null && extra > 0 && spare - extra >= 0
	// #679: the pane lists the blocked todos in a section of their own.
	const queue = list.filter(i => i !== ours && (!site.isPane || i.status !== 'blocked'))
	const rows = problem ? [] : queue.slice(0, Math.max(0, Math.min(cap - (ours ? 1 : 0), showCard ? spare - extra : spare)))
	const more = problem ? 0 : queue.length - rows.length
	const known = site.isPane ? await read($, detail) : null
	const told = known && known.id === mine ? known : null
	// Box texts are cut by hand: a Button's label doesn't truncate.
	const textWidth = Math.max(10, site.bodyColumns - 14)
	const checklistView = (c: NonNullable<typeof card>) => {
		const done = c.boxes.filter(b => b.isDone).length
		const { shown, more: rest, checked } = view ?? visible(c.boxes, BOXES)
		const left = [rest > 0 && `+${rest} more`, checked > 0 && `${checked} checked`].filter(Boolean).join(' · ')
		const since = c.since !== null && ticked ? elapsed(ticked - c.since) : null
		const facts = [
			c.boxes.length ? `${done}/${c.boxes.length} done` : 'no checklist',
			since && (since === 'just now' ? 'claimed just now' : `claimed ${since} ago`),
		]
		return (
			<Box key={`checklist-${c.id}`} flexDirection="column" paddingLeft={2}>
				{/* #679: the pane opens with the start of the description. */}
				{told?.intro.map((line, n) => <Text key={`intro-${n}`} wrap="wrap">{line}</Text>)}
				<Text dimColor>{facts.filter(Boolean).join(' · ')}</Text>
				{shown.map(b => (
					<Button
						key={`box-${c.id}-${b.line}`}
						label={`${b.isDone ? '☑' : '☐'} ${b.text.length > textWidth ? `${b.text.slice(0, textWidth - 1)}…` : b.text}`}
						plain
						dimColor={b.isDone}
						onPress={() => tick($, c.id, b)}
					/>
				))}
				{(hasToggle || left) && (
					<Box gap={1}>
						{left && <Text dimColor>{left}</Text>}
						{hasToggle && <Button key={`checklist-toggle-${c.id}`} label={isOpen ? '▴ see less' : '▾ see all'} plain dimColor onPress={() => update($, isChecklistOpen, v => !v)} />}
					</Box>
				)}
				{told?.last && <Text dimColor wrap="wrap">{`💬 ${told.last.by}: ${told.last.text}`}</Text>}
			</Box>
		)
	}

	// #679: under a row in the pane, what the band has no room for: tags, the
	// checklist's progress, the comments, the last change. #694: one line,
	// the tags on the left (cut at the edge), the facts flush right, always
	// in that order: `✓ 4/5 · 2 comments · 1d 3h ago`.
	const metaOf = (item: Item) => {
		// (`?? ` for the items a load before #679 left in the state.)
		const tags = item.tags ?? []
		const facts = [
			item.boxes && `✓ ${item.boxes.done}/${item.boxes.total}`,
			(item.comments ?? 0) > 0 && `${item.comments} comment${item.comments === 1 ? '' : 's'}`,
			item.updatedAt && ticked && `${elapsed(ticked - item.updatedAt)} ago`.replace('just now ago', 'just now'),
		].filter(Boolean) as string[]
		if (!tags.length && !facts.length) return null
		return (
			<Box key={`meta-${item.id}`} justifyContent="space-between" gap={2}>
				<Text color="suggestion" wrap="truncate-end">{tags.map(t => `+${t}`).join(' ')}</Text>
				{facts.length > 0 && <Box flexShrink={0}><Text dimColor>{facts.join(' · ')}</Text></Box>}
			</Box>
		)
	}
	const folded2 = await read($, folds)
	const kept = site.isPane ? await read($, others) : []
	// Ideas and notes start folded (a sheet's description open); a press keeps
	// the person's choice.
	const isFolded = (name: string, byDefault = true) => folded2[name] ?? byDefault
	// Each section opens on a dim rule across the pane, then its name: the
	// todos, the blocked, the ideas and the notes read apart.
	const rule = '─'.repeat(Math.max(10, site.bodyColumns - 4))
	// (`aside`: what the section's head carries on its right, a button.)
	const sectionHead = (name: string, label: string, count: number | null, color: string, canFold: boolean, byDefault = true, aside?: RenderNode | false) => {
		const head = canFold
			? <Button key={`fold-${name}`} label={`${isFolded(name, byDefault) ? '▸' : '▾'} ${label}${count === null ? '' : ` (${count})`}`} plain onPress={() => update($, folds, f => ({ ...f, [name]: !(f[name] ?? byDefault) }))} />
			: <Text color={color} bold>{count === null ? label : `${label} (${count})`}</Text>
		return (
			<Box key={`section-${name}`} flexDirection="column" marginTop={1}>
				<Text dimColor wrap="truncate-end">{rule}</Text>
				{aside ? <Box justifyContent="space-between" gap={1}>{head}{aside}</Box> : head}
			</Box>
		)
	}

	// #747: a ticket's sheet takes the list's place, folded or not: its title,
	// tags and facts, then its type and status. Blocked, done and won't fix
	// open a field for their text (the why, a resolution note) and their
	// confirms. The mobile app draws no field nor list: buttons there, and the
	// steps that need a text (blocked) left out.
	if (opened.id !== null) {
		const item = [...list, ...await read($, others), ...await read($, sleepers)].find(i => i.id === opened.id) ?? null
		const back = <Button key="sheet-back" label="← Back" variant="primary" onPress={() => update($, sheet, () => SHEET_OFF)} />
		const top = (
			<Box justifyContent="space-between" gap={1}>
				<Box gap={1} flexShrink={1} overflow="hidden">
					<Text color={brand} bold>⨳ Floatee</Text>
					{item ? idOf(item, brand) : <Text dimColor>{`#${opened.id}`}</Text>}
				</Box>
				<Box gap={1} flexShrink={0}>
					{item && pageOf(item) && <Button key="sheet-open" label="↗ Open" dimColor onPress={() => openPage($, pageOf(item)!)} />}
					{back}
				</Box>
			</Box>
		)
		if (!item) {
			return (
				<Box flexDirection="column" {...frame}>
					{top}
					<Text dimColor>{`#${opened.id} is no longer open.`}</Text>
				</Box>
			)
		}
		const statuses = statusesOf(item)
		const step = opened.step
		const sending = opened.isSending
		// #747: a row of buttons each, the current one lit (a Select's list
		// stays open in the terminal). Blocked, done and won't fix open their
		// field; without fields (mobile), done and won't fix close at once and
		// blocked, which needs its why, is left out.
		// #749: the rows' names, in one column.
		const label = (name: string) => <Box flexShrink={0}><Text dimColor>{name.padEnd(8)}</Text></Box>
		// Its tags, each a press away from going (the whole `+tag ✕`); + tag
		// opens a field (none on mobile).
		const tags = item.tags ?? []
		const tagLine = (
			<Box gap={1} flexWrap="wrap">
				{label('Tags')}
				{tags.length === 0 && !opened.isTagging && <Text dimColor>none</Text>}
				{tags.map(t => (
					<Button key={`sheet-tag-${t}`} label={`+${t} ✕`} plain onPress={() => setTags($, item, tags.filter(x => x !== t))} />
				))}
				{Input && !opened.isTagging && <Button key="sheet-tag-add" label="+ tag" dimColor onPress={() => update($, sheet, s => ({ ...s, isTagging: true, tagText: '', picking: null }))} />}
			</Box>
		)
		const tagField = Input && opened.isTagging && (
			<Box gap={1}>
				{label('')}
				<Box flexGrow={1}>
					{field(<Input key="sheet-tag" value={opened.tagText} submitLabel="" autoFocus placeholder="tags, comma or space between"
						onInput={v => { void update($, sheet, s => ({ ...s, tagText: v })) }}
						onSubmit={v => { void addTags($, item, v) }} />)}
				</Box>
				<Button key="sheet-tag-cancel" label="Cancel" dimColor onPress={() => update($, sheet, s => ({ ...s, isTagging: false, tagText: '' }))} />
			</Box>
		)
		// Assignee and project: the current one, then its choices on a press.
		const metaLine = (what: 'assignee' | 'project', name: string, value: string | null, action: string) => (
			<Box flexDirection="column">
				<Box gap={1}>
					{label(name)}
					<Text dimColor={!value} wrap="truncate-end">{value ?? 'nobody'}</Text>
					{opened.picking !== what && <Button key={`sheet-${what}`} label={action} dimColor onPress={() => pickMeta($, item, what)} />}
				</Box>
				{opened.picking === what && (
					<Box gap={1} flexWrap="wrap" paddingLeft={9}>
						{opened.choices === null && <Text dimColor>…</Text>}
						{opened.choices?.length === 0 && <Text dimColor>{what === 'project' ? 'No other project in this workspace.' : 'Nobody to assign.'}</Text>}
						{opened.choices?.map(c => (
							<Button key={`sheet-${what}-${c.value || 'none'}`} label={c.label}
								onPress={() => (what === 'assignee' ? assign($, item, c.value) : moveTo($, item, c.value, c.label))} />
						))}
						<Button key={`sheet-${what}-cancel`} label="Cancel" dimColor onPress={() => update($, sheet, s => ({ ...s, picking: null, choices: null }))} />
					</Box>
				)}
			</Box>
		)
		// #750: asleep, its wake-up and ☀ wake; awake, the short delays and a
		// date (a field; none on mobile). Then delete, asked first.
		const SNOOZES: Array<[string, number]> = [['1 day', 86400], ['3 days', 3 * 86400], ['1 week', 7 * 86400]]
		const sleepLine = (
			<Box gap={1} flexWrap="wrap">
				{label('Sleep')}
				{item.until
					? <Box gap={1}>
						<Text color="suggestion">{`💤 until ${wakeLabel(item.until, ticked ?? 0)}`}</Text>
						<Button key="sheet-wake" label="☀ wake" onPress={() => snooze($, item, null)} />
					</Box>
					: <Box gap={1}>
						{SNOOZES.map(([name, s]) => (
							<Button key={`sheet-snooze-${s}`} label={name} dimColor onPress={() => snooze($, item, Math.floor((ticked ?? 0) / 1000) + s)} />
						))}
						{Input && !opened.isSnoozing && <Button key="sheet-snooze-date" label="date…" dimColor onPress={() => update($, sheet, s => ({ ...s, isSnoozing: true, whenText: '', isTagging: false, picking: null }))} />}
					</Box>}
			</Box>
		)
		const whenField = Input && opened.isSnoozing && !item.until && (
			<Box gap={1}>
				{label('')}
				<Box flexGrow={1}>
					{field(<Input key="sheet-when" value={opened.whenText} submitLabel="" autoFocus placeholder="2026-11-03, 2026-11-03T09:00, 2w…"
						onInput={v => { void update($, sheet, s => ({ ...s, whenText: v })) }}
						onSubmit={v => { void snoozeTyped($, item, v) }} />)}
				</Box>
				<Button key="sheet-when-cancel" label="Cancel" dimColor onPress={() => update($, sheet, s => ({ ...s, isSnoozing: false, whenText: '' }))} />
			</Box>
		)
		const deleteLine = (
			<Box gap={1} justifyContent="flex-end" marginTop={1}>
				{opened.isDeleting
					? <Box gap={1}>
						<Text color="warning">{`Delete #${item.id}?`}</Text>
						<Button key="sheet-delete-item-confirm" label="🗑 Delete" variant="primary" onPress={() => deleteItem($, item)} />
						<Button key="sheet-delete-item-cancel" label="Cancel" dimColor onPress={() => update($, sheet, s => ({ ...s, isDeleting: false }))} />
					</Box>
					: <Button key="sheet-delete-item" label="🗑 Delete" dimColor onPress={() => update($, sheet, s => ({ ...s, isDeleting: true }))} />}
			</Box>
		)
		const typeLine = (
			<Box gap={1}>
				{label('Type')}
				{(['todo', 'idea', 'note'] as const).map(v => (
					<Button key={`sheet-type-${v}`} label={v} variant={v === item.type ? 'primary' : undefined} dimColor={v !== item.type} onPress={() => setType($, item, v)} />
				))}
			</Box>
		)
		const lit = step ?? item.status
		const statusLine = (
			<Box gap={1} flexWrap="wrap">
				{label('Status')}
				{statuses.filter(v => Input || v !== 'blocked').map(v => (
					<Button key={`sheet-status-${v}`} label={STATUS_LABELS[v]} variant={v === lit ? 'primary' : undefined} dimColor={v !== lit}
						onPress={() => (!Input && (v === 'done' || v === 'wontfix') ? confirmStatus($, item, v, '') : pickStatus($, item, v))} />
				))}
			</Box>
		)
		// The step's field and confirms: Enter does the first one.
		const stepView = Input && step && (
			<Box flexDirection="column" marginTop={1}>
				{field(<Input key="sheet-note" value={opened.text} submitLabel="" autoFocus
					placeholder={step === 'blocked' ? 'Why is it blocked? (required)' : 'Resolution note (optional)'}
					onInput={v => { void update($, sheet, s => ({ ...s, text: v })) }}
					onSubmit={v => { void confirmStatus($, item, step, v) }} />)}
				<Box gap={1} justifyContent="flex-end">
					{step === 'blocked' && <Button key="sheet-confirm" label={sending ? '… Saving' : '⊝ Block'} variant="primary" dimColor={sending} onPress={() => confirmStatus($, item, 'blocked', opened.text)} />}
					{step === 'done' && <Button key="sheet-confirm" label={sending ? '… Saving' : '✓ Done'} variant="primary" dimColor={sending} onPress={() => confirmStatus($, item, 'done', opened.text)} />}
					{step === 'done' && <Button key="sheet-verify" label="✓ Verify & close" dimColor={busy} onPress={() => confirmStatus($, item, 'verify', opened.text)} />}
					{step === 'wontfix' && <Button key="sheet-confirm" label={sending ? '… Saving' : "✕ Won't fix"} variant="primary" dimColor={sending} onPress={() => confirmStatus($, item, 'wontfix', opened.text)} />}
					<Button key="sheet-cancel" label="Cancel" dimColor onPress={() => update($, sheet, s => ({ ...s, step: null, text: '' }))} />
				</Box>
			</Box>
		)
		// Its description, its markdown drawn: headings, lists, boxes, quotes,
		// code, and the inline styles. The pane shows it whole; the band what
		// its rows leave, each line cut at the edge, the rest counted.
		const wrap = site.isPane ? 'wrap' as const : 'truncate-end' as const
		const spansOf = (spans: Span[], base: { dimColor?: boolean; italic?: boolean } = {}) => spans.map((sp, n) => (
			<Text key={`s-${n}`} {...base} bold={sp.bold} italic={sp.italic || base.italic} strikethrough={sp.strike}
				underline={sp.link} color={sp.code ? 'permission' : sp.link ? 'suggestion' : undefined}>{sp.text}</Text>
		))
		// A list's marker hangs: its wrapped lines start under the text.
		const hanging = (key: string, indent: number, marker: RenderChildren, body: RenderChildren) => (
			<Box key={key} paddingLeft={indent * 2} gap={1}>
				<Box flexShrink={0}>{marker}</Box>
				<Text wrap={wrap}>{body}</Text>
			</Box>
		)
		// (`pressed` pairs task blocks with the body's boxes: the description's;
		// a comment's boxes don't press.)
		const drawnWith = (pressed: ReadonlyMap<number, ReturnType<typeof boxes>[number]>, prefix: string) => (b: Block, n: number) => {
			const key = `${prefix}-${n}`
			switch (b.kind) {
				case 'heading': return <Text key={key} wrap={wrap} bold color={brand}>{spansOf(b.spans)}</Text>
				case 'item': return hanging(key, b.indent, <Text dimColor>{b.marker}</Text>, spansOf(b.spans))
				case 'task': {
					// A box presses as in the band: its whole line, the label cut by
					// hand (a Button's label doesn't wrap).
					const box = pressed.get(n)
					const words = b.spans.map(sp => sp.text).join('')
					const room = Math.max(10, site.bodyColumns - 8 - b.indent * 2)
					const label = `${b.isDone ? '☑' : '☐'} ${words.length > room ? `${words.slice(0, room - 1)}…` : words}`
					return box
						? <Box key={key} paddingLeft={b.indent * 2}><Button key={`sheet-box-${box.line}`} label={label} plain dimColor={b.isDone} onPress={() => tick($, item.id, box)} /></Box>
						: hanging(key, b.indent, <Text color={b.isDone ? 'success' : undefined}>{b.isDone ? '☑' : '☐'}</Text>, spansOf(b.spans, { dimColor: b.isDone }))
				}
				case 'quote': return hanging(key, 0, <Text dimColor>│</Text>, spansOf(b.spans, { dimColor: true, italic: true }))
				case 'code': return <Text key={key} wrap={wrap} color="permission">{`  ${b.text || ' '}`}</Text>
				case 'rule': return <Text key={key} dimColor wrap="truncate-end">{'─'.repeat(Math.max(10, site.bodyColumns - 4))}</Text>
				case 'blank': return <Text key={key}> </Text>
				case 'para': return <Text key={key} wrap={wrap}>{spansOf(b.spans)}</Text>
			}
		}
		// The description: the whole body, its first line (the title) included,
		// as the site draws it. Its task blocks pair with the body's boxes in
		// order (the same reading, code skipped), so a press flips the right
		// line; when they don't pair, none presses.
		const body = opened.body ?? ''
		const lines = blocks(body)
		const theBoxes = boxes(body)
		const tasks = lines.flatMap((b, n) => (b.kind === 'task' ? [n] : []))
		const boxAt = new Map(tasks.length === theBoxes.length ? tasks.map((n, k) => [n, theBoxes[k]!] as const) : [])
		const drawn = drawnWith(boxAt, 'body')
		const isShut = isFolded('sheet-body', false)
		// #752: ✎ Edit shows the body's raw lines, each a press away from a
		// field (the field is one line: the body is edited line by line). The
		// line in the field has + (a line after) and ✕ (delete); Enter saves.
		const isEditing = opened.isEditing && opened.body !== null && Boolean(Input)
		const raw = (opened.body ?? '').split('\n')
		const editButton = Input && !isShut && opened.body !== null && (
			<Box flexShrink={0}>
				<Button key="sheet-edit-body" label={opened.isEditing ? '✓ Done editing' : '✎ Edit'} variant={opened.isEditing ? 'primary' : undefined} dimColor={!opened.isEditing}
					onPress={() => update($, sheet, s => ({ ...s, isEditing: !s.isEditing, editLine: null, lineText: '' }))} />
			</Box>
		)
		const room = Math.max(10, site.bodyColumns - 8)
		const rawLine = (line: string, n: number) => {
			if (opened.editLine === n && Input) {
				return (
					<Box key={`raw-${n}`} flexDirection="column">
						{field(<Input key="sheet-line" value={opened.lineText} submitLabel="" autoFocus placeholder={n === 0 ? 'The title' : 'An empty line'}
							onInput={v => { void update($, sheet, s => ({ ...s, lineText: v })) }}
							onSubmit={v => { void writeLine($, item.id, n, v) }} />)}
						<Box gap={1} justifyContent="flex-end">
							<Button key="sheet-line-save" label={opened.isSending ? '… Saving' : '↵ Save'} variant="primary" dimColor={opened.isSending} onPress={() => writeLine($, item.id, n, opened.lineText)} />
							<Button key="sheet-line-add" label="+ line after" dimColor onPress={() => writeLine($, item.id, n, '', true)} />
							{n > 0 && <Button key="sheet-line-delete" label="✕ delete line" dimColor onPress={() => writeLine($, item.id, n, null)} />}
							<Button key="sheet-line-cancel" label="Cancel" dimColor onPress={() => update($, sheet, s => ({ ...s, editLine: null, lineText: '' }))} />
						</Box>
					</Box>
				)
			}
			const shownText = line.length > room ? `${line.slice(0, room - 1)}…` : line
			return (
				<Button key={`sheet-line-${n}`} label={shownText || '·'} plain bold={n === 0} dimColor={!line}
					onPress={() => update($, sheet, s => ({ ...s, editLine: n, lineText: line }))} />
			)
		}
		// #748: the activity, as on the site: newest first, the opening last;
		// a comment with its markdown, an event in a line, a resolution with its
		// note. The band shows the first ENTRIES (a comment cut to a few lines)
		// unless ▾ all.
		const feed = opened.feed ?? []
		const isFeedShut = isFolded('sheet-activity', false)
		const isWhole = site.isPane || opened.isAll
		const seen = isWhole ? feed : feed.slice(0, ENTRIES)
		const centred = (line: string) => {
			const side = Math.max(2, Math.floor((rule.length - [...line].length - 2) / 2))
			return `${'─'.repeat(side)} ${line} ${'─'.repeat(side)}`
		}
		const agoOf = (at: number) => (ticked && at ? `${elapsed(ticked - at)} ago`.replace('just now ago', 'just now') : '')
		const entryView = (c: Entry) => {
			if (c.kind !== 'comment') {
				const said = c.body ? blocks(c.body) : []
				const cut = isWhole ? said : said.slice(0, COMMENT_LINES)
				return (
					<Box key={`e-${c.key}`} flexDirection="column">
						{/* Centred between two rules, as the site's separator: the rules
						    cut to the sheet's width (the section's rule), the line kept. */}
						<Text dimColor wrap="truncate-end">{centred([c.author, c.event, agoOf(c.at)].filter(Boolean).join(' · '))}</Text>
						{c.body && (
							<Box flexDirection="column" paddingLeft={2}>
								<Text color={c.isWontfix ? 'error' : 'success'}>{c.isWontfix ? "✕ Won't fix" : '✓ Resolution'}</Text>
								{cut.map(drawnWith(new Map(), `n${c.key}`))}
								{cut.length < said.length && <Text dimColor>…</Text>}
							</Box>
						)}
					</Box>
				)
			}
			const said = blocks(c.body ?? '')
			const cut = isWhole ? said : said.slice(0, COMMENT_LINES)
			const by = `${c.author} · ${agoOf(c.at)} · c${c.seq}${c.isEdited ? ' · edited' : ''}`
			return (
				<Box key={`c-${c.seq}`} flexDirection="column">
					<Box justifyContent="space-between" gap={1}>
						<Text dimColor={opened.editing !== c.seq} color={opened.editing === c.seq ? brand : undefined} bold={opened.editing === c.seq} wrap="truncate-end">{by}</Text>
						{c.canEdit && (
							<Box gap={1} flexShrink={0}>
								<Button key={`sheet-edit-${c.seq}`} label={glyph('✎')} plain dimColor onPress={() => editComment($, item, c)} />
								<Button key={`sheet-delete-${c.seq}`} label={glyph('✕')} plain dimColor onPress={() => update($, sheet, s => ({ ...s, deleting: c.seq }))} />
							</Box>
						)}
					</Box>
					<Box flexDirection="column" paddingLeft={2}>
						{cut.map(drawnWith(new Map(), `c${c.seq}`))}
						{cut.length < said.length && <Text dimColor>…</Text>}
					</Box>
					{opened.deleting === c.seq && (
						<Box gap={1} justifyContent="flex-end">
							<Text color="warning">{`Delete c${c.seq}?`}</Text>
							<Button key="sheet-delete-confirm" label="✕ Delete" variant="primary" onPress={() => deleteComment($, item.id, c.seq!)} />
							<Button key="sheet-delete-cancel" label="Cancel" dimColor onPress={() => update($, sheet, s => ({ ...s, deleting: null }))} />
						</Box>
					)}
				</Box>
			)
		}
		const editing = opened.editing
		const posting = opened.isPosting
		// The comment field, behind ＋ Comment as on the site (✎ opens it too).
		const composeButton = Input && !opened.isComposing && (
			<Box flexShrink={0}><Button key="sheet-compose" label="+ Comment" variant="primary" onPress={() => update($, sheet, s => ({ ...s, isComposing: true, editing: null, reply: '' }))} /></Box>
		)
		const replyView = Input && opened.isComposing && (
			<Box flexDirection="column">
				{field(<Input key="sheet-comment" value={opened.reply} submitLabel="" autoFocus
					placeholder={editing === null ? 'Comment…' : `Fix c${editing}…`}
					onInput={v => { void update($, sheet, s => ({ ...s, reply: v })) }}
					onSubmit={v => { void sendComment($, item.id, v) }} />)}
				<Box gap={1} justifyContent="flex-end">
					<Button key="sheet-reply-cancel" label="Cancel" dimColor onPress={() => update($, sheet, s => ({ ...s, isComposing: false, editing: null, reply: '' }))} />
					<Button key="sheet-send" label={posting ? '… Saving' : editing === null ? '↵ Comment' : '↵ Save'} variant="primary" dimColor={posting || !opened.reply.trim()} onPress={() => sendComment($, item.id, opened.reply)} />
				</Box>
			</Box>
		)
		// Rows the activity takes in the band (head, each entry's lines, the
		// toggle, the field), so the description leaves it room.
		const entryRows = (c: Entry) => 1 + (c.body ? Math.min(COMMENT_LINES + 1, blocks(c.body).length) + (c.kind === 'comment' ? 0 : 1) : 0)
		const threadRows = isFeedShut ? 2 : 3 + seen.reduce((n, c) => n + entryRows(c), 0) + (feed.length > seen.length ? 1 : 0) + (opened.isComposing ? 2 : 0)
		// The band: its rows, less the sheet's own lines (frame, top, two
		// sections, facts, type, status), the step's field and the comments.
		const fits = site.isPane ? lines.length : Math.max(2, site.maxRows - (isFolded('sheet-details', false) ? 9 : 20) - (step ? 3 : 0) - (opened.isTagging || opened.isSnoozing ? 1 : 0) - (opened.picking ? 2 : 0) - threadRows)
		const shown = lines.length > fits ? lines.slice(0, fits - 1) : lines
		// Editing in the band: a window of raw lines around the one in the field.
		const rawFits = site.isPane ? raw.length : Math.max(2, fits - 2)
		const rawFrom = raw.length <= rawFits ? 0 : Math.min(raw.length - rawFits, Math.max(0, (opened.editLine ?? 0) - Math.floor(rawFits / 2)))
		const rawShown = raw.slice(rawFrom, rawFrom + rawFits)
		// #747: the details and what changes the ticket, then its description,
		// each under a rule, as the list's sections; the description folds.
		return (
			<Box flexDirection="column" {...frame}>
				{top}
				{sectionHead('sheet-details', 'Details', null, brand, true, false)}
				{/* (Folds as the other sections: open by default.) */}
				{!isFolded('sheet-details', false) && <Text> </Text>}
				{!isFolded('sheet-details', false) && (
					<Box flexDirection="column">
						{metaOf({ ...item, tags: [] })}
						<Box flexDirection="column" marginTop={1}>
							{typeLine}
							{statusLine}
							{tagLine}
							{tagField}
							{metaLine('assignee', 'Assignee', opened.assignee, 'assign')}
							{metaLine('project', 'Project', opened.project ?? config?.project ?? null, 'move')}
							{sleepLine}
							{whenField}
						</Box>
						{deleteLine}
					</Box>
				)}
				{stepView}
				{sectionHead('sheet-body', 'Description', null, brand, true, false, editButton)}
				{/* (A blank line under an open section's head.) */}
				{!isShut && <Text> </Text>}
				{!isShut && isEditing && (
					<Box flexDirection="column">
						{rawFrom > 0 && <Text dimColor>{`… ${rawFrom} line${rawFrom === 1 ? '' : 's'} above`}</Text>}
						{rawShown.map((line, k) => rawLine(line, rawFrom + k))}
						{rawFrom + rawShown.length < raw.length && <Text dimColor>{`… ${raw.length - rawFrom - rawShown.length} more below`}</Text>}
						<Text dimColor wrap="wrap">Press a line to edit it · the first line is the title · ↗ Open for a full rewrite</Text>
					</Box>
				)}
				{!isShut && !isEditing && (opened.body === null
					? <Text dimColor>…</Text>
					: lines.length === 0
						? <Text dimColor>No description.</Text>
						: (
							<Box flexDirection="column">
								{shown.map(drawn)}
								{shown.length < lines.length && <Text dimColor>{`+${lines.length - shown.length} more lines · ↗ Open for all`}</Text>}
							</Box>
						))}
				{sectionHead('sheet-activity', 'Activity', null, brand, true, false, !isFeedShut && composeButton)}
				{!isFeedShut && <Text> </Text>}
				{!isFeedShut && (
					<Box flexDirection="column" gap={site.isPane ? 1 : 0}>
						{replyView}
						{opened.feed === null && <Text dimColor>…</Text>}
						{seen.map(entryView)}
						{!site.isPane && feed.length > ENTRIES && (
							<Button key="sheet-all" label={opened.isAll ? '▴ latest only' : `▾ all (${feed.length})`} plain dimColor onPress={() => update($, sheet, s => ({ ...s, isAll: !s.isAll }))} />
						)}
					</Box>
				)}
			</Box>
		)
	}

	const watchedNow = await read($, blocked)
	// One todo's row (its checklist under it when ours); `of` is its section,
	// for the arrows. In the pane, `under` (why it is blocked) follows the facts.
	const rowOf = (item: Item, i: number, of: Item[], under: RenderChildren[] = []) => {
		// Ours is in progress even before a refresh has seen the claim.
		const isCurrent = item.status === 'in_progress' || item.id === mine
		const isBlocked = item.status === 'blocked'
		const hasReply = replyIds.includes(item.id)
		const isSent = sent === item.id
		const actions = (
				<Box gap={1} flexShrink={0}>
					{/* State: its icon (⊛ in progress, ⊝ blocked, ⊙ queued) + its name;
					    blank for a plain pending todo. Padded so the actions after it
					    line up from row to row. */}
					{/* #693: in the pane, ours sits under its own "In progress" head:
					    no state to repeat, its title keeps the room. */}
					{!(site.isPane && item.id === mine) && (
						<Text color={isCurrent ? 'success' : isBlocked || isSent ? 'warning' : undefined} dimColor={!isCurrent && !isBlocked && !isSent}>
							{(isSent ? '⊙ queued' : isCurrent ? '⊛ in progress' : hasReply ? '✉ replied' : isBlocked ? '⊝ blocked' : '').padEnd(13)}
						</Text>
					)}
					{/* Both arrow slots are always there (a blank stands in for a
					    missing one) so the arrows line up from row to row. */}
					{/* (Hidden with Mine on: a reorder needs the project's whole order.) */}
					{!isCurrent && !isSent && !mineOnly && (i > 0
						? <Button key={`up-${item.id}`} label="↑" plain dimColor onPress={() => move($, item.id, -1)} />
						: <Text> </Text>)}
					{!isCurrent && !isSent && !mineOnly && (i < of.length - 1
						? <Button key={`down-${item.id}`} label="↓" plain dimColor onPress={() => move($, item.id, 1)} />
						: <Text> </Text>)}
					{!isCurrent && !isSent && (mine === null && !busy && sent === null
						? hasReply
							? <Button key={`resume-${item.id}`} label={label('↻ Resume', '↻')} variant="primary" onPress={() => launch($, item.id)} />
							: <Button key={`run-${item.id}`} label={label('▶ Run', '▶')} variant="primary" onPress={() => launch($, item.id)} />
						: <Text color={GREY}>{greyed(hasReply ? label('↻ Resume', '↻') : label('▶ Run', '▶'))}</Text>)}
					{/* #685: the same ticket through /todo-guided, its checkpoints asked. */}
					{!isCurrent && !isSent && (mine === null && !busy && sent === null
						? <Button key={`guided-${item.id}`} label={label('▷ Guided', '▷')} onPress={() => launch($, item.id, 'todo-guided')} />
						: <Text color={GREY}>{greyed(label('▷ Guided', '▷'))}</Text>)}
					{/* The session's own ticket: Close in Run's place, and Release to
					    put it back in the queue (after a Stop, say). */}
					{item.id === mine && (
						<Box gap={1}>
							{!site.isPane && <Text> </Text>}
							{!site.isPane && <Text> </Text>}
							<Button key={`release-${item.id}`} label={label('↩ Release', '↩')} dimColor={busy} onPress={() => busy ? $.ui.toast('Claude is busy: try again when the turn ends') : release($, 'band', true)} />
							{closeButton(item.id, narrow)}
						</Box>
					)}
					{/* #747: the ticket's sheet (type, status): [⋮], the brackets clickable too. */}
					<Button key={`more-${item.id}`} label={glyph('⋮')} plain dimColor onPress={() => openSheet($, item.id)} />
				</Box>
		)
		const title = <Text wrap={site.isPane && item.id === mine ? 'wrap' : 'truncate-end'} bold={isCurrent} dimColor={isBlocked && !hasReply}>{item.title}</Text>
		// #694: in the pane, a ticket reads in full-width lines: its id and its
		// actions, its title (ours in full, the others cut), its tags, its facts.
		const row = site.isPane
			? (
				<Box key={`row-${item.id}`} flexDirection="column">
					<Box justifyContent="space-between" gap={2}>
						<Box flexShrink={0}>{idOf(item, isCurrent ? 'success' : brand, isCurrent)}</Box>
						{actions}
					</Box>
					{title}
					{metaOf(item)}
					{under}
				</Box>
			)
			: (
				<Box key={`row-${item.id}`} justifyContent="space-between" gap={2}>
					<Box gap={1} flexShrink={1} overflow="hidden">
						{/* The id never wraps: only the title gives way. */}
						<Box flexShrink={0}>
							{idOf(item, isCurrent ? 'success' : brand, isCurrent)}
						</Box>
						{title}
					</Box>
					{actions}
				</Box>
			)
		if (!(showCard && card && item.id === mine)) return row
		return <Box key={`mine-${item.id}`} flexDirection="column">{row}{checklistView(card)}</Box>
	}
	const blockedRows = site.isPane && !problem ? list.filter(i => i.status === 'blocked') : []

	return (
		<Box flexDirection="column" {...frame}>
			{header}
			{site.isPane && ours && sectionHead('current', '⊛ In progress', null, 'success', false)}
			{ours && rowOf(ours, 0, [ours])}
			{site.isPane && !problem && sectionHead('todos', 'Todos', rows.length, brand, false)}
			{/* The pane has room: a blank line between tickets, for the eye. */}
			<Box flexDirection="column" gap={site.isPane ? 1 : 0}>
				{rows.map((item, i) => rowOf(item, i, site.isPane ? rows : queue))}
			</Box>
			{more > 0 && <Text dimColor>{`+${more} more`}</Text>}
			{site.isPane && blockedRows.length > 0 && sectionHead('blocked', '⊝ Blocked', blockedRows.length, 'warning', false)}
			{site.isPane && blockedRows.length > 0 && (
				<Box flexDirection="column" gap={1}>
					{blockedRows.map((item, i) => {
						const w = watchedNow[item.id]
						return (
							<Box key={`blocked-${item.id}`} flexDirection="column">
								{rowOf(item, i, blockedRows, [
									w?.why && <Text key={`why-${item.id}`} color="warning" wrap="truncate-end">{`why: ${w.why}`}</Text>,
									w?.reply && <Text key={`reply-${item.id}`} color="success">{`✉ ${w.reply.by} replied`}</Text>,
								])}
							</Box>
						)
					})}
				</Box>
			)}
			{site.isPane && (['idea', 'note'] as const).map(type => {
				const of = kept.filter(i => i.type === type)
				if (!of.length) return null
				const name = type === 'idea' ? 'ideas' : 'notes'
				return (
					<Box key={`list-${name}`} flexDirection="column">
						{sectionHead(name, type === 'idea' ? 'Ideas' : 'Notes', of.length, brand, true)}
						{!isFolded(name) && (
							<Box flexDirection="column" gap={1}>
								{of.map(item => (
									<Box key={`other-${item.id}`} flexDirection="column">
										<Box justifyContent="space-between" gap={2}>
											<Box flexShrink={0}>{idOf(item, brand)}</Box>
											<Button key={`more-${item.id}`} label={glyph('⋮')} plain dimColor onPress={() => openSheet($, item.id)} />
										</Box>
										<Text wrap="truncate-end">{item.title}</Text>
										{metaOf(item)}
									</Box>
								))}
							</Box>
						)}
					</Box>
				)
			})}
			{/* #750: the sleeping ones, folded: their wake-up, ☀ to wake one now. */}
			{site.isPane && asleep.length > 0 && (
				<Box key="list-sleeping" flexDirection="column">
					{sectionHead('sleeping', '💤 Sleeping', asleep.length, brand, true)}
					{!isFolded('sleeping') && (
						<Box flexDirection="column" gap={1}>
							{asleep.map(item => (
								<Box key={`sleeper-${item.id}`} flexDirection="column">
									<Box justifyContent="space-between" gap={2}>
										<Box flexShrink={0} gap={1}>{idOf(item, brand)}<Text dimColor>{`until ${wakeLabel(item.until ?? 0, ticked ?? 0)}`}</Text></Box>
										<Box flexShrink={0} gap={1}>
											<Button key={`wake-${item.id}`} label="☀ wake" dimColor onPress={() => snooze($, item, null)} />
											<Button key={`more-${item.id}`} label={glyph('⋮')} plain dimColor onPress={() => openSheet($, item.id)} />
										</Box>
									</Box>
									<Text wrap="truncate-end">{item.title}</Text>
								</Box>
							))}
						</Box>
					)}
				</Box>
			)}
		</Box>
	)
}

export const register: Register = on => {
	on('session.start', async ($, e, next) => {
		$.ui.status(undefined) // an earlier version kept a status line: clear it
		// A load or reload happens between turns: no turn runs, nothing is queued.
		// (A turn.start seen by the previous load may never have met its
		// turn.complete, which left the band thinking Claude still worked.)
		await update($, isBusy, () => false)
		await update($, asked, () => 0)
		await update($, turnId, () => null)
		await update($, launched, () => null)
		config = await findConfig($)
		await readBrand($)
		if (config) await checkKit($)
		await update($, project, () => config?.project ?? null)
		// #679: the layout last chosen. Opened unasked, the pane waits for 144
		// columns (110 once asked): the band stands in meanwhile.
		const saved = await $.store.get('layout').catch(() => null)
		const mineSaved = await $.store.get('mine').catch(() => null)
		await update($, isMine, () => mineSaved === true)
		await update($, layout, () => saved === 'pane' ? 'pane' : 'band')
		if (config && saved === 'pane') void $.ui.open({ id: PANE, title: 'Floatee' }).catch(() => undefined)
		if (config) {
			await refresh($)
			$.clock.every(WATCH_MS, async () => {
				const at = await $.clock.now().catch(() => lastRefresh)
				const watching = (await read($, active) !== null || (await read($, watch)).isOn) && !await read($, isBusy)
				if (watching || at - lastRefresh >= REFRESH_MS - 1000) await refresh($)
			})
		}
		return next(e)
	})

	// #692: a theme switched mid-session recolors the band (a write redraws it).
	on('config.set', { key: 'theme' }, async ($, e, next) => {
		const result = await next(e)
		await readBrand($)
		await update($, folds, f => ({ ...f }))
		return result
	})

	// Leaving (exit, /clear, resume) with a ticket still open: back to the queue.
	on('session.end', async ($, e, next) => {
		await release($, 'end', false).catch(() => undefined)
		return next(e)
	})

	on('turn.start', async ($, e, next) => {
		await update($, isBusy, () => true)
		await update($, turnId, () => e.turnId)
		return next(e)
	})

	on('turn.complete', async ($, e, next) => {
		// A subagent's turn ends inside the main one: nothing to do.
		if ((e as { agentId?: string }).agentId) return next(e)
		await update($, isBusy, () => false)
		await update($, asked, () => 0)
		await update($, turnId, () => null)
		await update($, launched, () => null)
		// The end of a watcher's run: counted, maybe stopped (F9).
		const w = await read($, watch)
		if (w.isOn && w.inTurn !== null) {
			const { watch: after, stop: why } = afterRun(w, { max: config?.watchMax ?? null, failures: config?.watchFailures ?? 2 }, await read($, active))
			await update($, watch, () => after)
			if (why) $.ui.toast(`Watch stopped: ${why}`, TOAST)
		}
		// Awaited: the watcher's next run starts from this refresh.
		await refresh($).catch(() => undefined)
		return next(e)
	})

	// F8: the ticket in progress, last in the system prompt.
	on('prompt.compose', async ($, e, next) => {
		const composed = await next(e)
		const t = await read($, ticket)
		if (!t) return composed
		return { sections: [...composed.sections, { id: 'floatee:ticket', text: t.text, scope: 'session' as const }] }
	})

	// Before the main conversation compacts, reload the ticket: the prompt is
	// rebuilt then anyway, so fresh boxes and comments cost no cache.
	on('session.compact', async ($, e, next) => {
		if (!e.agentId) await loadTicket($).catch(() => undefined)
		return next(e)
	})

	// G4's "the user spoke": a prompt typed at the terminal or sent from a phone,
	// not one the band (or another plugin) submitted.
	on('prompt.submit', async ($, e, next) => {
		const human = e.origin?.kind === 'composer' || e.origin?.kind === 'bridge'
		if (human && await read($, active) !== null) await update($, heard, () => true)
		return next(e)
	})

	// The guards (guards.ts), on every tool call, the subagents' included.
	on('tool.call', async ($, e, next) => {
		const command = e.tool === 'Bash' ? e.command : ''
		const no = refusal(e as never, {
			config,
			active: await read($, active),
			verified: await read($, verified),
			heard: await read($, heard),
			bodyFile: command ? await bodyFile($, command) : '',
		})
		if (no) return { deny: `floatee: ${no}` }

		const isDialog = DIALOG_TOOLS.includes(e.tool)
		if (isDialog) await update($, asked, n => n + 1)
		let ran: Awaited<ReturnType<typeof next>>
		try { ran = await next(e) } finally { if (isDialog) await update($, asked, n => Math.max(0, n - 1)) }
		if (ran.deny !== undefined) return ran
		if (command && !ran.isError) await track($, command, ran.text ?? '')

		// G1b: a token in the output is masked. Our own answer (no `ref`), so
		// core maps the masked record instead of reusing its messages.
		TOKEN_RE.lastIndex = 0
		if (!TOKEN_RE.test((ran.text ?? '') + JSON.stringify(ran.result ?? ''))) return ran
		if (ran.isError) return { isError: true, result: mask(ran.result), text: mask(ran.text ?? '') as string }
		return { result: mask(ran.result) as typeof ran.result, ...(ran.context ? { context: ran.context } : {}) }
	})

	on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
		if (e.props.hasSurvey) return next(e)
		// The pane shows the list: the band leaves the engine its place. A pane
		// still waiting for room (opened unasked below 144 columns) leaves the band.
		if (await read($, layout) === 'pane' && (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)) return next(e)
		const below = await next(e)
		const others = isBlank(below) ? null : below
		const maxRows = Math.max(0, e.props.maxRows - (others ? rowsOf(others) : 0))
		const tree = await draw($, e, { isPane: false, busy: e.props.isWorking, maxRows, bodyColumns: e.props.bodyColumns })
		if (!tree || !others) return tree ?? below
		const { Box } = $.ui.resolve(e)
		return <Box flexDirection="column">{others}{tree}</Box>
	})

	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
		const tree = await draw($, e, { isPane: true, busy: await read($, isBusy), maxRows: e.props.scroll.bodyRows, bodyColumns: e.props.bodyColumns })
		const { Text } = $.ui.resolve(e)
		return tree ?? <Text dimColor>No .floatee here: nothing to list.</Text>
	})

	// Closed by hand: back to the band, remembered.
	on('ui.close', async ($, e, next) => {
		if (e.id === PANE && e.origin.kind === 'person') await saveLayout($, 'band')
		return next(e)
	})
}
