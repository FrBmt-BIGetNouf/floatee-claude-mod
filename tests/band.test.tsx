import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseTicket } from '../hooks/newticket'

const ITEMS = [
  { id: 12, title: '**Fix** the slider', status: 'in_progress', type: 'todo', sortOrder: 1, workspaceSlug: 'acme' },
  { id: 15, title: 'Add \\[x\\] export', status: 'pending', type: 'todo', sortOrder: 2 },
  { id: 16, title: 'An idea', status: 'pending', type: 'idea', sortOrder: 3 },
  { id: 17, title: 'Blocked one', status: 'blocked', type: 'todo', sortOrder: 4 },
  { id: 18, title: 'Second waiting', status: 'pending', type: 'todo', sortOrder: 5 },
]

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }

// A repo with a .floatee, the API answering `rows()`; returns what was posted/ran/toasted.
function repo(on: On, rows: () => unknown[]) {
  // The engine's own band, beneath ours (#688): empty.
  on('ui.render', ($t, e) => { const { Box } = $t.ui.resolve(e); return <Box /> })
  const posts: unknown[] = []
  const ran: string[] = []
  const toasts: string[] = []
  const writes: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo/sub' }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.floatee' || e.path.startsWith('/repo/.claude/commands/') }))
  on('fs.read', () => ({ value: 'token=flt_testtoken123\napi=https://example.test/api/v1\nproject=demo\n' }))
  on('http.fetch', (_$, e) => {
    expect(e.init?.headers?.Authorization).toBe('Bearer flt_testtoken123')
    expect(e.url).toContain('create=0')
    if (e.init?.method && e.init.method !== 'GET') writes.push(`${e.init.method} ${e.url.replace(/^https:\/\/example\.test\/api\/v1/, '').replace(/\?.*/, '')} ${e.init.body ?? ''}`)
    if (e.init?.method === 'PATCH') return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    if (e.init?.method === 'POST') {
      posts.push(JSON.parse(e.init.body ?? '{}'))
      return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(rows()) } }
  })
  on('command.run', (_$, e) => { ran.push(`${e.command} ${e.args}`); return { text: '' } })
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  return { posts, ran, toasts, writes }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band lists the open todos and launches /todo #N (${surface})`, async ($, on) => {
    const { ran } = repo(on, () => ITEMS)
    await $.session.start({ cwd: '/repo/sub', surface, isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'floatee', surface, component: 'AbovePrompt', props: PROPS })
    await ui.press({ key: 'fold' }) // folded at first
    const texts = (await ui.findAll({})).map(el => el.text).join('\n')
    expect(texts).toContain('4 open')
    expect(texts).toContain('Fix the slider')
    expect(texts).toContain('in progress')
    expect(texts).toContain('Add [x] export')
    expect(texts).toContain('blocked')
    expect(texts).not.toContain('An idea')
    expect(texts).not.toContain('flt_')

    // The ticket in progress has no actions; the others do.
    expect(await ui.find({ key: 'run-12' })).toBeUndefined()
    await ui.press({ key: 'run-15' })
    expect(ran).toEqual(['todo #15'])

    // While it is queued, the other Runs are greyed and inert; the brackets
    // are the terminal's (Desktop draws native buttons).
    expect(await ui.find({ key: 'run-15' })).toBeUndefined()
    expect(await ui.find({ key: 'run-18' })).toBeUndefined()
    const greyed = (await ui.findAll({})).map(el => el.text).join('\n')
    if (surface === 'terminal') expect(greyed).toContain('[ ▶ Run ]')
    else expect(greyed).not.toContain('[ ▶')
    expect(ran).toEqual(['todo #15'])
  })
}

test('↑ moves a todo above the previous one in the whole project order', async ($, on) => {
  const { posts } = repo(on, () => ITEMS)
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'fold' })

  // #17 lands just above #15; the idea #16 keeps its place.
  await ui.press({ key: 'up-17' })
  expect(posts).toEqual([{ order: [12, 17, 15, 16, 18], position: 'top' }])
})

test('↓ moves a todo below the next one, and the last row has no ↓', async ($, on) => {
  const { posts } = repo(on, () => ITEMS)
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'fold' })
  expect(await ui.find({ key: 'down-18' })).toBeUndefined()

  // #15 lands just below #17; the idea #16 keeps its place.
  await ui.press({ key: 'down-15' })
  expect(posts).toEqual([{ order: [12, 16, 17, 15, 18], position: 'top' }])
})

