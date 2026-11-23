/**
 * The renderer never uses window.alert, window.confirm or window.prompt.
 * In the app they show nothing: Tauri's dialog plugin replaces them with
 * calls Magnolia's capabilities don't allow, and its confirm() answers
 * with a Promise, which reads as yes — so "Delete this?" went ahead
 * unasked. window.api.showMessage and window.api.askConfirm show native
 * dialogs instead.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : /\.tsx?$/.test(path) ? [path] : []
  })
}

describe('native dialogs', () => {
  it('nothing calls alert, confirm or prompt', () => {
    const offenders = filesUnder(join(__dirname, '../../src/renderer')).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line) && /(?<![\w.$])(window\.)?(alert|confirm|prompt)\s*\(/.test(line))
        .map(({ i }) => `${file}:${i + 1}`)
    )
    expect(offenders).toEqual([])
  })
})
