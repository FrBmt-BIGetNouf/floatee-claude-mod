// #750: when a ticket wakes, from what the sheet's field takes: a delay
// (`12h`, `3d`, `2w`, `1m`, `1y`) or a local date (`2026-09-01`, at midnight;
// `2026-09-01T09:00` or with a space). The CLI's reading (floatee snooze), so
// both agree: an epoch in seconds, never a duration, and never a past one.

const UNIT_SECONDS: Record<string, number> = { h: 3600, d: 86400, w: 7 * 86400, m: 30 * 86400, y: 365 * 86400 }
export const WHEN_SYNTAX = '12h, 3d, 2w, 1m, 1y or 2026-09-01[T09:00]'

// The wake-up epoch (s), or why the text doesn't read as one.
export function wakeAt(text: string, nowMs: number): number | { error: string } {
	const s = text.trim()
	const now = Math.floor(nowMs / 1000)
	const rel = s.match(/^(\d+)\s*([hdwmy])$/i)
	let epoch: number
	if (rel) {
		epoch = now + Math.max(1, parseInt(rel[1]!, 10)) * UNIT_SECONDS[rel[2]!.toLowerCase()]!
	} else {
		const abs = s.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2}):(\d{2}))?$/)
		if (!abs) return { error: `Can't read "${s}": use ${WHEN_SYNTAX}` }
		const dt = new Date(+abs[1]!, +abs[2]! - 1, +abs[3]!, abs[4] ? +abs[4] : 0, abs[5] ? +abs[5] : 0)
		if (isNaN(dt.getTime())) return { error: `"${s}" isn't a date` }
		epoch = Math.floor(dt.getTime() / 1000)
	}
	if (epoch <= now) return { error: 'That time is already past' }
	return epoch
}

// A wake-up as the person reads it: `Thu 16 Oct, 09:00` (the year when not this one).
export function wakeLabel(epoch: number, nowMs: number): string {
	const d = new Date(epoch * 1000)
	const p = (n: number) => String(n).padStart(2, '0')
	const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
	const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
	const year = d.getFullYear() === new Date(nowMs).getFullYear() ? '' : ` ${d.getFullYear()}`
	return `${day} ${d.getDate()} ${month}${year}, ${p(d.getHours())}:${p(d.getMinutes())}`
}
