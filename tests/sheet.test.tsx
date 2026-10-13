import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { blocks, inline } from '../hooks/markdown'
import { wakeAt } from '../hooks/snooze'

const BAND = { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 100, scroll: { offset: 0, bodyRows: 40 }, view: {} }

// #747: the API as a store: the list from `api.items`, every write recorded
// and applied (a status out of the open ones takes the item off the list).
function repo(on: On) {
  on('ui.render', ($t, e) => { const { Box } = $t.ui.resolve(e); return <Box /> })
  const api = {
    items: [
      { id: 12, title: 'Fix the slider', status: 'pending', type: 'todo', sortOrder: 1, workspaceSlug: 'acme', tags: ['ui', 'bug'] },
      { id: 15, title: 'Add export', status: 'pending', type: 'todo', sortOrder: 2, workspaceSlug: 'acme' },
      { id: 20, title: 'Dark mode', status: 'pending', type: 'idea', sortOrder: 3, workspaceSlug: 'acme' },
    ] as Array<Record<string, unknown>>,
    writes: [] as string[],
    urls: [] as string[],
    prompts: [] as string[],
    commands: [] as string[],
    toasts: [] as string[],
    // #750: snooze is Pro.
    isPro: true,
    // #748: each item's comments, as the API's activity gives them.
    thread: { 12: [
      { kind: 'comment', seq: 1, authorName: 'Ana', authorType: 'user', bodyMd: 'Seen on **Firefox** too.', createdAt: 1, canEdit: false },
      { kind: 'status_change', seq: null, authorName: 'bot', authorType: 'agent', bodyMd: null, meta: { from: 'pending', to: 'in_progress' }, createdAt: 2 },
      { kind: 'comment', seq: 2, authorName: 'bot', authorType: 'agent', bodyMd: 'Repro in the test.', createdAt: 3, canEdit: true },
      { kind: 'comment', seq: 3, authorName: 'bot', authorType: 'agent', bodyMd: 'First line\nsecond line', createdAt: 4, canEdit: true },
    ] } as Record<number, Array<Record<string, unknown>>>,
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/repo/.floatee' || e.path.startsWith('/repo/.claude/commands/') }))
  on('fs.read', () => ({ value: 'token=flt_testtoken123\napi=https://example.test/api/v1\nproject=demo\n' }))
  on('http.fetch', (_$, e) => {
    expect(e.url).toContain('create=0')
    api.urls.push(`${e.init?.method ?? 'GET'} ${e.url}`)
    const id = Number(e.url.match(/\/items\/(\d+)/)?.[1] ?? 0)
    const cseq = e.url.match(/\/comments\/c(\d+)/)?.[1]
    if (e.init?.method === 'DELETE' && !e.url.includes('/comments')) {
      api.writes.push(`DELETE #${id}`)
      api.items = api.items.filter(i => i.id !== id)
      return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
    }
    if (e.init?.method === 'PATCH' && !api.isPro && (e.init.body ?? '').includes('"snooze_until":1')) {
      return { value: { status: 403, ok: false, headers: {}, text: '{"error":"plan_requires_snooze","code":"plan_required","detail":"Snooze is a Pro feature."}' } }
    }
    if (e.init?.method === 'DELETE') {
      api.writes.push(`DELETE #${id} c${cseq}`)
      api.thread[id] = (api.thread[id] ?? []).filter(a => a.seq !== Number(cseq))
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    if (e.init?.method === 'PATCH' || e.init?.method === 'POST') {
      api.writes.push(`${e.init.method} ${e.url.includes('/comments') ? `#${id} comment${cseq ? ` c${cseq}` : ''}` : `#${id}`} ${e.init.body}`)
      const sent = JSON.parse(e.init.body ?? '{}') as Record<string, unknown>
      if (e.url.includes('/comments')) {
        const all = api.thread[id] ?? []
        api.thread[id] = cseq
          ? all.map(a => (a.seq === Number(cseq) ? { ...a, bodyMd: sent.body_md, meta: { editedAt: 9 } } : a))
          : [...all, { kind: 'comment', seq: all.length + 1, authorName: 'bot', authorType: 'agent', bodyMd: sent.body_md, createdAt: 5, canEdit: true }]
        return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
      }
      if (e.init.method === 'PATCH') api.items = api.items.map(i => (i.id === id ? { ...i, ...sent, ...(sent.body_md ? { bodyMd: sent.body_md } : {}), ...('snooze_until' in sent ? { snoozeUntil: sent.snooze_until } : {}) } : i))
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    // #749: the project (its assignees, its id) and the reachable projects.
    if (e.url.includes('/projects?')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify([
        { slug: 'demo', name: 'Demo', workspace: { slug: 'acme' } },
        { slug: 'site', name: 'Site', workspace: { slug: 'acme' } },
        { slug: 'old', name: 'Old', archived: true, workspace: { slug: 'acme' } },
        { slug: 'perso', name: 'Perso', workspace: { slug: 'me' } },
      ]) } }
    }
    const slug = e.url.match(/\/project\?project=([^&]+)/)?.[1]
    if (slug) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ id: `p-${slug}`, slug, assignees: [{ handle: 'ana', name: 'Ana', type: 'user' }, { handle: 'laptop', name: 'Laptop', type: 'token' }] }) } }
    }
    const open = api.items.filter(i => ['pending', 'in_progress', 'blocked'].includes(i.status as string))
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(id ? { bodyMd: `${api.items.find(i => i.id === id)?.title}\n\nThe thumb jumps on drag.\n\n- [x] repro\n- [ ] fix`, activity: api.thread[id] ?? [], ...api.items.find(i => i.id === id) } : open) } }
  })
  on('prompt.submit', (_$, e) => { api.prompts.push(e.text); return { text: e.text } })
  on('command.run', (_$, e) => { api.commands.push(`${e.command} ${e.args}`.trim()); return { text: '' } })
  on('ui.toast', (_$, e) => { api.toasts.push(e.text); return { value: undefined } })
  on('env.get', () => ({ value: undefined }))
  // 2026-10-13 10:00 UTC.
  on('clock.now', () => ({ value: 1791885600000 }))
  on('process.run', (_$, e) => { api.commands.push(`open ${e.argv.join(' ')}`); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  return api
}

const text = async (ui: { findAll: (q: object) => Promise<Array<{ text?: string }>> }) => (await ui.findAll({})).map(el => el.text).join('\n')

async function band($: Parameters<Parameters<typeof test>[1]>[0], surface: 'terminal' | 'mobile' = 'terminal') {
  await $.session.start({ cwd: '/repo', surface, isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'floatee', surface, component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'fold' })
  return ui
}

test('⋮ opens a ticket\'s sheet in the list\'s place; ← Back brings the list back', async ($, on) => {
  repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-12' })
  expect(await ui.find({ key: 'refresh' })).toBeUndefined()
  expect(await ui.find({ key: 'sheet-type-todo' })).toBeDefined()
  expect(await ui.find({ key: 'sheet-status-blocked' })).toBeDefined()
  expect(await ui.find({ key: 'sheet-open' })).toBeDefined()
  expect(await text(ui)).toContain('Fix the slider')
  expect(await text(ui)).not.toContain('Add export')
  // Its description under the title, the boxes drawn.
  expect(await text(ui)).toContain('The thumb jumps on drag.')
  expect(await text(ui)).toContain('☑ repro')
  expect(await text(ui)).toContain('☐ fix')
  await ui.press({ key: 'sheet-back' })
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
})

test('a type button changes the type at once', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-15' })
  await ui.press({ key: 'sheet-type-idea' })
  expect(api.writes).toEqual(['PATCH #15 {"type":"idea"}'])
  expect(api.toasts).toContain('#15 is now an idea')
})