test('toasts announce what changed between two refreshes', async ($, on) => {
  let rows = ITEMS.map(i => ({ ...i }))
  const { toasts } = repo(on, () => rows)
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  expect(toasts).toEqual([])

  // #12 closed, #15 claimed, a new todo arrives.
  rows = rows.filter(r => r.id !== 12).map(r => (r.id === 15 ? { ...r, status: 'in_progress' } : r))
  rows.push({ id: 20, title: 'Brand new', status: 'pending', type: 'todo', sortOrder: 6 })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'refresh' })
  expect(toasts).toContain('#15 claimed: Add [x] export')
  expect(toasts).toContain('#12 closed: Fix the slider')
  expect(toasts).toContain('New todo #20: Brand new')
})

test('no .floatee: the band leaves the engine its place', async ($, on) => {
  let engineDrew = false
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/elsewhere' }))
  on('fs.exists', () => ({ value: false }))
  on('ui.render', ($t, e) => { engineDrew = true; const { Box } = $t.ui.resolve(e); return <Box /> })
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'refresh' })).toBeUndefined()
  expect(engineDrew).toBe(true)
})

test('folded at first: one header line with the ticket in progress', async ($, on) => {
  repo(on, () => ITEMS)
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const texts = (await ui.findAll({})).map(el => el.text).join('\n')
  expect(texts).toContain('·#12Fix the slider')
  expect(await ui.find({ key: 'run-15' })).toBeUndefined()
  await ui.press({ key: 'fold' })
  expect(await ui.find({ key: 'run-15' })).toBeDefined()
})

test('no Auto in the band (Watch replaces it); Stop ends the running turn', async ($, on) => {
  const aborted: string[] = []
  const { ran } = repo(on, () => ITEMS.filter(i => i.status !== 'in_progress'))
  on('turn.start', () => ({ turnId: 't9' }))
  on('turn.abort', (_$, e) => { aborted.push(e.turnId); return { value: undefined } })
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  expect(await ui.find({ key: 'auto' })).toBeUndefined()
  await ui.press({ key: 'next' })
  expect(ran).toEqual(['todo '])

  await $.turn.start({ text: '/todo', turnId: 't9' } as never)
  // While the turn runs the engine draws the band with isWorking.
  const working = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, isWorking: true } })
  expect(await working.find({ key: 'next' })).toBeUndefined()
  await working.press({ key: 'stop' })
  expect(aborted).toEqual(['t9'])
})

test('the ticket this session started gets ✓ Close: the press is the user\'s go-ahead', async ($, on) => {
  const { ran } = repo(on, () => ITEMS)
  const prompts: string[] = []
  on('prompt.submit', (_$, e) => { prompts.push(e.text); return { text: e.text } })
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'node floatee.mjs start 12' })

  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  // Folded: [✓] in the header; no Run next / Auto while #12 is open (one at a time).
  expect(await ui.find({ key: 'close-12' })).toBeDefined()
  expect(await ui.find({ key: 'next' })).toBeUndefined()
  await ui.press({ key: 'fold' })
  // The other rows keep a greyed, inert Run.
  expect(await ui.find({ key: 'run-15' })).toBeUndefined()
  expect((await ui.findAll({})).map(el => el.text).join('\n')).toContain('[ ▶ Run ]')
  await ui.press({ key: 'close-12' })
  expect(prompts).toEqual(['#12 is checked: close it.'])

  // The press counts as the user's answer: done goes through unverified.
  const done = await $.tool.call({ tool: 'Bash', command: 'node floatee.mjs done 12 -m x' }) as { deny?: string }
  expect(done.deny).toBeUndefined()
  expect(ran).toEqual([])
})

test('leaving the session puts its ticket back in the queue, and only its own', async ($, on) => {
  const { writes, toasts } = repo(on, () => ITEMS)
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId ?? 's1' }) as never)
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'node floatee.mjs start 12' })
  await $.session.end({ reason: 'prompt_input_exit' } as never)
  expect(writes.sort()).toEqual([
    'PATCH /items/12 {"status":"pending"}',
    expect.stringContaining('POST /items/12/comments {"body_md":"Released by the floatee mod'),
  ].sort())
  expect(toasts).toContain('#12 is back in the queue')
})

test('nothing released when the session started no ticket, or it was closed elsewhere', async ($, on) => {
  let rows = ITEMS
  const { writes } = repo(on, () => rows)
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId ?? 's1' }) as never)
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  // #12 is in progress, but some other agent's: untouched.
  await $.session.end({ reason: 'clear' } as never)
  expect(writes).toEqual([])

  // Ours, then closed in the app before the session ends: untouched too.
  await $.tool.call({ tool: 'Bash', command: 'node floatee.mjs start 15' })
  rows = ITEMS.filter(i => i.id !== 15)
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'refresh' })
  await $.session.end({ reason: 'prompt_input_exit' } as never)
  expect(writes).toEqual([])
})

