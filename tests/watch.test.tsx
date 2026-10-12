import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { afterRun, WATCH_OFF } from '../hooks/watch'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }

// A queue of pending todos (`api.queue`); `claim` hands out the first, `start N`
// puts N in progress, as the API does.
function repo(on: On, extra = '') {
  // The engine's own band, beneath ours (#688): empty.
  on('ui.render', ($t, e) => { const { Box } = $t.ui.resolve(e); return <Box /> })
	const api = { queue: [15, 18] as number[], started: null as number | null, ran: [] as string[], toasts: [] as string[] }
	on('session.start', (_$, e) => ({ cwd: e.cwd }))
	on('session.cwd', () => ({ value: '/repo' }))
	on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.floatee' || e.path.startsWith('/repo/.claude/commands/') }))
	on('fs.read', () => ({ value: `token=flt_testtoken123\napi=https://example.test/api/v1\nproject=demo\n${extra}` }))
	on('http.fetch', () => {
		const list = api.queue.map((id, i) => ({ id, title: `Todo ${id}`, status: id === api.started ? 'in_progress' : 'pending', type: 'todo', sortOrder: i }))
		return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(list) } }
	})
	on('tool.call', (_$, e) => {
		const command = (e as { command?: string }).command ?? ''
		const start = command.match(/start (\d+)/)
		if (start) api.started = Number(start[1])
		const out = /claim/.test(command) && api.queue[0] ? `# [#${api.queue[0]}] Todo` : 'ok'
		return { result: { stdout: out, stderr: '', interrupted: false } } as never
	})
	on('command.run', (_$, e) => { api.ran.push(`${e.command} ${e.args}`.trim()); return { text: '' } })
	on('ui.toast', (_$, e) => { api.toasts.push(e.text); return { value: undefined } })
	on('turn.start', (_$, e) => ({ turnId: (e as { turnId?: string }).turnId ?? 't' }) as never)
	on('turn.complete', () => ({ text: '' }))
	return api
}

// One run of the agent: a turn that claims, maybe gets it done.
async function run($: Engine, api: { queue: number[] }, isDone: boolean) {
	await $.turn.start({ text: '/todo-auto', turnId: 't' } as never)
	const id = api.queue[0]
	// (A test's tool result carries no text for the claim's heading: start N.)
	await $.tool.call({ tool: 'Bash', command: `node floatee.mjs start ${id}` })
	if (isDone) {
		await $.tool.call({ tool: 'Bash', command: 'npm test' })
		await $.tool.call({ tool: 'Bash', command: `node floatee.mjs done ${id} -m ok` })
		api.queue.shift()
	} else {
		await $.tool.call({ tool: 'Bash', command: `node floatee.mjs block ${id} -m why` })
		api.queue.shift()
	}
	await $.turn.complete({ reason: 'answer', turnId: 't' } as never)
}

test('afterRun: counts, and stops at the limits or on a ticket left open', () => {
	const limits = { max: 3, failures: 2 }
	expect(afterRun({ ...WATCH_OFF, isOn: true, done: 1, inTurn: 1 }, limits, null).stop).toBeNull()
	expect(afterRun({ ...WATCH_OFF, isOn: true, done: 3, inTurn: 1 }, limits, null).watch.isOn).toBe(false)
	expect(afterRun({ ...WATCH_OFF, isOn: true, failures: 1, inTurn: 0 }, limits, null).stop).toContain('2 runs in a row')
	expect(afterRun({ ...WATCH_OFF, isOn: true, inTurn: 1 }, limits, 15).stop).toBe('#15 was left in progress')
	expect(afterRun({ ...WATCH_OFF, isOn: true, done: 500, inTurn: 1 }, { ...limits, max: null }, null).stop).toBeNull()
})

test('Watch runs one todo per run, as they come, while Claude is idle', async ($, on) => {
	const api = repo(on)
	await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
	const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
	await ui.press({ key: 'fold' })
	await ui.press({ key: 'watch' })
	expect(api.ran).toHaveLength(1)
	expect(api.ran[0]).toMatch(/^todo-auto once: process ONE todo/)

	await run($, api, true)
	// Done, one left: the next run starts by itself.
	expect(api.ran).toHaveLength(2)
	// No watch_max: no limit, the count alone.
	expect((await ui.findAll({})).map(el => el.text).join('\n')).toContain('◉ Watching 1')
	expect((await ui.findAll({})).map(el => el.text).join('\n')).not.toContain('◉ Watching 1/')
	await run($, api, true)
	// The queue is empty: it waits.
	expect(api.ran).toHaveLength(2)
	api.queue.push(20)
	await ui.press({ key: 'refresh' })
	expect(api.ran).toHaveLength(3)
})

test('Watch stops after runs that close nothing, and after watch_max todos', async ($, on) => {
	const api = repo(on, 'watch_max=1\nwatch_failures=2\n')
	api.queue = [15, 18, 19, 21]
	await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
	const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
	await ui.press({ key: 'fold' })
	await ui.press({ key: 'watch' })
	await run($, api, false)
	await run($, api, false)
	expect(api.toasts).toContain('Watch stopped: 2 runs in a row closed nothing (watch_failures=2)')
	expect(api.ran).toHaveLength(2)

	await ui.press({ key: 'watch' })
	await run($, api, true)
	expect(api.toasts).toContain('Watch stopped: 1 todos done (watch_max=1)')
	expect(api.ran).toHaveLength(3)
})
