/** What went wrong, in words: an Error's message, or whatever was thrown
 *  (the backend rejects with plain strings). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err)
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return String(err)
}
