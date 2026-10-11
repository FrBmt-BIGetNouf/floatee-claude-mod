import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { boxes, elapsed, toggle, visible } from '../hooks/checklist'

const CLAIMED = 1_800_000_000 // seconds, as the API counts
const BODY = 'Fix the slider\n\n- [x] repro\n- [ ] fix the *drag*\n\n```md\n- [ ] not a box\n```\n* [ ] add a test'
const LIST = [
	{ id: 12, title: 'Fix the slider', status: 'in_progress', type: 'todo', sortOrder: 1 },
	{ id: 15, title: 'Other', status: 'pending', type: 'todo', sortOrder: 2 },
]
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 14, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }

// The API: the list, item #12 (its body as `body` says), PATCHes recorded.
function repo(on: On) {
  // The engine's own band, beneath ours (#688): empty.
  on('ui.render', ($t, e) => { const { Box } = $t.ui.resolve(e); return <Box /> })
	const api = { body: BODY, patches: [] as string[], toasts: [] as string[], itemReads: 0 }
	on('session.start', (_$, e) => ({ cwd: e.cwd }))
	on('session.cwd', () => ({ value: '/repo' }))
	on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.floatee' || e.path.startsWith('/repo/.claude/commands/') }))
	on('fs.read', () => ({ value: 'token=flt_testtoken123\napi=https://example.test/api/v1\nproject=demo\n' }))
	on('http.fetch', (_$, e) => {
		expect(e.url).toContain('create=0')
		if (e.init?.method === 'PATCH') {
			const sent = JSON.parse(e.init.body ?? '{}') as { body_md?: string }
			if (sent.body_md !== undefined) { api.patches.push(sent.body_md); api.body = sent.body_md }
			return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
		}
		if (/\/items\/12\?/.test(e.url)) api.itemReads++
		// The list carries each item's body, as the API's does.
		const list = LIST.map(i => (i.id === 12 ? { ...i, bodyMd: api.body } : i))
		const item = { id: 12, title: 'Fix the slider', status: 'in_progress', bodyMd: api.body, activity: [
			{ kind: 'status_change', bodyMd: null, authorName: 'Bot', authorType: 'agent', meta: { from: 'pending', to: 'in_progress' }, createdAt: CLAIMED },
		] }
		return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(/\/items\/12\?/.test(e.url) ? item : list) } }
	})
	on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)
	on('ui.toast', (_$, e) => { api.toasts.push(e.text); return { value: undefined } })
	return api
}

const text = async (ui: { findAll: (q: object) => Promise<Array<{ text?: string }>> }) => (await ui.findAll({})).map(el => el.text).join('\n')

test('boxes: task lines only, code blocks skipped; toggle flips one and keeps the rest', () => {
	const b = boxes(BODY)
	expect(b.map(x => [x.text, x.isDone])).toEqual([['repro', true], ['fix the *drag*', false], ['add a test', false]])
	const flipped = toggle(BODY, b[1]!)
	expect(flipped).toBe(BODY.replace('- [ ] fix the *drag*', '- [x] fix the *drag*'))
	expect(toggle(flipped!, b[1]!)).toBeNull() // drawn unchecked, now checked: stale
	expect(elapsed(30_000)).toBe('just now')
	expect(elapsed(65 * 60_000)).toBe('1h 5m')
	expect(elapsed((27 * 60 + 4) * 60_000)).toBe('1d 3h')
})

test('the session\'s ticket shows its checklist and claim time under its row; a press ticks the body', async ($, on) => {
	const clock = mock.clock(on, { now: (CLAIMED + 12 * 60) * 1000 })
	const api = repo(on)
	await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
	await $.tool.call({ tool: 'Bash', command: 'node floatee.mjs start 12' })
	const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

	// Folded: the checklist folds with the band.
	expect(await ui.find({ key: 'box-12-3' })).toBeUndefined()
	await ui.press({ key: 'fold' })
	expect(await text(ui)).toContain('1/3 done · claimed 12m ago')
	expect(await text(ui)).toContain('☐ fix the *drag*')
	expect(await text(ui)).not.toContain('not a box')

	await ui.press({ key: 'box-12-3' })
	expect(api.patches).toEqual([BODY.replace('- [ ] fix the', '- [x] fix the')])
	expect(await text(ui)).toContain('2/3 done')

	// The time moves on with the refreshes.
	await clock.advance(3 * 60_000)
	await ui.press({ key: 'refresh' })
	expect(await text(ui)).toContain('claimed 15m ago')
})

test('a box changed meanwhile is not overwritten', async ($, on) => {
	const api = repo(on)
	await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
	await $.tool.call({ tool: 'Bash', command: 'node floatee.mjs start 12' })
	const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
	await ui.press({ key: 'fold' })
	api.body = BODY.replace('- [ ] fix the *drag*', '- [ ] fix the drag, rewritten')
	await ui.press({ key: 'box-12-3' })
	expect(api.patches).toEqual([])
	expect(api.toasts).toContain('#12 changed meanwhile: box not updated')
	expect(await text(ui)).toContain('fix the drag, rewritten')
})

