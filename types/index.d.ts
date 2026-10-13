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
  /** #750: asleep until then (epoch, s); absent when awake. */
  until?: number
}

/** A task box of a ticket's body: its line in the body, its text, checked or not. */
export type Box = { line: number; text: string; isDone: boolean }

/** #748: an entry of a ticket's activity: a comment (its public id `c3`, its markdown, edited since, whether this token may edit or delete it) or an event (its line, as the site words it; a resolution's note as `body`), or the ticket's opening; who and when (ms). */
export type Entry = { key: number; kind: string; seq: number | null; author: string; at: number; body: string | null; event: string; isEdited: boolean; canEdit: boolean; isWontfix: boolean }

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
      /** #750: the open items asleep (snoozed), apart from the list; the pane lists them. */
      sleepers: Item[]
      /** #679: the pane's sections folded (ideas, notes), by name. */
      folds: Record<string, boolean>
      /** #679: `active` in detail for the pane: the start of its description and its last comment. */
      detail: { id: number; intro: string[]; last: { by: string; text: string } | null } | null
      /** The new-ticket field (#680): open or not, the text typed so far, a create on its way. #751: the type, tags and position chosen in the form, and its tag field (open, text); its assignee and project (null: the defaults, this token and this project), its wake-up (epoch, s), the choice open with its options, and the date field (open, text). */
      draft: { isOpen: boolean; text: string; isSending: boolean; type: 'todo' | 'idea' | 'note'; tags: string[]; position: 'top' | 'bottom'; isTagging: boolean; tagText: string; assignee: { value: string; label: string } | null; project: { value: string; label: string } | null; snooze: number | null; picking: 'assignee' | 'project' | null; choices: Array<{ value: string; label: string }> | null; isSnoozing: boolean; whenText: string }
      /** #747: the ticket whose sheet is open (null: the list), the closing step asking for a text (blocked's why, a resolution note), the text typed, a write on its way, its description (the whole body; null until read). #748: its activity, newest first (null until read), the comment field's text and whether it is open, the comment it edits or asks to delete (cN), a comment on its way, and the whole thread shown in the band. #749: its assignee and project (names), the choice open (assign / move) with its options once read, and the tag field's text and whether it is open. #750: the snooze field open and its text, and a delete asked. #752: the body shown raw for editing, the line in the field (0 = the title) and its text. */
      sheet: { id: number | null; step: 'blocked' | 'done' | 'wontfix' | null; text: string; isSending: boolean; body: string | null; feed: Entry[] | null; reply: string; isComposing: boolean; editing: number | null; deleting: number | null; isPosting: boolean; isAll: boolean; assignee: string | null; project: string | null; picking: 'assignee' | 'project' | null; choices: Array<{ value: string; label: string }> | null; tagText: string; isTagging: boolean; isSnoozing: boolean; whenText: string; isDeleting: boolean; isEditing: boolean; editLine: number | null; lineText: string }
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
