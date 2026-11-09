import { describe, expect, it } from 'vitest'
import { isLetterKey, digitKey, guardComposition, keyCombo } from '../../src/renderer/utils/keys'

describe('shortcuts on every keyboard layout', () => {
  it('match letters by character on Latin layouts, by position on others', () => {
    expect(isLetterKey({ key: 'a', code: 'KeyA' }, 'a')).toBe(true) // QWERTY
    expect(isLetterKey({ key: 'a', code: 'KeyQ' }, 'a')).toBe(true) // AZERTY: A sits where Q is
    expect(isLetterKey({ key: 'q', code: 'KeyA' }, 'a')).toBe(false)
    expect(isLetterKey({ key: 'ф', code: 'KeyA' }, 'a')).toBe(true) // Russian
    expect(isLetterKey({ key: 'Z', code: 'KeyZ' }, 'z')).toBe(true) // with Shift
  })

  it('read digits typed or by the digit key', () => {
    expect(digitKey({ key: '3', code: 'Digit3' })).toBe(3)
    expect(digitKey({ key: '"', code: 'Digit3' })).toBe(3) // AZERTY top row
    expect(digitKey({ key: '٣', code: 'Digit3' })).toBe(3) // Arabic-Indic
    expect(digitKey({ key: 'a', code: 'KeyA' })).toBeNull()
  })
})

describe('recorded shortcuts', () => {
  const mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }
  it('read the same in any layout', () => {
    expect(keyCombo({ ...mods, ctrlKey: true, key: 'f', code: 'KeyF' })).toBe('Ctrl+F')
    expect(keyCombo({ ...mods, ctrlKey: true, key: 'а', code: 'KeyF' })).toBe('Ctrl+F') // Russian
    expect(keyCombo({ ...mods, altKey: true, key: 'π', code: 'KeyP' })).toBe('Alt+P') // Option on a Mac
    expect(keyCombo({ ...mods, key: 'a', code: 'KeyQ' })).toBe('A') // AZERTY keeps the letter
    expect(keyCombo({ ...mods, key: 'é', code: 'Digit2' })).toBe('2')
    expect(keyCombo({ ...mods, key: 'F9', code: 'F9' })).toBe('F9')
    expect(keyCombo({ ...mods, key: ' ', code: 'Space' })).toBe(' ')
    expect(keyCombo({ ...mods, shiftKey: true, key: 'Shift', code: 'ShiftLeft' })).toBe('')
  })
})

describe('typing with an input method', () => {
  it('keeps Enter and Escape from the page while composing', () => {
    const target = new EventTarget() as unknown as Window
    guardComposition(target)
    const seen: string[] = []
    target.addEventListener('keydown', (e) => seen.push((e as KeyboardEvent).key))
    const key = (init: { key: string; isComposing?: boolean; keyCode?: number }) =>
      Object.assign(new Event('keydown'), { isComposing: false, keyCode: 0, ...init })
    target.dispatchEvent(key({ key: 'Enter', isComposing: true }))
    target.dispatchEvent(key({ key: 'Escape', keyCode: 229 }))
    target.dispatchEvent(key({ key: 'a', isComposing: true }))
    target.dispatchEvent(key({ key: 'Enter' }))
    expect(seen).toEqual(['a', 'Enter'])
  })
})
