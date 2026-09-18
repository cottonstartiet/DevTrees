import * as React from 'react'

interface GlobalTaskShortcutProps {
  onNewTask: () => void
}

export function GlobalTaskShortcut({
  onNewTask
}: GlobalTaskShortcutProps): React.JSX.Element | null {
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const isNewTaskShortcut =
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'n'

      if (!isNewTaskShortcut || event.defaultPrevented || event.isComposing) return

      event.preventDefault()
      if (event.repeat || document.querySelector('[role="dialog"][data-state="open"]')) return

      onNewTask()
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [onNewTask])

  return null
}
