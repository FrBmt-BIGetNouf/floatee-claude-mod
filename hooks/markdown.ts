// #747: a ticket's markdown, read into lines the sheet draws with Text styles.
// A line-by-line reading (the bodies agents write keep their own line breaks):
// headings, lists, task boxes, quotes, rules and fenced code; inside a line,
// bold, italic, strikethrough, inline code, links and images.

export type Span = { text: string; bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; link?: boolean }

export type Block =
	| { kind: 'heading'; level: number; spans: Span[] }
	| { kind: 'item'; indent: number; marker: string; spans: Span[] }
	| { kind: 'task'; indent: number; isDone: boolean; spans: Span[] }
	| { kind: 'quote'; spans: Span[] }
	| { kind: 'code'; text: string }
	| { kind: 'rule' }
	| { kind: 'blank' }
	| { kind: 'para'; spans: Span[] }

type Style = Omit<Span, 'text'>

// Paired markers, longest first so `**` wins over `*`.
const PAIRS: Array<[string, keyof Style]> = [['**', 'bold'], ['__', 'bold'], ['~~', 'strike'], ['*', 'italic'], ['_', 'italic']]

export function inline(text: string, style: Style = {}): Span[] {
	const out: Span[] = []
	let plain = ''
	const flush = () => { if (plain) { out.push({ text: plain, ...style }); plain = '' } }
	let i = 0
	while (i < text.length) {
		const rest = text.slice(i)
		// An escaped character stands for itself.
		if (rest[0] === '\\' && rest.length > 1 && /[\\`*_~[\]()#!>-]/.test(rest[1]!)) { plain += rest[1]; i += 2; continue }
		// Inline code: nothing parsed inside.
		const code = rest.match(/^(`+)([\s\S]*?[^`])\1(?!`)/)
		if (code) { flush(); out.push({ text: code[2]!, ...style, code: true }); i += code[0].length; continue }
		// An image: its alt text, marked as such (a terminal draws no image).
		const image = rest.match(/^!\[([^\]]*)\]\(([^)\s]*)[^)]*\)/)
		if (image) { flush(); out.push({ text: `🖼 ${image[1] || 'image'}`, ...style, italic: true }); i += image[0].length; continue }
		// A link: its text, styled as a link (the URL stays on the site).
		const link = rest.match(/^\[([^\]]+)\]\(([^)\s]*)[^)]*\)/)
		if (link) { flush(); out.push(...inline(link[1]!, { ...style, link: true })); i += link[0].length; continue }
		const pair = PAIRS.find(([m]) => rest.startsWith(m))
		if (pair) {
			const [m, key] = pair
			const end = text.indexOf(m, i + m.length)
			// `_` inside a word (snake_case) is no emphasis; nor a marker before a space.
			const isWordy = m[0] === '_' && /\w/.test(text[i - 1] ?? '')
			if (end > i + m.length && !isWordy && !/\s/.test(text[i + m.length]!) && !/\s/.test(text[end - 1]!)) {
				flush()
				out.push(...inline(text.slice(i + m.length, end), { ...style, [key]: true }))
				i = end + m.length
				continue
			}
		}
		plain += rest[0]
		i += 1
	}
	flush()
	return out
}

export function blocks(md: string): Block[] {
	const out: Block[] = []
	let fence: string | null = null
	for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
		const opens = line.match(/^\s*(```+|~~~+)/)
		if (fence !== null) {
			if (opens && opens[1]!.startsWith(fence)) fence = null
			else out.push({ kind: 'code', text: line })
			continue
		}
		if (opens) { fence = opens[1]!; continue }
		if (!line.trim()) { out.push({ kind: 'blank' }); continue }
		const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
		if (heading) { out.push({ kind: 'heading', level: heading[1]!.length, spans: inline(heading[2]!) }); continue }
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ kind: 'rule' }); continue }
		const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s?(.*)$/)
		if (task) { out.push({ kind: 'task', indent: task[1]!.length >> 1, isDone: task[2] !== ' ', spans: inline(task[3]!) }); continue }
		const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
		if (item) {
			const marker = /\d/.test(item[2]!) ? item[2]! : '•'
			out.push({ kind: 'item', indent: item[1]!.length >> 1, marker, spans: inline(item[3]!) })
			continue
		}
		const quote = line.match(/^\s*>\s?(.*)$/)
		if (quote) { out.push({ kind: 'quote', spans: inline(quote[1]!) }); continue }
		out.push({ kind: 'para', spans: inline(line) })
	}
	// Blank lines: one at most in a row, none at the ends.
	return out.filter((b, n, all) => b.kind !== 'blank' || (n > 0 && n < all.length - 1 && all[n - 1]!.kind !== 'blank'))
}
