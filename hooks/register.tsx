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

import type { Box, Item } from '../types'
import { firstLine, reasonOf, replyOf } from './replies'
import { afterRun, WATCH_ARGS, WATCH_OFF } from './watch'
import { parseTicket } from './newticket'
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
const DRAFT_OFF = { isOpen: false, text: '', isSending: false }
const draft = atom({ plugin: 'floatee', key: 'draft' } as const, DRAFT_OFF)
// #679: the list in the band above the prompt, or in a pane (docked beside the
// transcript on a wide fullscreen terminal). Remembered across sessions.
const layout = atom({ plugin: 'floatee', key: 'layout' } as const, 'band')
const PANE = 'floatee'
const others = atom({ plugin: 'floatee', key: 'others' } as const, [])
const folds = atom({ plugin: 'floatee', key: 'folds' } as const, {})
const detail = atom({ plugin: 'floatee', key: 'detail' } as const, null)
// #669: only the tickets assigned to me (this token or its owner), remembered;
// and the end of a rate-limit pause (429), 0 when none.
const isMine = atom({ plugin: 'floatee', key: 'isMine' } as const, false)
const pausedUntil = atom({ plugin: 'floatee', key: 'pausedUntil' } as const, 0)

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
	const url = `${config.api}/items?project=${encodeURIComponent(config.project)}&format=json&limit=200&create=0${mineOnly ? '&assignee=me' : ''}`
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
	let rows: Array<{ id: number; title: string; status: string; type: string; sortOrder: number; bodyMd?: string; commentCount?: number; workspaceSlug?: string; tags?: string[]; checklist?: { done: number; total: number }; updatedAt?: number }>
	try { rows = JSON.parse(res.text) } catch { await fail($, 'unreadable response'); return }
	rows.sort((a, b) => a.sortOrder - b.sortOrder)
	const toItem = (r: typeof rows[number]): Item => ({
		id: r.id, title: plainTitle(r.title), status: r.status as Item['status'], ws: r.workspaceSlug ?? null,
		type: r.type as Item['type'], tags: r.tags ?? [], boxes: r.checklist?.total ? r.checklist : null,
		updatedAt: r.updatedAt ? r.updatedAt * 1000 : null, comments: r.commentCount ?? 0,
	})
	const isOpen = (r: typeof rows[number]) => ['pending', 'in_progress', 'blocked'].includes(r.status)
	const open: Item[] = rows.filter(r => r.type === 'todo' && isOpen(r)).map(toItem)
	if (!rebase) announce($, await read($, items), open)
	rebase = false
	await update($, items, () => open)
	await update($, others, () => rows.filter(r => (r.type === 'idea' || r.type === 'note') && isOpen(r)).map(toItem))
	// A reorder sends the project's whole order: only a full list holds it.
	if (!mineOnly) await update($, order, () => rows.map(r => r.id))
	await update($, error, () => null)
	// #743: our ticket closed or released elsewhere (the web, another
	// terminal): the session lets it go, or the buttons stay off.
	if (await released($, rows)) {
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
	await update($, draft, d => ({ ...d, text, isSending: true }))
	try {
		const res = await $.http.fetch(`${config.api}/items?project=${encodeURIComponent(config.project)}&format=json&create=0`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ body_md: t.body, type: t.type, tags: t.tags, position: 'top' }),
		})
		if (!res.ok) { $.ui.toast(`Could not create the ticket (${res.status})`); await update($, draft, d => ({ ...d, isSending: false })); return }
		const made = JSON.parse(res.text) as { id?: number }
		await update($, draft, () => DRAFT_OFF)
		$.ui.toast(`Created #${made.id ?? '?'}: ${plainTitle(t.body.split('\n')[0] ?? '')}`, TOAST)
		await refresh($)
	} catch {
		$.ui.toast('Could not create the ticket: offline')
		await update($, draft, d => ({ ...d, isSending: false }))
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

type FullItem = ApiItem & { activity?: Array<{ kind: string; bodyMd: string | null; authorName: string | null; authorType: string; meta?: { to?: string } | null; createdAt?: number }> }

// One item, whole (body and activity); throws when the API says no.
async function fetchItem($: EngineInterface, id: number): Promise<FullItem> {
	if (!config) throw new Error('no config')
	const res = await $.http.fetch(`${config.api}/items/${id}?project=${encodeURIComponent(config.project)}&format=json&create=0`, { headers: { Authorization: `Bearer ${config.token}` } })
	if (!res.ok) throw new Error(String(res.status))
	const item = JSON.parse(res.text) as FullItem
	if (typeof item?.bodyMd !== 'string') throw new Error('not an item')
	return item
}

async function setChecklist($: EngineInterface, item: FullItem) {
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
	try {
		const item = await fetchItem($, id)
		const body = toggle(item.bodyMd, box)
		if (body === null) { $.ui.toast(`#${id} changed meanwhile: box not updated`); await setChecklist($, item); return }
		const res = await $.http.fetch(`${config.api}/items/${id}?project=${encodeURIComponent(config.project)}&format=json&create=0`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ body_md: body }),
		})
		if (!res.ok) { $.ui.toast(`Could not update #${id} (${res.status})`); await setChecklist($, item); return }
		await setChecklist($, { ...item, bodyMd: body })
	} catch {
		$.ui.toast(`Could not update #${id}: offline`)
		await loadChecklist($)
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
	// No Input on the mobile app: no field there.
	const Input = 'Input' in elements ? elements.Input : null
	const typed = await read($, draft)
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
				{Input && <Button key="new" label={narrow ? glyph('✎') : '✎ New'} plain={chip2} onPress={() => update($, draft, d => ({ ...d, isOpen: true }))} />}
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
		const text = typed.text
		return (
			<Box flexDirection="column" {...frame} gap={1}>
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
				<Input key="new-ticket" value={text} placeholder="Click here, then type the title…" submitLabel="" autoFocus
					onInput={v => { void update($, draft, d => ({ ...d, text: v })) }}
					onSubmit={v => { void createTicket($, v) }} />
				<Text color="gray" wrap="truncate-end">First line = title · Alt+Enter: new line · +tag · !idea !note · Enter: create</Text>
			</Box>
		)
	}
	if (folded) return <Box {...frame} flexDirection="column">{header}</Box>

	// Frame (2) + header (2 and a blank) + the "+N" line (1) must fit the rows granted.
	// The pane draws every row and the whole checklist: its body scrolls.
	const room = site.isPane ? 10_000 : Math.max(0, site.maxRows - 6)
	// F3: under our row, a line with the progress and the time since the
	// claim, then its boxes. They take rows from the list, never all of them:
	// short of room, the checklist gives way.
	const held = await read($, checklist)
	const card = !problem && mine !== null && held?.id === mine ? held : null
	const ticked = await read($, now)
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
	const watchedNow = await read($, blocked)
	const folded2 = site.isPane ? await read($, folds) : {}
	const kept = site.isPane ? await read($, others) : []
	// Ideas and notes start folded; a press keeps the person's choice.
	const isFolded = (name: string) => folded2[name] ?? true
	// Each section opens on a dim rule across the pane, then its name: the
	// todos, the blocked, the ideas and the notes read apart.
	const rule = '─'.repeat(Math.max(10, site.bodyColumns - 4))
	const sectionHead = (name: string, label: string, count: number | null, color: string, canFold: boolean) => (
		<Box key={`section-${name}`} flexDirection="column" marginTop={1}>
			<Text dimColor wrap="truncate-end">{rule}</Text>
			{canFold
				? <Button key={`fold-${name}`} label={`${isFolded(name) ? '▸' : '▾'} ${label} (${count})`} plain onPress={() => update($, folds, f => ({ ...f, [name]: !(f[name] ?? true) }))} />
				: <Text color={color} bold>{count === null ? label : `${label} (${count})`}</Text>}
		</Box>
	)

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
										<Box>{idOf(item, brand)}</Box>
										<Text wrap="truncate-end">{item.title}</Text>
										{metaOf(item)}
									</Box>
								))}
							</Box>
						)}
					</Box>
				)
			})}
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

		const ran = await next(e)
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