test('↩ Release puts the ticket back in the queue from the band', async ($, on) => {
  const { writes } = repo(on, () => ITEMS)
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'node floatee.mjs start 12' })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'fold' })
  await ui.press({ key: 'release-12' })
  expect(writes).toContain('PATCH /items/12 {"status":"pending"}')
  // Released: Close is gone, Run is back.
  expect(await ui.find({ key: 'close-12' })).toBeUndefined()
  expect(await ui.find({ key: 'run-15' })).toBeDefined()
})

test('a ticket\'s #id opens its page in the browser', async ($, on) => {
  repo(on, () => ITEMS)
  const ran: string[][] = []
  mock.env(on, { WSL_DISTRO_NAME: 'Ubuntu' })
  on('process.run', (_$, e) => { ran.push([...e.argv]); return { value: { exitCode: 1, stdout: '', stderr: '' } } as never })
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  // Folded: the ticket in progress, in the header; no URL spelled out.
  expect((await ui.findAll({})).map(el => el.text).join('\n')).not.toContain('https://')
  await ui.press({ key: 'open-12' })
  expect(ran).toEqual([['explorer.exe', 'https://example.test/i/acme/12']])
  // Only #12 knows its workspace here: the others stay plain text.
  await ui.press({ key: 'fold' })
  expect(await ui.find({ key: 'open-12' })).toBeDefined()
  expect(await ui.find({ key: 'open-15' })).toBeUndefined()
})

test('✎ New: the band turns into a field; Enter creates the ticket, Cancel leaves', async ($, on) => {
  const { posts, toasts } = repo(on, () => ITEMS)
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  // New sits on the unfolded band's second line.
  await ui.press({ key: 'fold' })
  await ui.press({ key: 'new' })
  // Only the field and its buttons: no list, no launcher.
  expect(await ui.find({ key: 'new-ticket' })).toBeDefined()
  expect(await ui.find({ key: 'refresh' })).toBeUndefined()
  expect((await ui.findAll({})).map(el => el.text).join('\n')).not.toContain('Add [x] export')

  await ui.input({ key: 'new-ticket', text: 'Fix the login +auth !idea\nIt fails on Safari.', kind: 'submit' })
  expect(posts).toEqual([{ body_md: 'Fix the login\nIt fails on Safari.', type: 'idea', tags: ['auth'], position: 'top' }])
  expect(toasts.some(t => t.startsWith('Created #'))).toBe(true)
  expect(await ui.find({ key: 'new-ticket' })).toBeUndefined()

  // Cancel: back to the band, nothing sent.
  await ui.press({ key: 'new' })
  await ui.input({ key: 'new-ticket', text: 'never mind', kind: 'change' })
  await ui.press({ key: 'new-cancel' })
  expect(posts).toHaveLength(1)
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
})

test('parseTicket: title + body, tokens taken out, nothing when only tokens', () => {
  expect(parseTicket('Title +a +a +B !note\n\n- [ ] box')).toEqual({ body: 'Title\n\n- [ ] box', type: 'note', tags: ['a', 'b'] })
  expect(parseTicket('C++ and a+b stay')).toEqual({ body: 'C++ and a+b stay', type: 'todo', tags: [] })
  expect(parseTicket('  +tag  ')).toBeNull()
})

test('▷ Guided runs the ticket through /todo-guided, greyed while another is queued', async ($, on) => {
  const { ran } = repo(on, () => ITEMS)
  await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'fold' })
  await ui.press({ key: 'guided-15' })
  expect(ran).toEqual(['todo-guided #15'])
  expect(await ui.find({ key: 'guided-18' })).toBeUndefined()
  expect((await ui.findAll({})).map(el => el.text).join('\n')).toContain('[ ▷ Guided ]')
})

// #692: Floatee's yellow, not the theme's orange `warning`; deeper on a light theme.
for (const [theme, color] of [['dark', 'rgb(252,229,136)'], ['light', 'rgb(154,114,0)'], ['light-daltonized', 'rgb(154,114,0)']] as const) {
  test(`the brand draws in Floatee's yellow (${theme} theme)`, async ($, on) => {
    repo(on, () => ITEMS)
    on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: theme, provider: { kind: 'engine' }, isLocked: false }] }))
    await $.session.start({ cwd: '/repo/sub', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    const title = (await ui.findAll({})).find(el => el.text === '⨳ Floatee')
    expect(title?.props.color).toBe(color)
  })
}
