import type { Code } from '../models/types'

/** Every code in a code tree, depth first (each code before its children). */
export function flattenCodes(codes: Code[]): Code[] {
  const result: Code[] = []
  for (const code of codes) {
    result.push(code)
    result.push(...flattenCodes(code.children))
  }
  return result
}

/** As flattenCodes, with each code's depth (0 at the top level), for
 *  indented lists. */
export function flattenCodesWithDepth(codes: Code[], depth = 0): { code: Code; depth: number }[] {
  const result: { code: Code; depth: number }[] = []
  for (const code of codes) {
    result.push({ code, depth })
    result.push(...flattenCodesWithDepth(code.children, depth + 1))
  }
  return result
}
