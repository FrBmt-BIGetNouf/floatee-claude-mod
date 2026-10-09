// F10: a reply on a blocked ticket — someone (a person, not an agent) commented
// after it was blocked, most likely the answer it waits for. Pure: the caller
// fetches the item's activity.

type Activity = { kind: string; authorType: string; authorName: string | null; bodyMd?: string | null; meta?: { to?: string } | null; createdAt?: number }

export type Reply = { at: number; by: string }

// The latest human comment since the ticket last went blocked; null when none.
export function replyOf(activity: Activity[] | undefined): Reply | null {
	const list = activity ?? []
	let start = -1
	list.forEach((a, i) => { if (a.kind === 'status_change' && a.meta?.to === 'blocked') start = i })
	if (start < 0) return null
	const human = list.slice(start + 1).filter(a => a.kind === 'comment' && a.authorType !== 'agent' && a.authorType !== 'system').pop()
	return human ? { at: human.createdAt ?? 0, by: human.authorName ?? 'someone' } : null
}

// #679: why it was blocked: the agent's comment that came with the block (just
// after the status change), else the last comment before it; its first line.
export function reasonOf(activity: Activity[] | undefined): string | null {
	const list = activity ?? []
	let start = -1
	list.forEach((a, i) => { if (a.kind === 'status_change' && a.meta?.to === 'blocked') start = i })
	if (start < 0) return null
	const isText = (a: Activity) => a.kind === 'comment' && !!a.bodyMd?.trim()
	const said = list.slice(start + 1).find(a => isText(a) && a.authorType === 'agent') ?? list.slice(0, start).filter(isText).pop()
	return said ? firstLine(said.bodyMd ?? '') : null
}

// A comment's first line of text, its markdown marks dropped.
export function firstLine(md: string): string {
	const line = md.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
	return line.replace(/^#+\s*|^[-*>]\s+/, '').replace(/\*\*|__|`/g, '')
}
