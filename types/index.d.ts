export type Item = {
  id: number
  title: string
  status: 'pending' | 'in_progress' | 'blocked'
  /** Its workspace's slug: the ticket's page is `<web>/i/<ws>/<id>`. */
  ws: string | null
  /** For the pane (#679): its type, tags, checklist count, last change (ms) and comment count. */
  type: 'todo' | 'idea' | 'note'
  tags: string[]
  boxes: { done: number; total: number } | null
  updatedAt: number | null
  comments: number
}

/** A task box of a ticket's body: its line in the body, its text, checked or not. */
export type Box = { line: number; text: string; isDone: boolean }

declare module 'claude-code' {
  interface PluginState {
    floatee: {
      /** Open todos of the project (pending, in_progress, blocked), in manual order. */
      items: Item[]
      /** Every open item id of the project (todos, ideas, notes), in manual order: what a reorder sends. */
      order: number[]
      /** Last fetch problem shown in the band, null when fine. */
      error: string | null
      /** A model turn is running. */
      isBusy: boolean
      /** Ticket launched from the band (0 = "next"), until the turn it started completes. */
      launched: number | null
      /** Band folded to its header line (folded at first). */
      isCollapsed: boolean
      /** The ticket's checklist drawn whole (F3), not just its first unchecked boxes. */
      isChecklistOpen: boolean
      /** Blocked todos (F10), by id: the comment count last looked at, the human reply since the block, if any, and (#679) why it was blocked. */
      blocked: Record<string, { comments: number; reply: { at: number; by: string } | null; why?: string | null }>
      /** Replies already announced, by ticket id: the reply's time. Kept across reloads, so a toast is never repeated. */
      notified: Record<string, number>
      /** The watcher (F9): on or off, todos it got done, runs in a row that closed nothing, and the dones of the run it started (null when the running turn isn't its). */
      watch: { isOn: boolean; done: number; failures: number; inTurn: number | null }
      /** #679: the list in the band above the prompt, or in a pane. */
      layout: 'band' | 'pane'
      /** #669: only the tickets assigned to me (this token or its owner). */
      isMine: boolean
      /** #669: when a rate-limit pause (429) ends, in ms; 0 when none. */
      pausedUntil: number
      /** #679: the open ideas and notes, for the pane's sections. */
      others: Item[]
      /** #679: the pane's sections folded (ideas, notes), by name. */
      folds: Record<string, boolean>
      /** #679: `active` in detail for the pane: the start of its description and its last comment. */
      detail: { id: number; intro: string[]; last: { by: string; text: string } | null } | null
      /** The new-ticket field (#680): open or not, the text typed so far, a create on its way. */
      draft: { isOpen: boolean; text: string; isSending: boolean }
      /** The running turn's id, what Stop ends; null between turns. */
      turnId: string | null
      /** Project slug, once a .floatee was found. */
      project: string | null
      /** Ticket this session started (start / claim) and has not closed yet. */
      active: number | null
      /** A verification command passed since `active` was started. */
      verified: boolean
      /** The user typed a prompt since `active` was started. */
      heard: boolean
      /** `active` as the system prompt shows it (F8), loaded at the claim and after a compaction. */
      ticket: { id: number; text: string } | null
      /** `active`'s task boxes and claim time (F3), drawn under its row; refreshed with the band. */
      checklist: { id: number; boxes: Box[]; since: number | null } | null
      /** The time the band last ticked, in ms: what the elapsed time is counted to. */
      now: number
    }
  }
}
