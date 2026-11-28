import { describe, it, expect } from 'vitest'
import { normaliseThemeId } from '../../src/renderer/utils/theme-id'

describe('normaliseThemeId', () => {
  it('keeps the themes Magnolia offers', () => {
    for (const id of ['magnolia', 'magnolia-dark', 'high-contrast']) expect(normaliseThemeId(id)).toBe(id)
  })

  // 2.0.0's release notes: a light theme that has gone opens in Magnolia,
  // a dark one in Magnolia Dark.
  it('opens a removed dark theme in Magnolia Dark', () => {
    expect(normaliseThemeId('dark')).toBe('magnolia-dark')
    expect(normaliseThemeId('some-old-theme-dark')).toBe('magnolia-dark')
  })

  it('opens a removed light theme, or nothing saved, in Magnolia', () => {
    for (const id of ['', 'some-old-theme', 'darkroom', undefined, null, 42]) expect(normaliseThemeId(id)).toBe('magnolia')
  })
})