test('blocked asks why, and refuses without it; the why is a comment', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-12' })
  await ui.press({ key: 'sheet-status-blocked' })
  expect(await ui.find({ key: 'sheet-note' })).toBeDefined()
  await ui.press({ key: 'sheet-confirm' })
  expect(api.writes).toEqual([])
  expect(api.toasts).toContain('Say why it is blocked first')
  await ui.input({ key: 'sheet-note', text: 'Waiting for the API key', kind: 'submit' })
  expect(api.writes).toEqual(['POST #12 comment {"body_md":"Waiting for the API key"}', 'PATCH #12 {"status":"blocked"}'])
  // Done: the list is back.
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
})

test('done takes an optional note; Verify & close hands it to Claude instead', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-12' })
  await ui.press({ key: 'sheet-status-done' })
  await ui.press({ key: 'sheet-confirm' })
  expect(api.writes).toEqual(['PATCH #12 {"status":"done","resolution_note":null}'])
  expect(await text(ui)).not.toContain('Fix the slider')

  await ui.press({ key: 'more-15' })
  await ui.press({ key: 'sheet-status-done' })
  await ui.input({ key: 'sheet-note', text: 'Shipped in 1.4', kind: 'change' })
  await ui.press({ key: 'sheet-verify' })
  expect(api.writes).toHaveLength(1)
  expect(api.prompts[0]).toContain('Verify #15')
  expect(api.prompts[0]).toContain('with this resolution note: Shipped in 1.4')
})

