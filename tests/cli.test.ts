import { expect, test } from 'claude-code/testing'

import { cliCalls } from '../hooks/guards'

const calls = (command: string) => cliCalls(command).map(c => [c.cmd, c.id])

test('#669: a CLI call inside a heredoc or a quoted text is data, not a call', () => {
  // A script fed by a heredoc: its text runs nothing of ours.
  expect(calls("python3 - <<'EOF'\nrun('node floatee.mjs start 12')\nEOF")).toEqual([])
  // A comment's text that names a call.
  expect(calls('node floatee.mjs comment 5 -m "see node floatee.mjs start 12 later"')).toEqual([['comment', 5]])
  // A heredoc feeding the CLI keeps the call itself.
  expect(calls("node floatee.mjs comment 5 -m - <<'EOF'\nfloatee start 9\nEOF")).toEqual([['comment', 5]])
  // A shell's own command string still runs.
  expect(calls('bash -c "node floatee.mjs start 12"')).toEqual([['start', 12]])
  // Plain calls, chained.
  expect(calls('node floatee.mjs start 12 && npm test')).toEqual([['start', 12]])
})
