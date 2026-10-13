// #680: a ticket typed in the band's field — the first line its title, the rest
// its body (Alt+Enter for a new line). A reduced quick-add, as the app's:
// `+tag` and `!todo` / `!idea` / `!note` anywhere, taken out of the text. Pure.

export type NewTicket = { body: string; type: 'todo' | 'idea' | 'note'; tags: string[] }

const TOKEN_RE = /(^|[ \t])(\+[^\s+]+|!(?:todo|idea|note))(?=\s|$)/gi

// null when nothing but tokens and blanks was typed.
export function parseTicket(text: string): NewTicket | null {
	const tags: string[] = []
	let type: NewTicket['type'] = 'todo'
	const body = text
		.replace(TOKEN_RE, (_m, lead: string, tok: string) => {
			if (tok[0] === '+') { const t = tok.slice(1).toLowerCase(); if (!tags.includes(t)) tags.push(t) } else type = tok.slice(1).toLowerCase() as NewTicket['type']
			return lead
		})
		.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n')
		.replace(/^\s*\n/, '').trim()
	return body ? { body, type, tags } : null
}

// #751: whether the text names its type (`!idea`…), which then wins over the
// form's buttons.
export function namesType(text: string): boolean {
	return /(^|[ \t])!(?:todo|idea|note)(?=\s|$)/i.test(text)
}

// #751: a `+tag` taken out of the text (its ✕ in the form's tags).
export function dropTag(text: string, tag: string): string {
	return text.replace(/(^|[ \t])\+([^\s+]+)(?=\s|$)/g, (m, lead: string, t: string) => (t.toLowerCase() === tag ? lead : m))
}
