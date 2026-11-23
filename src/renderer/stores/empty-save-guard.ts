/**
 * Whether an empty project may be saved over its file.
 *
 * The writer refuses to overwrite a project that has documents with one
 * that has none (or with a wholly empty project): that's how a fault that
 * wipes the stores — a reset racing a project load, say — would otherwise
 * destroy the file. But deleting every document yourself is a real edit,
 * and was refused just the same, so it never saved.
 *
 * The faults it guards against wipe the stores wholesale, so that's what
 * this tracks: any bulk reset (a store's clearAll, a load starting) marks
 * the state as untrustworthy until it's known to match the file again — a
 * load has finished, a new project is set up, or a save succeeded. If no
 * bulk reset happened since, an empty project came from the user's own
 * edits and may be saved.
 */
let resetSinceKnownGood = false

/** The stores were reset wholesale (or a load began). */
export function noteBulkReset(): void {
  resetSinceKnownGood = true
}

/** The stores now match the project file. */
export function noteStateMatchesFile(): void {
  resetSinceKnownGood = false
}

/** An empty project here is the user's doing, so saving it is allowed. */
export function emptySaveAllowed(): boolean {
  return !resetSinceKnownGood
}