test('won\'t fix keeps its note; Cancel leaves the step', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-15' })
  await ui.press({ key: 'sheet-status-wontfix' })
  await ui.press({ key: 'sheet-cancel' })
  expect(await ui.find({ key: 'sheet-note' })).toBeUndefined()
  await ui.press({ key: 'sheet-status-wontfix' })
  await ui.input({ key: 'sheet-note', text: 'Out of scope', kind: 'submit' })
  expect(api.writes).toEqual(['PATCH #15 {"status":"wontfix","resolution_note":"Out of scope"}'])
})

test('in progress runs the ticket, as ▶ Run', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-15' })
  await ui.press({ key: 'sheet-status-in_progress' })
  expect(api.commands).toEqual(['todo #15'])
  expect(api.writes).toEqual([])
})

test('back to pending puts a blocked todo back in the queue', async ($, on) => {
  const api = repo(on)
  api.items[0] = { ...api.items[0], status: 'blocked' }
  const ui = await band($)
  await ui.press({ key: 'more-12' })
  await ui.press({ key: 'sheet-status-pending' })
  expect(api.writes).toEqual(['PATCH #12 {"status":"pending"}'])
  expect(api.toasts).toContain('#12 is back in the queue')
})

test('mobile: no field, so no blocked (it needs a why), and done closes at once', async ($, on) => {
  const api = repo(on)
  const ui = await band($, 'mobile')
  await ui.press({ key: 'more-12' })
  expect(await ui.find({ key: 'sheet-status-blocked' })).toBeUndefined()
  await ui.press({ key: 'sheet-type-note' })
  await ui.press({ key: 'sheet-status-done' })
  expect(api.writes).toEqual(['PATCH #12 {"type":"note"}', 'PATCH #12 {"status":"done","resolution_note":null}'])
})

test('markdown: blocks and inline styles', () => {
  expect(inline('a **bold _and_ it** `x*y*` [site](https://x.test) snake_case_name ~~old~~ ![](a.png)')).toEqual([
    { text: 'a ' }, { text: 'bold ', bold: true }, { text: 'and', bold: true, italic: true }, { text: ' it', bold: true },
    { text: ' ' }, { text: 'x*y*', code: true }, { text: ' ' }, { text: 'site', link: true },
    { text: ' snake_case_name ' }, { text: 'old', strike: true }, { text: ' ' }, { text: '🖼 image', italic: true },
  ])
  expect(blocks('## Plan\n\n\n- one\n  1. two\n- [x] done\n> said\n```\n**raw**\n```\n---\n2 * 3 * 4').map(b => b.kind === 'code' ? `code:${b.text}` : b.kind))
    .toEqual(['heading', 'blank', 'item', 'item', 'task', 'quote', 'code:**raw**', 'rule', 'para'])
  expect(inline('2 * 3 * 4')).toEqual([{ text: '2 * 3 * 4' }])
})

