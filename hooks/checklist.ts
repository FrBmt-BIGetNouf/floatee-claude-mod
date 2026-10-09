// F3: the checklist of the ticket in progress, drawn under its row in the band,
// and the time since it was claimed. Pure: the caller fetches the item and
// writes the body back.

import type { Box } from '../types'

const BOX_RE = /^(\s*[-*+]\s+\[)([ xX])(\]\s?)(.*)$/
const FENCE_RE = /^\s*(```|~~~)/

// Every task box of a markdown body, with its line number (code blocks skipped).
export function boxes(body: string): Box[] {
	const out: Box[] = []
	let inFence = false
	body.split('\n').forEach((l, line) => {
		if (FENCE_RE.test(l)) { inFence = !inFence; return }
		const m = inFence ? null : l.match(BOX_RE)
		if (m) out.push({ line, text: (m[4] ?? '').trim(), isDone: m[2] !== ' ' })
	})
	return out
}

// The body with one box flipped and nothing else touched; null when the line no
// longer holds that box (the body changed since it was drawn).
export function toggle(body: string, box: Box): string | null {
	const lines = body.split('\n')
	const m = lines[box.line]?.match(BOX_RE)
	if (!m || (m[4] ?? '').trim() !== box.text || (m[2] !== ' ') !== box.isDone) return null
	lines[box.line] = `${m[1]}${box.isDone ? ' ' : 'x'}${m[3]}${m[4]}`
	return lines.join('\n')
}

// The boxes drawn, at most `max`: all of them in order when they fit or the
// list is opened, else the unchecked ones only. `more` (unchecked) and
// `checked` count what's left out, for the "+N more · M checked" line.
export function visible(all: Box[], max: number, isOpen = false): { shown: Box[]; more: number; checked: number } {
	const pool = isOpen || all.length <= max ? all : all.filter(b => !b.isDone)
	const shown = pool.slice(0, max)
	const left = all.filter(b => !shown.includes(b))
	return { shown, more: left.filter(b => !b.isDone).length, checked: left.filter(b => b.isDone).length }
}

type Activity = { kind: string; meta?: { to?: string } | null; createdAt?: number }

// When the ticket last went in progress, in ms (the API counts in seconds).
export function claimedAt(activity: Activity[] | undefined): number | null {
	const last = (activity ?? []).filter(a => a.kind === 'status_change' && a.meta?.to === 'in_progress' && a.createdAt).pop()
	return last?.createdAt ? last.createdAt * 1000 : null
}

export function elapsed(ms: number): string {
	const min = Math.max(0, Math.floor(ms / 60_000))
	if (min < 1) return 'just now'
	if (min < 60) return `${min} min`
	const h = Math.floor(min / 60)
	return h < 24 ? `${h} h ${String(min % 60).padStart(2, '0')}` : `${Math.floor(h / 24)} d ${h % 24} h`
}
