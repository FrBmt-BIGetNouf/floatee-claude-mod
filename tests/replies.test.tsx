import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { replyOf } from '../hooks/replies'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const BLOCK = { kind: 'status_change', authorType: 'agent', authorName: 'Bot', meta: { from: 'in_progress', to: 'blocked' }, createdAt: 100 }
const said = (authorType: string, authorName: string, createdAt: number) => ({ kind: 'comment', authorType, authorName, bodyMd: 'x', meta: null, createdAt })

// #17 blocked, its activity as `api.activity` says; the list counts its comments.
function repo(on: On) {
	const api = { activity: [BLOCK] as unknown[], reads: 0, toasts: [] as string[], ran: [] as string[] }
	on('session.start', (_$, e) => ({ cwd: e.cwd }))
	on('session.cwd', () => ({ value: '/repo' }))
	on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.floatee' || e.path.startsWith('/repo/.claude/commands/') }))
	on('fs.read', () => ({ value: 'token=flt_testtoken123\napi=https://example.test/api/v1\nproject=demo\n' }))
	on('http.fetch', (_$, e) => {
		expect(e.url).toContain('create=0')
		const comments = api.activity.filter(a => (a as { kind: string }).kind === 'comment').length
		if (/\/items\/17\?/.test(e.url)) {
			api.reads++
			return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ id: 17, title: 'Blocked one', status: 'blocked', bodyMd: 'Blocked one', activity: api.activity }) } }
		}
		const list = [
			{ id: 15, title: 'Pending', status: 'pending', type: 'todo', sortOrder: 1, commentCount: 0 },
			{ id: 17, title: 'Blocked one', status: 'blocked', type: 'todo', sortOrder: 2, commentCount: comments },
		]
		return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(list) } }
	})
	on('command.run', (_$, e) => { api.ran.push(`${e.command} ${e.args}`); return { text: '' } })
	on('ui.toast', (_$, e) => { api.toasts.push(e.text); return { value: undefined } })
	return api
}

test('replyOf: a person\'s comment after the block, not an agent\'s, not one from before', () => {
	expect(replyOf([said('user', 'Ann', 50), BLOCK] as never)).toBeNull()
	expect(replyOf([BLOCK, said('agent', 'Bot', 120)] as never)).toBeNull()
	expect(replyOf([BLOCK, said('user', 'Ann', 120), said('agent', 'Bot', 130)] as never)).toEqual({ at: 120, by: 'Ann' })
})

test('a reply on a blocked todo is toasted once and offers ↻ Resume', async ($, on) => {
	const api = repo(on)
	await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
	const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
	await ui.press({ key: 'fold' })
	expect(api.reads).toBe(0) // no comment yet: nothing read
	expect(await ui.find({ key: 'resume-17' })).toBeUndefined()

	// An agent's comment: read once, no reply.
	api.activity = [BLOCK, said('agent', 'Bot', 110)]
	await ui.press({ key: 'refresh' })
	await ui.press({ key: 'refresh' })
	expect(api.reads).toBe(1)
	expect(api.toasts).toEqual([])

	// A person answers.
	api.activity = [BLOCK, said('agent', 'Bot', 110), said('user', 'Ann', 120)]
	await ui.press({ key: 'refresh' })
	expect(api.toasts).toEqual(['Reply on #17 from Ann: Blocked one'])
	expect((await ui.findAll({})).map(el => el.text).join('\n')).toContain('✉ replied')
	await ui.press({ key: 'resume-17' })
	expect(api.ran).toEqual(['todo #17'])

	// A reload of the mod (session.start again): not toasted twice.
	await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
	await ui.press({ key: 'refresh' })
	expect(api.toasts).toEqual(['Reply on #17 from Ann: Blocked one'])
})

test('folded, the band names the todos with a reply', async ($, on) => {
	const api = repo(on)
	api.activity = [BLOCK, said('user', 'Ann', 120)]
	await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
	const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
	expect((await ui.findAll({})).map(el => el.text).join('\n')).toContain('✉ #17')
})
