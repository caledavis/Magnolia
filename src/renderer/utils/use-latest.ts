import { useEffect, useRef, type MutableRefObject } from 'react'

/** A ref that always holds `value`'s latest render. For a listener that
 *  must stay subscribed while what it calls changes: subscribing again
 *  leaves a moment with no listener, and a message arriving then is lost. */
export function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  })
  return ref
}
