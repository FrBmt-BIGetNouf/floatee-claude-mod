import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ITEMS = [
  { id: 15, title: 'Add export', status: 'pending', type: 'todo', sortOrder: 1 },
  { id: 18, title: 'Second waiting', status: 'pending', type: 'todo', sortOrder: 2 },
]
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} }

// A repo whose API answers `reply(url)`; returns the URLs asked and the store.
function repo(on: On, reply = (_url: string) => ({ status: 200, text: JSON.stringify(ITEMS), headers: {} as Record<string, string> })) {
  // The engine's own band, beneath ours (#688): empty.
  on('ui.render', ($t, e) => { const { Box } = $t.ui.resolve(e); return <Box /> })
  const urls: string[] = []
  const store: Record<string, unknown> = {}
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.floatee' }))
  on('fs.read', () => ({ value: 'token=flt_testtoken123\napi=https://example.test/api/v1\nproject=demo\n' }))
  on('http.fetch', (_$, e) => {
    urls.push(e.url)
    const r = reply(e.url)
    return { value: { ...r, ok: r.status < 400 } }
  })
  on('store.get', (_$, e) => ({ value: store[e.key] ?? null }))
  on('store.set', (_$, e) => { store[e.key] = e.value; return { value: undefined } })
  return { urls, store }
}

const text = async (ui: { findAll: (q: object) => Promise<{ text?: string }[]> }) => (await ui.findAll({})).map(el => el.text).join('\n')

test('narrow: the labels give way to their glyph', async ($, on) => {
  repo(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 80 } })
  await ui.press({ key: 'fold' })
  const all = await text(ui)
  expect(all).not.toContain('Refresh')
  expect(all).not.toContain('Guided')
  expect(await ui.find({ key: 'run-15' })).toBeDefined()
})

test('◐ Mine lists my tickets only (assignee=me), without arrows, remembered', async ($, on) => {
  const { urls, store } = repo(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'fold' })
  expect(await ui.find({ key: 'down-15' })).toBeDefined()
  await ui.press({ key: 'mine' })
  expect(urls[urls.length - 1]).toContain('assignee=me')
  expect(store.mine).toBe(true)
  expect(await text(ui)).toContain('· mine')
  expect(await ui.find({ key: 'down-15' })).toBeUndefined()
  await ui.press({ key: 'mine' })
  expect(urls[urls.length - 1]).not.toContain('assignee=me')
})

test('a 429 pauses the list as the API says, and says so', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let limited = false
  repo(on, () => (limited ? { status: 429, text: '{}', headers: { 'retry-after': '30' } } : { status: 200, text: JSON.stringify(ITEMS), headers: {} as Record<string, string> }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'fold' })
  limited = true
  await ui.press({ key: 'refresh' })
  expect(await text(ui)).toContain('rate limited')
  // The list stays as it was.
  expect(await text(ui)).toContain('Add export')
})

for (const [status, words] of [[401, 'invalid token: check token= in .floatee'], [404, 'unknown project: check project= in .floatee']] as const) {
  test(`a ${status} says what to check`, async ($, on) => {
    repo(on, () => ({ status, text: '{}', headers: {} }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    expect(await text(ui)).toContain(words)
  })
}

test('Desktop keeps its labels however narrow; folded, the second line is gone', async ($, on) => {
  repo(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 60 } })
  expect(await ui.find({ key: 'watch' })).toBeUndefined()
  await ui.press({ key: 'fold' })
  const all = await text(ui)
  expect(all).toContain('Refresh')
  expect(all).toContain('Guided')
  expect(all).toContain('Watch')
})

test('folded on a wide terminal: full labels; on a narrower one: glyphs', async ($, on) => {
  repo(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const wide = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 140 } })
  expect(await text(wide)).toContain('⟳ Refresh')
  const mid = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 110 } })
  expect(await text(mid)).not.toContain('Refresh')
})

test('#670: a repo without the kit\'s /todo commands is told how to get them', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  repo(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(toasts.some(t => t.includes('/todo, /todo-guided, /todo-auto missing') && t.includes('agent kit'))).toBe(true)
})