test('no checklist for a ticket the session did not start', async ($, on) => {
	repo(on)
	await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
	const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
	await ui.press({ key: 'fold' })
	expect(await text(ui)).not.toContain('done ·')
	expect(await ui.find({ key: 'box-12-3' })).toBeUndefined()
})

test('a box ticked in Floatee shows at the next refresh, from the list alone', async ($, on) => {
	const api = repo(on)
	await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
	await $.tool.call({ tool: 'Bash', command: 'node floatee.mjs start 12' })
	const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
	await ui.press({ key: 'fold' })
	const reads = api.itemReads
	api.body = BODY.replace('* [ ] add a test', '* [x] add a test')
	await ui.press({ key: 'refresh' })
	expect(await text(ui)).toContain('2/3 done')
	expect(api.itemReads).toBe(reads)
})

test('past five boxes, only the unchecked ones are drawn, the rest counted', () => {
	const many = boxes(['- [x] a', '- [ ] b', '- [x] c', '- [ ] d', '- [ ] e', '- [ ] f', '- [ ] g', '- [ ] h', '- [ ] i'].join('\n'))
	const { shown, more, checked } = visible(many, 5)
	expect(shown.map(b => b.text)).toEqual(['b', 'd', 'e', 'f', 'g'])
	expect([more, checked]).toEqual([2, 2])
	expect(visible(many.slice(0, 5), 5).shown.length).toBe(5) // fits: all, in order
	expect(visible(many, 20, true).shown.map(b => b.text).join('')).toBe('abcdefghi') // opened
})

test('▾ all opens the whole checklist in the band, ▴ less folds it back', async ($, on) => {
	const api = repo(on)
	api.body = ['T', '', '- [x] a', '- [ ] b', '- [x] c', '- [ ] d', '- [ ] e', '- [ ] f', '- [ ] g', '- [ ] h', '- [ ] i'].join('\n')
	await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
	await $.tool.call({ tool: 'Bash', command: 'node floatee.mjs start 12' })
	const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, maxRows: 20 } })
	await ui.press({ key: 'fold' })
	expect(await text(ui)).toContain('+2 more · 2 checked')
	expect(await text(ui)).toContain('▾ see all')
	expect(await ui.find({ key: 'box-12-2' })).toBeUndefined() // `a`, checked: hidden
	await ui.press({ key: 'checklist-toggle-12' })
	expect(await ui.find({ key: 'box-12-2' })).toBeDefined()
	expect(await ui.find({ key: 'box-12-10' })).toBeDefined()
	expect(await text(ui)).not.toContain('checked')
	await ui.press({ key: 'checklist-toggle-12' })
	expect(await ui.find({ key: 'box-12-2' })).toBeUndefined()
})

// #693: the session's ticket leads, apart from the queue: its own section
// above Todos in the pane, the first row of the band; gone once released.
test('the ticket in progress leads in a section of its own, out of the Todos', async ($, on) => {
	const many = [
		{ id: 15, title: 'Other', status: 'pending', type: 'todo', sortOrder: 1 },
		{ id: 16, title: 'Third', status: 'pending', type: 'todo', sortOrder: 2 },
		{ id: 12, title: 'Fix the slider', status: 'in_progress', type: 'todo', sortOrder: 3 },
	]
	LIST.splice(0, LIST.length, ...many)
	try {
		repo(on)
		await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
		const band = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
		await band.press({ key: 'fold' })
		// Nothing of ours yet: no section, #12 in the list where it sits.
		let t = await text(band)
		expect(t.indexOf('Other')).toBeLessThan(t.indexOf('Fix the slider'))

		await $.tool.call({ tool: 'Bash', command: 'node floatee.mjs start 12' })
		t = await text(band)
		expect(t.indexOf('Fix the slider')).toBeLessThan(t.indexOf('Other'))
		expect(await band.findAll({ key: 'row-12' })).toHaveLength(1)

		const pane = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'Pane', requestId: 'floatee', props: { title: 'Floatee', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} } })
		t = await text(pane)
		expect(t).toContain('⊛ In progress')
		expect(t).toContain('Todos (2)')
		expect(t.indexOf('⊛ In progress')).toBeLessThan(t.indexOf('Fix the slider'))
		expect(t.indexOf('Fix the slider')).toBeLessThan(t.indexOf('Todos (2)'))
		expect(await pane.findAll({ key: 'row-12' })).toHaveLength(1)
		// The head says it: no "in progress" beside the title in the pane.
		expect((await pane.find({ key: 'row-12' }))?.text).not.toContain('⊛ in progress')
	} finally {
		LIST.splice(0, LIST.length,
			{ id: 12, title: 'Fix the slider', status: 'in_progress', type: 'todo', sortOrder: 1 },
			{ id: 15, title: 'Other', status: 'pending', type: 'todo', sortOrder: 2 })
	}
})
