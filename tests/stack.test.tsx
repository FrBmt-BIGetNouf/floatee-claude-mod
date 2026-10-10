import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ITEMS = Array.from({ length: 5 }, (_, i) => ({ id: 30 + i, title: `Todo ${i}`, status: 'pending', type: 'todo', sortOrder: i }))
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120, scroll: { offset: 0, bodyRows: 30 }, view: {} }

function repo(on: On) {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.floatee' || e.path.startsWith('/repo/.claude/commands/') }))
  on('fs.read', () => ({ value: 'token=flt_testtoken123\napi=https://example.test/api/v1\nproject=demo\n' }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(ITEMS) } }))
}

const texts = async (ui: { findAll: (q: object) => Promise<{ text?: string }[]> }) => (await ui.findAll({})).map(el => el.text ?? '')

// The hooks after ours (another mod's band, or the engine's) draw `lines`.
function below(on: On, lines: string[]) {
  on('ui.render', ($t, e) => {
    const { Box, Text } = $t.ui.resolve(e)
    return <Box flexDirection="column">{lines.map(l => <Text>{l}</Text>)}</Box>
  })
}

test('#688: another mod\'s band stays, drawn above the list', async ($, on) => {
  repo(on)
  below(on, ['Bleh: hello'])
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'fold' })
  const all = (await texts(ui)).join('\n')
  expect(all).toContain('Bleh: hello')
  expect(all.indexOf('Todo 0')).toBeGreaterThan(all.indexOf('Bleh: hello'))
})

test('#688: the engine\'s empty band adds nothing', async ($, on) => {
  repo(on)
  below(on, [])
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'fold' })
  expect((await texts(ui)).some(t => t.includes('Todo 4'))).toBe(true)
})

test('#688: a tall band below leaves the list fewer rows', async ($, on) => {
  repo(on)
  below(on, Array.from({ length: 20 }, (_, i) => `other ${i}`))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'fold' })
  const all = await texts(ui)
  expect(all.some(t => t.includes('other 19'))).toBe(true)
  expect(all.some(t => t.includes('Todo 4'))).toBe(false)
})