test('a box of the description presses as in the band; the description folds', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-15' })
  await ui.press({ key: 'sheet-box-5' })
  expect(api.writes).toEqual(['PATCH #15 {"body_md":"Add export\\n\\nThe thumb jumps on drag.\\n\\n- [x] repro\\n- [x] fix"}'])
  expect(await text(ui)).toContain('☑ fix')
  await ui.press({ key: 'fold-sheet-body' })
  expect(await text(ui)).not.toContain('The thumb jumps on drag.')
  expect(await text(ui)).toContain('Details')
})

test('the activity: newest first, events included, ✎ ✕ on our comments alone', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-12' })
  const all = await text(ui)
  expect(all).toContain('Activity')
  expect(all).toContain('bot · Pending → In progress')
  // Newest first.
  expect(all.indexOf('second line')).toBeLessThan(all.indexOf('Repro in the test.'))
  expect(all.indexOf('Repro in the test.')).toBeLessThan(all.indexOf('Seen on Firefox too.'))
  // The band: the first four, the opening behind ▾ all.
  expect(all).not.toContain('opened')
  await ui.press({ key: 'sheet-all' })
  expect(await text(ui)).toContain('opened')
  expect(await ui.find({ key: 'sheet-edit-1' })).toBeUndefined()
  expect(await ui.find({ key: 'sheet-edit-2' })).toBeDefined()
  // The field behind + Comment, as on the site.
  expect(await ui.find({ key: 'sheet-comment' })).toBeUndefined()
  await ui.press({ key: 'sheet-compose' })
  await ui.input({ key: 'sheet-comment', text: 'Fixed on main', kind: 'submit' })
  expect(api.writes).toEqual(['POST #12 comment {"body_md":"Fixed on main"}'])
  expect(await text(ui)).toContain('Fixed on main')
  expect(await ui.find({ key: 'sheet-comment' })).toBeUndefined()
})

test('a reopened ticket keeps its resolution and note in the feed', async ($, on) => {
  const api = repo(on)
  api.thread[15] = [
    { kind: 'status_change', seq: null, authorName: 'bot', authorType: 'agent', bodyMd: null, meta: { from: 'in_progress', to: 'done', note: 'Shipped in **1.4**' }, createdAt: 1 },
    { kind: 'status_change', seq: null, authorName: 'Ana', authorType: 'user', bodyMd: null, meta: { from: 'done', to: 'pending' }, createdAt: 2 },
  ]
  const ui = await band($)
  await ui.press({ key: 'more-15' })
  const all = await text(ui)
  expect(all).toContain('Ana · Done → Pending')
  expect(all).toContain('✓ Resolution')
  expect(all).toContain('Shipped in 1.4')
  expect(all.indexOf('Done → Pending')).toBeLessThan(all.indexOf('In progress → Done'))
})

test('✎ puts a comment back in the field and saves it; ✕ asks first', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-12' })
  await ui.press({ key: 'sheet-edit-2' })
  expect(await ui.find({ key: 'sheet-reply-cancel' })).toBeDefined()
  await ui.input({ key: 'sheet-comment', text: 'Repro in the e2e test.', kind: 'submit' })
  expect(api.writes).toEqual(['PATCH #12 comment c2 {"body_md":"Repro in the e2e test."}'])
  expect(await text(ui)).toContain('Repro in the e2e test.')
  expect(await text(ui)).toContain('edited')
  // A comment on several lines is fixed on the site.
  await ui.press({ key: 'sheet-edit-3' })
  expect(api.toasts).toContain('c3 runs on several lines: fix it on the site')
  await ui.press({ key: 'sheet-delete-3' })
  expect(api.writes).toHaveLength(1)
  expect(await text(ui)).toContain('Delete c3?')
  await ui.press({ key: 'sheet-delete-confirm' })
  expect(api.writes[1]).toBe('DELETE #12 c3')
  expect(await text(ui)).not.toContain('second line')
})

test('mobile: the thread, no field', async ($, on) => {
  repo(on)
  const ui = await band($, 'mobile')
  await ui.press({ key: 'more-12' })
  expect(await text(ui)).toContain('Repro in the test.')
  expect(await ui.find({ key: 'sheet-comment' })).toBeUndefined()
})

