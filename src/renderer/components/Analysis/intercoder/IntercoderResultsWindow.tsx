/**
 * The Inter-coder Agreement results popped out into a window of their
 * own (to put them on a bigger screen, say). The tool sends everything
 * shown here (IntercoderResultsData) and keeps it up to date; what the
 * user does here is sent back to the tool, which stays the one place the
 * analysis lives. Closing the window, or Pop back in, returns the
 * results to the tool.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, faDownLeftAndUpRightToCenter } from '../../Icon'
import { IntercoderResults, type IntercoderResultsData } from './IntercoderResults'

type WindowData = IntercoderResultsData & { title: string; theme: string }

const send = (action: string, payload?: unknown) => window.api.sendIntercoderResultsAction(action, payload)

export function IntercoderResultsWindow() {
  const { t } = useTranslation()
  const [data, setData] = useState<WindowData | null>(null)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    const apply = (d: unknown) => {
      if (!d) return
      const wd = d as WindowData
      setData(wd)
      if (wd.theme) document.documentElement.setAttribute('data-theme', wd.theme)
    }
    void window.api.getIntercoderResultsData().then(apply)
    return window.api.onIntercoderResultsData(apply)
  }, [])

  // The window's title (and its name in the View menu) names the analysis.
  useEffect(() => {
    if (data?.title) document.title = data.title
  }, [data?.title])

  if (!data) return null
  return (
    // Laid out like the other pop-outs (Queries, Codes, Logbook): one card
    // under a pane header, with Pop back in at the header's end.
    <div className="panel intercoder-results-window">
      <div className="panel-header">
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.title}</span>
        <button
          className="panel-header-popout"
          onClick={() => window.close()}
          title={t('results.popInTitle')}
          aria-label={t('panel.popInLabel')}
        >
          <Icon icon={faDownLeftAndUpRightToCenter} />
        </button>
      </div>
      <div ref={setScroller} className="panel-content" style={{ padding: '0 12px 12px' }}>
        <IntercoderResults
          {...data}
          scroller={scroller}
          poppedOut
          onPopOut={() => window.close()}
          onView={(v) => send('view', v)}
          onMeasure={(m) => send('measure', m)}
          onThreshold={(t) => send('threshold', t)}
          onToggleExpanded={(k) => send('toggle-expanded', k)}
          onDrill={(d) => send('drill', d)}
        />
      </div>
    </div>
  )
}
