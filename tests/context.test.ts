import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const TOKEN = `flt_${'b'.repeat(43)}`
const LEAKED = `flt_${'c'.repeat(43)}`

const ITEM = {
	id: 12, title: 'Fix the slider', status: 'in_progress',
	bodyMd: 'Fix the slider\n\n- [x] repro\n- [ ] fix the drag\n- [ ] add a test',
	activity: [
		{ kind: 'status_change', bodyMd: null, authorName: 'Bot', authorType: 'agent' },
		{ kind: 'comment', bodyMd: 'old one', authorName: 'Ann', authorType: 'user' },
		{ kind: 'comment', bodyMd: 'two', authorName: 'Ann', authorType: 'user' },
		{ kind: 'comment', bodyMd: 'three', authorName: 'Bot', authorType: 'agent' },
		{ kind: 'comment', bodyMd: `use the staging key ${LEAKED}`, authorName: 'Ann', authorType: 'user' },
	],
}

function repo(on: On) {
	on('session.start', (_$, e) => ({ cwd: e.cwd }))
	on('session.cwd', () => ({ value: '/repo' }))
	on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.floatee' || e.path.startsWith('/repo/.claude/commands/') }))
	on('fs.read', () => ({ value: `token=${TOKEN}\napi=https://example.test/api/v1\nproject=demo\n` }))
	on('http.fetch', (_$, e) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(/\/items\/12\?/.test(e.url) ? ITEM : []) } }))
	on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)
	on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
}

async function section($: Engine) {
	const { sections } = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: ['Bash'], outputStyle: null, traits: [] })
	return sections.find(s => s.id === 'floatee:ticket')
}

test('the ticket this session started rides in the system prompt until it is closed', async ($, on) => {
	repo(on)
	await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
	expect(await section($)).toBeUndefined()

	await $.tool.call({ tool: 'Bash', command: 'node floatee.mjs start 12' })
	const s = await section($)
	expect(s?.scope).toBe('session')
	expect(s?.text).toContain('#12 "Fix the slider"')
	expect(s?.text).toContain('- [ ] fix the drag')
	expect(s?.text).not.toContain('repro')
	// The last three comments, oldest dropped; never a token.
	expect(s?.text).not.toContain('old one')
	expect(s?.text).toContain('Bot: three')
	expect(s?.text).not.toContain(LEAKED)
	expect(s?.text).not.toContain(TOKEN)

	await $.tool.call({ tool: 'Bash', command: 'npm test' })
	await $.tool.call({ tool: 'Bash', command: 'node floatee.mjs done 12 -m ok' })
	expect(await section($)).toBeUndefined()
})
