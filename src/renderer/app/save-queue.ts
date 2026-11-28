/**
 * One save at a time. The autosave, Cmd+S, a memo window's Save and the
 * save after an import each collect the project and write it, and none
 * waited for another: an older snapshot whose write happened to finish
 * last left the file without the edits in the newer one. Queued, each
 * save collects the project when its turn comes, so the last to finish is
 * also the newest.
 */
let tail: Promise<unknown> = Promise.resolve()

/** Runs `save` once every save queued before it has finished. */
export function queueSave<T>(save: () => Promise<T>): Promise<T> {
  const run = tail.then(save)
  tail = run.catch(() => undefined)
  return run
}

/** Resolves once every save queued so far has finished. */
export function savesSettled(): Promise<void> {
  return tail.then(() => undefined)
}
