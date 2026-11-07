import { useEffect, useCallback, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import type { FreeTextElement } from './types'
import { FREE_TEXT_DEFAULT_WIDTH, FREE_TEXT_DEFAULT_HEIGHT } from './types'
import { useTranslation } from 'react-i18next'

interface Props {
  freeText: FreeTextElement
  selected: boolean
  focused: boolean
  /** Current canvas zoom. Resize handles need this so screen-pixel
   *  mouse deltas translate to canvas-pixel size changes 1:1 — otherwise
   *  at zoom != 1 the handle drifts away from the cursor. */
  zoom: number
  onMouseDown: (e: React.MouseEvent, id: string) => void
  /** Initiate a wire drag from this freetext (mirror of
   *  MapElement's "body drag → draw wire" behaviour). Wired up to a
   *  small connector handle on the right edge that's visible while
   *  the node is selected but not being edited. */
  onConnectorMouseDown: (e: React.MouseEvent, id: string) => void
  onFocus: () => void
  onUpdate: (content: string) => void
  onEditorReady: (editor: any) => void
  onResize: (id: string, update: { x: number; y: number; width: number; height: number }) => void
}

const HANDLE_SIZE = 8

type HandlePos = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

const HANDLE_CURSORS: Record<HandlePos, string> = {
  n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize', se: 'nwse-resize',
  s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize', nw: 'nwse-resize'
}

const HANDLE_STYLES: Record<HandlePos, React.CSSProperties> = {
  nw: { left: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2 },
  n: { left: '50%', top: -HANDLE_SIZE / 2, transform: 'translateX(-50%)' },
  ne: { right: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2 },
  e: { right: -HANDLE_SIZE / 2, top: '50%', transform: 'translateY(-50%)' },
  se: { right: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2 },
  s: { left: '50%', bottom: -HANDLE_SIZE / 2, transform: 'translateX(-50%)' },
  sw: { left: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2 },
  w: { left: -HANDLE_SIZE / 2, top: '50%', transform: 'translateY(-50%)' }
}

function ResizeHandle({ position, onResizeStart }: {
  position: HandlePos
  onResizeStart: (e: React.MouseEvent, position: HandlePos) => void
}) {
  return (
    <div
      onMouseDown={(e) => {
        e.stopPropagation()
        e.preventDefault()
        onResizeStart(e, position)
      }}
      style={{
        position: 'absolute',
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
        background: '#3b82f6',
        border: '1px solid #fff',
        borderRadius: 2,
        cursor: HANDLE_CURSORS[position],
        zIndex: 10,
        ...HANDLE_STYLES[position]
      }}
    />
  )
}

const ALL_HANDLES: HandlePos[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function FreeTextNode({ freeText, selected, focused, zoom, onMouseDown, onConnectorMouseDown, onFocus, onUpdate, onEditorReady, onResize }: Props) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef<{
    pos: HandlePos
    startW: number
    startH: number
    startElX: number
    startElY: number
    startMouseX: number
    startMouseY: number
  } | null>(null)

  const editor = useEditor({
    extensions: [
      // StarterKit bundles Underline in TipTap v3; importing it
      // separately registers the extension twice and TipTap warned
      // "Duplicate extension names found: ['underline']" — the
      // duplication corrupts the editor state enough that the caret
      // never lands and keystrokes are silently dropped.
      StarterKit,
      Markdown,
      TextAlign.configure({ types: ['heading', 'paragraph'], defaultAlignment: 'center' }),
      TextStyle,
      Color.configure({ types: ['textStyle'] })
    ],
    content: freeText.content || '<p style="text-align: center"></p>',
    // Always-editable: TipTap v3's useEditor preserves the editor's
    // own isEditable state across re-renders (see useEditor.ts:240-243),
    // so toggling editable through props was unreliable and left the
    // caret hidden. Click routing (single click = select/drag, double
    // click = edit) is enforced separately in handleMouseDown.
    //
    // autofocus is honoured when the node mounts already-focused (the
    // text-tool create flow sets focusedFreeTextId synchronously with
    // setFreeTexts, so on mount focused=true). For the
    // double-click-into-an-existing-node path TipTap won't refire
    // autofocus, so the useEffect below handles that case.
    autofocus: focused ? 'start' : false,
    onUpdate: ({ editor }) => {
      onUpdate((editor.storage as any).markdown.getMarkdown())
    },
    editorProps: {
      attributes: {
        // min-height on the editor view itself gives the empty
        // ProseMirror element a real click target — without it,
        // the empty paragraph collapses to one line of caret
        // height (~17 px) and clicks miss the editor entirely.
        style: 'outline: none; background: transparent; caret-color: var(--text-primary, #1d1d1f); min-height: 22px;'
      }
    }
  })

  useEffect(() => {
    if (editor) onEditorReady(editor)
  }, [editor, onEditorReady])

  // Robust focus on `focused` becoming true. Two failure modes we're
  // defending against:
  //   1. EditorContent's componentDidMount moves the editor's view
  //      DOM out of TipTap's temporary off-screen container into the
  //      visible tree. If we try editor.commands.focus() before that
  //      move finishes, ProseMirror has nothing to focus on screen.
  //   2. editor.commands.focus('start') sometimes silently no-ops
  //      when the contentEditable's parent has just changed; calling
  //      DOM .focus() on the view's element first puts the OS-level
  //      focus where ProseMirror expects, then commands.focus()
  //      positions the caret.
  // requestAnimationFrame waits until the next paint, by which point
  // EditorContent's componentDidMount has run. The retry loop covers
  // the rare case where the view DOM hasn't been re-parented yet.
  useEffect(() => {
    if (!editor || !focused) return
    let cancelled = false
    let attempts = 0
    const tryFocus = (): void => {
      if (cancelled || !editor || editor.isDestroyed) return
      const viewDom = editor.view?.dom as HTMLElement | undefined
      if (viewDom && viewDom.isConnected) {
        viewDom.focus({ preventScroll: true })
        editor.commands.focus('start')
        return
      }
      if (attempts++ < 6) requestAnimationFrame(tryFocus)
    }
    requestAnimationFrame(tryFocus)
    return () => { cancelled = true }
  }, [focused, editor])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (focused && (e.target as HTMLElement).closest('.ProseMirror')) return
      onMouseDown(e, freeText.id)
    },
    [focused, onMouseDown, freeText.id]
  )

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, pos: HandlePos) => {
      // In auto-size mode the stored width/height still equal the
      // creation defaults but the rendered box is shrink-wrapped to
      // content. Capture the actual rendered dimensions from the DOM so
      // the first drag doesn't "jump" the box from content-size back up
      // to 200x60 (which is what made the handle feel elastic).
      const node = containerRef.current
      const renderedW = node ? node.offsetWidth : freeText.width
      const renderedH = node ? node.offsetHeight : freeText.height
      resizingRef.current = {
        pos,
        startW: renderedW,
        startH: renderedH,
        startElX: freeText.x,
        startElY: freeText.y,
        startMouseX: e.clientX,
        startMouseY: e.clientY
      }

      // Which edges the handle actually affects. Using set membership
      // instead of substring matches so `n` / `s` handles don't also
      // trigger the horizontal branches (because they appear as
      // substrings of `ne`/`nw`/`se`/`sw`).
      const affectsEast = pos === 'e' || pos === 'ne' || pos === 'se'
      const affectsWest = pos === 'w' || pos === 'nw' || pos === 'sw'
      const affectsNorth = pos === 'n' || pos === 'ne' || pos === 'nw'
      const affectsSouth = pos === 's' || pos === 'se' || pos === 'sw'
      const MIN_W = 80
      const MIN_H = 32

      const handleMove = (me: MouseEvent): void => {
        const r = resizingRef.current
        if (!r) return
        // Screen-pixel delta → canvas-coordinate delta. The node lives
        // inside a pan wrapper that applies scale(zoom), so 100 screen px
        // at zoom=2 should move the box 50 canvas units.
        const scale = zoom || 1
        const dx = (me.clientX - r.startMouseX) / scale
        const dy = (me.clientY - r.startMouseY) / scale

        let newW = r.startW
        let newH = r.startH
        let newX = r.startElX
        let newY = r.startElY

        if (affectsEast) {
          newW = Math.max(MIN_W, r.startW + dx)
        }
        if (affectsWest) {
          newW = Math.max(MIN_W, r.startW - dx)
          // Shift the box's x by however much width actually changed
          // (respecting the min-width clamp).
          newX = r.startElX + (r.startW - newW)
        }
        if (affectsSouth) {
          newH = Math.max(MIN_H, r.startH + dy)
        }
        if (affectsNorth) {
          newH = Math.max(MIN_H, r.startH - dy)
          newY = r.startElY + (r.startH - newH)
        }

        onResize(freeText.id, { x: newX, y: newY, width: newW, height: newH })
      }

      const handleUp = (): void => {
        resizingRef.current = null
        window.removeEventListener('mousemove', handleMove)
        window.removeEventListener('mouseup', handleUp)
      }

      window.addEventListener('mousemove', handleMove)
      window.addEventListener('mouseup', handleUp)
    },
    [freeText.id, freeText.x, freeText.y, freeText.width, freeText.height, onResize, zoom]
  )

  // Show the dashed bounding box whenever the text node is selected OR
  // focused — so the box appears the moment the user clicks the canvas
  // with the text tool (the new node mounts focused, with the caret
  // already blinking). Resize handles stay gated on "selected and not
  // editing" so they don't clutter the active text box while typing.
  const showBoundingBox = selected || focused
  const showHandles = selected && !focused

  // Shrink-wrap when the user hasn't resized the node (width/height still
  // at their creation defaults). After a drag on a resize handle the
  // stored dimensions diverge from the defaults and we honour them
  // verbatim. Result: new text nodes hug their content; resized nodes
  // keep the exact frame the user set.
  const isAuto =
    freeText.width === FREE_TEXT_DEFAULT_WIDTH &&
    freeText.height === FREE_TEXT_DEFAULT_HEIGHT

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onFocus()
      }}
      style={{
        position: 'absolute',
        left: freeText.x,
        top: freeText.y,
        width: isAuto ? 'max-content' : freeText.width,
        // 60 px keeps a freshly-created empty box findable while not
        // padding boxes that already contain shorter text. 420 max
        // remains a soft cap before long content wraps.
        minWidth: isAuto ? 60 : undefined,
        maxWidth: isAuto ? 420 : undefined,
        // Auto-sized boxes get a minHeight so a just-created / empty
        // freetext renders as a visible text frame rather than a
        // single-line slice (~25px). ProseMirror content grows the
        // box as soon as the user types past one line.
        minHeight: isAuto ? 32 : freeText.height,
        background: 'transparent',
        border: showBoundingBox ? '1px dashed #3b82f6' : '1px solid transparent',
        borderRadius: 4,
        cursor: focused ? 'text' : 'grab',
        // Tighter padding around the box than the original 4 px so
        // connection ports land closer to the glyphs, but with a
        // little extra room at the bottom so text doesn't sit flush
        // against the bottom edge / descenders (g, p, y, etc.) read
        // as comfortably-spaced rather than clipped.
        padding: '2px 2px 6px 2px',
        boxShadow: undefined,
        userSelect: focused ? 'auto' : 'none'
      }}
    >
      <style>{`
        .rmap-freetext-editor .tiptap,
        .rmap-freetext-editor .ProseMirror {
          background: transparent !important;
          border: none !important;
          padding: 0 !important;
          margin: 0 !important;
          min-height: 0 !important;
          line-height: 1.2 !important;
          outline: none !important;
        }
        /* Reset every descendant's margin and padding so the shrink-wrap
           box hugs the glyph bounds — browsers apply sizeable default
           vertical margins to headings and paragraphs. */
        .rmap-freetext-editor .tiptap *,
        .rmap-freetext-editor .ProseMirror * {
          margin: 0 !important;
          padding: 0 !important;
        }
        /* ProseMirror's trailing <br class="ProseMirror-trailingBreak">
           is the caret target Chromium needs for the beforeinput
           pipeline. We must NOT hide it when it's the only child of
           a block (empty paragraph) — that re-introduces the
           "typing does nothing on a fresh freetext" bug. But once
           the paragraph has actual content, the break is purely a
           phantom extra line that pads the box's height (and pushes
           connection ports outward). The :not(:only-child) selector
           keeps it visible on empty blocks and hides it on
           non-empty ones. */
        .rmap-freetext-editor br.ProseMirror-trailingBreak:not(:only-child) {
          display: none !important;
        }
      `}</style>
      <EditorContent
        editor={editor}
        className="rmap-freetext-editor"
        style={{
          fontSize: 14,
          color: 'var(--text-primary, #1d1d1f)',
          lineHeight: 1.4,
          outline: 'none',
          background: 'transparent'
        }}
      />
      {!focused && !freeText.content && (
        <div style={{ position: 'absolute', inset: 4, fontSize: 12, color: 'var(--text-muted, #8e8e93)', pointerEvents: 'none' }}>
          {t('map.doubleClickToEdit')}
        </div>
      )}
      {showHandles && ALL_HANDLES.map((pos) => (
        <ResizeHandle key={pos} position={pos} onResizeStart={handleResizeStart} />
      ))}
      {/* Connector handle. Visible when the freetext is selected but
          not being edited (same gate as resize handles, so the active
          text box stays uncluttered while typing). Floats outside the
          right edge so it doesn't overlap content; dragging it
          initiates a wire that the canvas's wire hit-tester resolves
          against any other element or freetext. */}
      {showHandles && (
        <div
          onMouseDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
            onConnectorMouseDown(e, freeText.id)
          }}
          title={t('map.dragToConnect')}
          aria-label={t('map.dragToConnectLabel')}
          style={{
            position: 'absolute',
            right: -16,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: '#3b82f6',
            border: '2px solid #fff',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.15)',
            cursor: 'crosshair',
            zIndex: 10
          }}
        />
      )}
    </div>
  )
}