test('tags: ✕ drops one, + tag adds those typed', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-12' })
  await ui.press({ key: 'sheet-tag-bug' })
  expect(api.writes).toEqual(['PATCH #12 {"tags":["ui"]}'])
  await ui.press({ key: 'sheet-tag-add' })
  await ui.input({ key: 'sheet-tag', text: '+mobile, slider ui', kind: 'submit' })
  expect(api.writes[1]).toBe('PATCH #12 {"tags":["ui","mobile","slider"]}')
  expect(await ui.find({ key: 'sheet-tag' })).toBeUndefined()
})

test('assign: me, a member or nobody, from the project\'s assignees', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-12' })
  await ui.press({ key: 'sheet-assignee' })
  expect(await text(ui)).toContain('Laptop (agent)')
  await ui.press({ key: 'sheet-assignee-ana' })
  expect(api.writes).toEqual(['PATCH #12 {"assignee_handle":"ana"}'])
  await ui.press({ key: 'sheet-assignee' })
  await ui.press({ key: 'sheet-assignee-none' })
  expect(api.writes[1]).toBe('PATCH #12 {"assignee_handle":""}')
})

test('move: to another live project of its workspace; the sheet closes', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-12' })
  await ui.press({ key: 'sheet-project' })
  expect(await ui.find({ key: 'sheet-project-site' })).toBeDefined()
  expect(await ui.find({ key: 'sheet-project-demo' })).toBeUndefined()
  expect(await ui.find({ key: 'sheet-project-old' })).toBeUndefined()
  expect(await ui.find({ key: 'sheet-project-perso' })).toBeUndefined()
  await ui.press({ key: 'sheet-project-site' })
  expect(api.writes).toEqual(['PATCH #12 {"project_id":"p-site"}'])
  expect(api.toasts).toContain('#12 moved to Site')
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
})

test('snooze: a short delay puts it to sleep (out of the list, the sheet stays); ☀ wakes it', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-12' })
  await ui.press({ key: 'sheet-snooze-259200' })
  expect(api.writes).toEqual([`PATCH #12 {"snooze_until":${1791885600 + 259200}}`])
  expect(api.toasts.some(t => t.startsWith('#12 sleeps until'))).toBe(true)
  expect(await text(ui)).toContain('💤 until')
  await ui.press({ key: 'sheet-wake' })
  expect(api.writes[1]).toBe('PATCH #12 {"snooze_until":null}')
  expect(await ui.find({ key: 'sheet-snooze-86400' })).toBeDefined()
})

test('snooze to a date typed; a past one or nonsense is refused; Free says the API\'s words', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-15' })
  await ui.press({ key: 'sheet-snooze-date' })
  await ui.input({ key: 'sheet-when', text: '2020-01-01', kind: 'submit' })
  await ui.input({ key: 'sheet-when', text: 'soon', kind: 'submit' })
  expect(api.writes).toEqual([])
  expect(api.toasts).toContain('That time is already past')
  api.isPro = false
  await ui.input({ key: 'sheet-when', text: '2w', kind: 'submit' })
  expect(api.toasts).toContain('#15: Snooze is a Pro feature.')
  api.isPro = true
  await ui.input({ key: 'sheet-when', text: '2w', kind: 'submit' })
  expect(api.writes).toEqual([`PATCH #15 {"snooze_until":${1791885600 + 14 * 86400}}`])
})

test('delete asks first, then the sheet closes', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-15' })
  await ui.press({ key: 'sheet-delete-item' })
  expect(api.writes).toEqual([])
  expect(await text(ui)).toContain('Delete #15?')
  await ui.press({ key: 'sheet-delete-item-confirm' })
  expect(api.writes).toEqual(['DELETE #15'])
  expect(api.toasts).toContain('#15 is deleted')
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  expect(await text(ui)).not.toContain('Add export')
})

