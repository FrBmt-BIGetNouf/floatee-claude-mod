import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ITEMS = [
  { id: 15, title: 'Add export', status: 'pending', type: 'todo', sortOrder: 1 },
  ...[20, 21, 22, 23, 24, 25, 26].map((id, i) => ({ id, title: `Todo ${id}`, status: 'pending', type: 'todo', sortOrder: i + 2 })),
]

const BAND = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const PANE = { title: 'Floatee', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

// A repo with a .floatee, a store, and panes the surface places (`isPlaced`).
function repo(on: On, saved: Record<string, unknown> = {}, isPlaced = true, answer = (_url: string): unknown => ITEMS) {
  const store = { ...saved }
  const panes = new Set<string>()
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.floatee' || e.path.startsWith('/repo/.claude/commands/') }))
  on('fs.read', () => ({ value: 'token=flt_testtoken123\napi=https://example.test/api/v1\nproject=demo\n' }))
  on('http.fetch', (_$, e) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answer(e.url)) } }))
  on('store.get', (_$, e) => ({ value: store[e.key] ?? null }))
  on('store.set', (_$, e) => { store[e.key] = e.value; return { value: undefined } })
  on('ui.open', (_$, e) => { panes.add(e.id); return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'below 144 columns' } } as never })
  on('ui.close', (_$, e) => { panes.delete(e.id); return { value: undefined } as never })
  // The engine's own band, drawn while the pane holds the list.
  on('ui.render', ($t, e) => { const { Box } = $t.ui.resolve(e); return <Box /> })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: 'Floatee', isShown: true, isFocused: false, isPlaced })) }) as never)
  return { store, panes }
}

const text = async (ui: { findAll: (q: object) => Promise<{ text?: string }[]> }) => (await ui.findAll({})).map(el => el.text).join('\n')

test('⇥ Pane moves the list to a pane, every row in it; ⇤ Band brings it back; both remembered', async ($, on) => {
  const { store, panes } = repo(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'fold' })
  expect(await text(band)).toContain('+2 more')

  await band.press({ key: 'layout' })
  expect(panes.has('floatee')).toBe(true)
  expect(store.layout).toBe('pane')
  const pane = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'Pane', requestId: 'floatee', props: PANE })
  // The pane draws every row (no "+N more") and no fold toggle.
  expect(await text(pane)).toContain('#26')
  expect(await text(pane)).not.toContain('more')
  expect(await pane.find({ key: 'fold' })).toBeUndefined()
  // The band leaves its place while the pane shows.
  await band.redraw()
  expect(await band.find({ key: 'layout' })).toBeUndefined()

  await pane.press({ key: 'layout' })
  expect(panes.has('floatee')).toBe(false)
  expect(store.layout).toBe('band')
  await band.redraw()
  expect(await band.find({ key: 'layout' })).toBeDefined()
})

test('the pane chosen last opens with the session; waiting for room, the band stands in', async ($, on) => {
  const { panes } = repo(on, { layout: 'pane' }, false)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(panes.has('floatee')).toBe(true)
  const band = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'layout' })).toBeDefined()
})

test('the pane says more: tags and counts per row, the blocked apart with why, ideas and notes folding', async ($, on) => {
  const rows = [
    { id: 15, title: 'Add export', status: 'pending', type: 'todo', sortOrder: 1, tags: ['web', 'csv'], checklist: { done: 1, total: 3 }, commentCount: 2, updatedAt: 1_000 },
    { id: 17, title: 'Waiting on you', status: 'blocked', type: 'todo', sortOrder: 2, commentCount: 1 },
    { id: 30, title: 'An idea', status: 'pending', type: 'idea', sortOrder: 3, tags: ['later'] },
    { id: 31, title: 'A note', status: 'pending', type: 'note', sortOrder: 4 },
  ]
  const activity = [
    { kind: 'status_change', authorType: 'agent', authorName: 'Bot', meta: { to: 'blocked' }, createdAt: 5 },
    { kind: 'comment', authorType: 'agent', authorName: 'Bot', bodyMd: 'Need the **API key** to go on\nmore', createdAt: 6 },
  ]
  repo(on, { layout: 'pane' }, true, url => (/\/items\/17\?/.test(url) ? { id: 17, bodyMd: 'Waiting on you', activity } : rows))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'Pane', requestId: 'floatee', props: PANE })
  const all = await text(pane)
  expect(all).toContain('+web')
  expect(all).toContain('✓ 1/3')
  expect(all).toContain('2 comments')
  expect(all).toContain('⊝ Blocked (1)')
  expect(all).toContain('why: Need the API key to go on')
  // Ideas and notes start folded, their count in view.
  expect(all).toContain('Ideas (1)')
  expect(all).not.toContain('An idea')
  await pane.press({ key: 'fold-ideas' })
  expect(await text(pane)).toContain('An idea')
  expect(await text(pane)).not.toContain('A note')
})

// #694: in the pane, a row reads as a title line (cut), a tags line, a facts line.
test('pane rows are compact: one cut line each for the title, the tags and the facts', async ($, on) => {
  const long = 'A very long title that would wrap over several lines in a narrow pane'
  const rows = [{ id: 15, title: long, status: 'pending', type: 'todo', sortOrder: 1, tags: ['web', 'csv'], checklist: { done: 1, total: 3 }, commentCount: 2, updatedAt: 1_000 }]
  repo(on, { layout: 'pane' }, true, () => rows)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'Pane', requestId: 'floatee', props: PANE })
  const all = await pane.findAll({})
  expect(all.find(el => el.text === long)?.props.wrap).toBe('truncate-end')
  // One line: the tags on the left, cut; the facts on the right, in order.
  const tags = all.filter(el => el.text === '+web +csv')
  expect(tags.at(-1)?.props.wrap).toBe('truncate-end')
  expect(all.some(el => el.text === '✓ 1/3 · 2 comments')).toBe(true)
  expect(all.some(el => el.text?.startsWith('+web +csv✓ 1/3 · 2 comments'))).toBe(true)
})
