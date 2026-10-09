import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const TOKEN = `flt_${'a'.repeat(43)}`

// A repo (with a .floatee unless `bare`) whose shell answers `out(command)`.
function repo(on: On, { bare = false, extra = '', out = (_: string): string => 'ok' }: { bare?: boolean; extra?: string; out?: (command: string) => string } = {}) {
	const ran: string[] = []
	on('session.start', (_$, e) => ({ cwd: e.cwd }))
	on('session.cwd', () => ({ value: '/repo' }))
	on('fs.exists', (_$, e) => ({ value: !bare && (e.path === '/repo/.floatee' || e.path.startsWith('/repo/.claude/commands/')) || e.path === '/repo/body.md' }))
	on('fs.read', (_$, e) => ({ value: e.path === '/repo/body.md' ? '# [#15] Title\n- status: in_progress\n\nBody' : `token=${TOKEN}\napi=https://example.test/api/v1\nproject=demo\n${extra}` }))
	on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '[]' } }))
	on('tool.call', (_$, e) => {
		const command = (e as { command?: string }).command ?? ''
		ran.push(command || e.tool)
		const stdout = out(command)
		return { result: { stdout, stderr: '', interrupted: false }, text: stdout } as never
	})
	return ran
}

// What the guard said when it refused (undefined when the call ran), and the
// call's stdout. A test's own $.tool.call gets a refusal as `{ deny }`.
async function sh($: Engine, command: string) {
	const r = await $.tool.call({ tool: 'Bash', command }) as { deny?: string; result?: { stdout?: string } }
	return { no: r.deny, out: r.result?.stdout ?? '' }
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

test('G1: .floatee is never read, an existence test is fine', async ($, on) => {
	const ran = repo(on)
	await start($)
	for (const command of ['cat .floatee', 'grep token ../.floatee', 'head -1 "/repo/.floatee"']) {
		expect((await sh($, command)).no).toContain('keeps `.floatee` out of the conversation')
	}
	const read = await $.tool.call({ tool: 'Read', file_path: '/repo/.floatee' } as never) as { deny?: string }
	expect(read.deny).toContain('keeps `.floatee` out of the conversation')
	expect((await sh($, 'test -f .floatee && echo yes')).no).toBeUndefined()
	expect((await sh($, 'node floatee.mjs ls')).no).toBeUndefined()
	// Prose naming the file is not a read.
	expect((await sh($, 'node floatee.mjs comment 3 -m "Add verify= to .floatee"')).no).toBeUndefined()
	expect((await sh($, "node floatee.mjs add -m - <<'EOF'\nDocument the .floatee keys\nEOF")).no).toBeUndefined()
	expect((await sh($, 'grep -rn "\\.floatee" src')).no).toBeUndefined()
	expect(ran.length).toBe(5)
})

test('G1b: a token in an output is masked, a short look-alike is not', async ($, on) => {
	repo(on, { out: c => (c === 'env' ? `FLOATEE=${TOKEN}\nOTHER=flt_testtoken123` : 'ok') })
	await start($)
	const { out } = await sh($, 'env')
	expect(out).not.toContain(TOKEN)
	expect(out).toContain('FLOATEE=flt_[hidden by the floatee mod]')
	expect(out).toContain('flt_testtoken123')
})

test('G2: no project created by accident', async ($, on) => {
	repo(on, { bare: true })
	await start($)
	expect((await sh($, 'node floatee.mjs claim')).no).toContain('No `.floatee` in this repo')
	expect((await sh($, 'node floatee.mjs projects')).no).toBeUndefined()
})

test('G2: a --project override needs --no-create, a raw API call create=0', async ($, on) => {
	repo(on)
	await start($)
	expect((await sh($, 'floatee ls --project other')).no).toContain('--no-create')
	expect((await sh($, 'floatee ls --project other --no-create')).no).toBeUndefined()
	expect((await sh($, 'curl -s "https://floatee.me/api/v1/next?project=x"')).no).toContain('create=0')
	expect((await sh($, 'curl -s "https://floatee.me/api/v1/next?project=x&create=0"')).no).toBeUndefined()
})

test('G3: the rendering of get is never saved back as a body', async ($, on) => {
	repo(on)
	await start($)
	expect((await sh($, 'node floatee.mjs get 15 | node floatee.mjs edit 15 -m -')).no).toContain('--raw')
	expect((await sh($, 'node floatee.mjs edit 15 -m - < body.md')).no).toContain('--raw')
	expect((await sh($, "node floatee.mjs edit 15 -m '# [#15] Title\n- status: pending\n\nx'")).no).toContain('--raw')
	expect((await sh($, 'node floatee.mjs get 15 --raw | sed s/a/b/ | node floatee.mjs edit 15 -m -')).no).toBeUndefined()
	expect((await sh($, 'node floatee.mjs edit 15 --append -m "- [ ] one more"')).no).toBeUndefined()
})

test('G5: one ticket at a time, until it is closed or released', async ($, on) => {
	repo(on, { out: c => (c.includes('claim') ? '# [#15] Title\n- status: in_progress' : 'ok') })
	await start($)
	await sh($, 'node floatee.mjs claim')
	expect((await sh($, 'node floatee.mjs start 18')).no).toContain('#15 is still in progress')
	expect((await sh($, 'node floatee.mjs claim')).no).toContain('#15 is still in progress')
	expect((await sh($, 'node floatee.mjs start 15')).no).toBeUndefined()
	await sh($, 'node floatee.mjs pending 15')
	expect((await sh($, 'node floatee.mjs start 18')).no).toBeUndefined()
})

test('G4: done needs a passing check (or a repo verify= command)', async ($, on) => {
	repo(on, { extra: 'verify=./scripts/check.sh' })
	await start($)
	await sh($, 'node floatee.mjs start 15')
	expect((await sh($, 'node floatee.mjs done 15 -m "x"')).no).toContain('Nothing verified #15')
	// Closing a ticket this session did not start is the user's call: allowed.
	expect((await sh($, 'node floatee.mjs done 3 -m "x"')).no).toBeUndefined()
	await sh($, './scripts/check.sh')
	expect((await sh($, 'node floatee.mjs done 15 -m "x"')).no).toBeUndefined()

	// The next ticket starts unverified again; npm test verifies it.
	await sh($, 'node floatee.mjs start 16')
	expect((await sh($, 'node floatee.mjs done 16')).no).toBeDefined()
	await sh($, 'npm test')
	expect((await sh($, 'node floatee.mjs done 16')).no).toBeUndefined()
})

test('G4: a prompt the band submits is not the user speaking', async ($, on) => {
	repo(on)
	on('prompt.submit', (_$, e) => ({ text: e.text }))
	await start($)
	await sh($, 'node floatee.mjs start 15')
	// What the band's ▶ Run does: a plugin's prompt, even framed as the user's.
	await $.prompt.submit({ text: 'close it', asUser: true } as never)
	expect((await sh($, 'node floatee.mjs done 15')).no).toBeDefined()
})
