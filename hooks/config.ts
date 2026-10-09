// The repo's `.floatee`, shared by the band and the guards. Read by the mod
// only: the token stays in module memory, never in $.state, a log or a toast.
export type Config = {
	token: string
	api: string
	project: string
	/** The web app, where a ticket's page lives (`web=`; else the API's origin). */
	web: string
	/** Extra verification commands (`verify=a, b`), on top of the defaults. */
	verify: string[]
	/** The watcher's limits (F9): todos done before it stops (null: no limit), runs in a row closing nothing. */
	watchMax: number | null
	watchFailures: number
}

const positive = (v: string | undefined, fallback: number) => {
	const n = Number(v)
	return Number.isInteger(n) && n > 0 ? n : fallback
}

// `key=value` lines, `#` comments — the CLI's own format.
export function parseConfig(text: string): Config | null {
	const kv: Record<string, string> = {}
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^\s*([a-z_]+)\s*=\s*(.*?)\s*$/i)
		if (m && m[1] && !line.trim().startsWith('#')) kv[m[1]] = m[2] ?? ''
	}
	if (!kv.token || !kv.project) return null
	const api = (kv.api || 'https://floatee.me/api/v1').replace(/\/+$/, '')
	return {
		token: kv.token,
		api,
		web: (kv.web || api.replace(/(\/api)?\/v1$/, '')).replace(/\/+$/, ''),
		project: kv.project,
		verify: (kv.verify ?? '').split(',').map(s => s.trim()).filter(Boolean),
		watchMax: kv.watch_max ? positive(kv.watch_max, 0) || null : null,
		watchFailures: positive(kv.watch_failures, 2),
	}
}
