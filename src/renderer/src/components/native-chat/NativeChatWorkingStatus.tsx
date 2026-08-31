import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'

export function NativeChatWorkingStatus({
  startedAt,
  thinking
}: {
  startedAt: number | null
  thinking: boolean
}): React.JSX.Element {
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    const epoch = startedAt ?? Date.now()
    setElapsedSeconds(Math.max(0, Math.floor((Date.now() - epoch) / 1000)))
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - epoch) / 1000)))
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])

  return (
    <div
      className="flex min-h-8 items-center border-b border-border text-xs text-muted-foreground"
      aria-label={translate('components.native-chat.status.responding', 'Agent is responding')}
      aria-live="polite"
    >
      {thinking
        ? translate('components.native-chat.status.thinking', 'Thinking')
        : translate('components.native-chat.status.workingFor', 'Working for {{value0}} seconds', {
            value0: elapsedSeconds
          })}
    </div>
  )
}