test('wakeAt reads delays and local dates as the CLI does', () => {
  const now = Date.UTC(2026, 9, 13, 10, 0)
  expect(wakeAt('3d', now)).toBe(now / 1000 + 3 * 86400)
  expect(wakeAt('12h', now)).toBe(now / 1000 + 12 * 3600)
  expect(wakeAt('2026-11-03T09:00', now)).toBe(new Date(2026, 10, 3, 9, 0).getTime() / 1000)
  expect(wakeAt('yesterday', now)).toEqual({ error: "Can't read \"yesterday\": use 12h, 3d, 2w, 1m, 1y or 2026-09-01[T09:00]" })
})

test('#751: New also assigns, files in another project and puts to sleep', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'new' })
  await ui.press({ key: 'new-project' })
  await ui.press({ key: 'new-project-site' })
  await ui.press({ key: 'new-assignee' })
  await ui.press({ key: 'new-assignee-ana' })
  await ui.press({ key: 'new-snooze-86400' })
  expect(await text(ui)).toContain('💤 until')
  await ui.input({ key: 'new-ticket', text: 'Ship the docs', kind: 'submit' })
  expect(api.urls.find(u => u.startsWith('POST') && u.includes('/items?'))).toContain('project=site')
  expect(api.writes[0]).toBe(`POST #0 {"body_md":"Ship the docs","type":"todo","tags":[],"position":"top","assignee_handle":"ana","snooze_until":${1791885600 + 86400}}`)
  expect(api.toasts.some(t => t.startsWith('Created #') && t.includes('in Site'))).toBe(true)
})

test('#752: ✎ Edit shows the raw lines; a line pressed is a field: Enter saves, + adds after, ✕ deletes', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-15' })
  await ui.press({ key: 'sheet-edit-body' })
  expect(await text(ui)).toContain('- [x] repro')
  // The title is line 0.
  await ui.press({ key: 'sheet-line-0' })
  await ui.input({ key: 'sheet-line', text: 'Add CSV export', kind: 'submit' })
  expect(api.writes).toEqual(['PATCH #15 {"body_md":"Add CSV export\\n\\nThe thumb jumps on drag.\\n\\n- [x] repro\\n- [ ] fix"}'])
  expect(await ui.find({ key: 'sheet-line' })).toBeUndefined()
  // + opens an empty line after; Enter fills it.
  await ui.press({ key: 'sheet-line-5' })
  await ui.press({ key: 'sheet-line-add' })
  await ui.input({ key: 'sheet-line', text: '- [ ] docs', kind: 'submit' })
  expect(api.writes[2]).toBe('PATCH #15 {"body_md":"Add CSV export\\n\\nThe thumb jumps on drag.\\n\\n- [x] repro\\n- [ ] fix\\n- [ ] docs"}')
  // ✕ deletes a line.
  await ui.press({ key: 'sheet-line-2' })
  await ui.press({ key: 'sheet-line-delete' })
  expect(api.writes[3]).toBe('PATCH #15 {"body_md":"Add CSV export\\n\\n\\n- [x] repro\\n- [ ] fix\\n- [ ] docs"}')
  // Done editing: the rendered description again.
  await ui.press({ key: 'sheet-edit-body' })
  expect(await text(ui)).toContain('☐ docs')
})

test('#752: a body changed meanwhile is reloaded, not overwritten; the title cannot go empty', async ($, on) => {
  const api = repo(on)
  const ui = await band($)
  await ui.press({ key: 'more-15' })
  await ui.press({ key: 'sheet-edit-body' })
  await ui.press({ key: 'sheet-line-0' })
  api.items = api.items.map(i => (i.id === 15 ? { ...i, bodyMd: 'Add export\n\nSomeone wrote here.' } : i))
  await ui.input({ key: 'sheet-line', text: 'Mine', kind: 'submit' })
  expect(api.writes).toEqual([])
  expect(api.toasts).toContain('#15 changed meanwhile: reloaded, nothing overwritten')
  expect(await text(ui)).toContain('Someone wrote here.')
  await ui.press({ key: 'sheet-line-0' })
  await ui.input({ key: 'sheet-line', text: '  ', kind: 'submit' })
  expect(api.writes).toEqual([])
  expect(api.toasts).toContain('The first line is the title: it cannot be empty')
})
