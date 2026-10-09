// F8: the ticket this session works on, as a section of the system prompt, so
// the agent keeps it after a /compact or a long turn. Pure: the caller fetches
// the item (GET /items/:id?format=json) and hands it here.
import { mask } from './guards'

type Activity = { kind: string; bodyMd: string | null; authorName: string | null; authorType: string }
export type ApiItem = { id: number; title: string; status: string; bodyMd: string; activity?: Activity[] }

const MAX_BOXES = 15
const MAX_COMMENTS = 3
const MAX_COMMENT = 500
const MAX_TEXT = 4000

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// Kept stable between a claim and a close (it sits in the prompt's cached
// part): no timestamps, no counts that move on their own.
export function ticketContext(item: ApiItem): string {
	const open = item.bodyMd.split('\n').filter(l => /^\s*[-*]\s+\[ \]/.test(l)).map(l => l.trim())
	const comments = (item.activity ?? []).filter(a => a.kind === 'comment' && a.bodyMd).slice(-MAX_COMMENTS)
	const lines = [
		'# Floatee: the ticket in progress',
		`This session is working on Floatee ticket #${item.id} "${item.title}" (claimed here; status when loaded: ${item.status}). Keep to it; \`floatee get ${item.id}\` shows its current state, and it ends with \`floatee done\`, \`block\` or \`wontfix\` (after the user's go-ahead or a passing check).`,
	]
	if (open.length) {
		lines.push('', 'Unchecked items when loaded:')
		lines.push(...open.slice(0, MAX_BOXES))
		if (open.length > MAX_BOXES) lines.push(`(+${open.length - MAX_BOXES} more)`)
	}
	if (comments.length) {
		lines.push('', 'Latest comments:')
		for (const c of comments) lines.push(`- ${c.authorName ?? c.authorType}: ${clip((c.bodyMd ?? '').replace(/\s+/g, ' ').trim(), MAX_COMMENT)}`)
	}
	return clip(mask(lines.join('\n')) as string, MAX_TEXT)
}
