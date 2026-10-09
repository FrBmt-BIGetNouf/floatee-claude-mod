// F9: the watcher — the band watches the queue without calling the model and
// starts one autonomous run per todo while Claude is idle. Pure: what to do at
// the end of a run it started, given what that run closed.

export type Watch = { isOn: boolean; done: number; failures: number; inTurn: number | null }
export type Limits = { max: number | null; failures: number }

export const WATCH_OFF: Watch = { isOn: false, done: 0, failures: 0, inTurn: null }

// The run's argument: one todo, then the turn ends (no re-poll, which would
// spend tokens waiting): the band starts the next run when one is there.
export const WATCH_ARGS = 'once: process ONE todo end to end, then end your turn (no waiting, no re-poll); the Floatee band watches the queue and starts the next run'

// After a run the watcher started: counted, and stopped when a limit is met.
// `closed` is how many todos it closed done; `left` the ticket it left open.
export function afterRun(w: Watch, limits: Limits, left: number | null): { watch: Watch; stop: string | null } {
	const closed = w.inTurn ?? 0
	const done = w.done
	const failures = closed > 0 ? 0 : w.failures + 1
	const next = { ...w, failures, inTurn: null }
	if (left !== null) return { watch: { ...next, isOn: false }, stop: `#${left} was left in progress` }
	if (limits.max !== null && done >= limits.max) return { watch: { ...next, isOn: false }, stop: `${done} todos done (watch_max=${limits.max})` }
	if (failures >= limits.failures) return { watch: { ...next, isOn: false }, stop: `${failures} runs in a row closed nothing (watch_failures=${limits.failures})` }
	return { watch: next, stop: null }
}
