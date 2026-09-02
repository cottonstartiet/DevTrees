const TAIL_CHARS = 16_384

/* eslint-disable no-control-regex */
const ANSI_PATTERN =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB0]|\x1b[=>]/g
const CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f]/g
/* eslint-enable no-control-regex */

const COMMAND_PROMPT_PATTERNS = [/(?:^|\s)[>❯›]\s*$/]
const CONFIRMATION_PROMPT_PATTERNS = [
  /\[(?:y\/n|Y\/n|y\/N)\]\s*$/i,
  /\b(?:yes\/no|approve\/deny)\??\s*$/i,
  /\bpress enter\b.*$/i,
  /\bwaiting for (?:response|confirmation)\b/i
]
const CONFIRMATION_MENU_PATTERNS = [
  /\bdo you trust\b/i,
  /\b(?:allow|approve|grant|deny)\b.{0,80}\b(?:tool|command|permission|access)\b/i,
  /\benter to (?:select|confirm|continue)\b/i,
  /\b(?:use|press).{0,40}(?:arrow|↑|↓).{0,40}(?:select|navigate)\b/i,
  /\besc to cancel\b/i
]
const NUMBERED_OPTION_PATTERN = /(?:^|\n)\s*(?:[1-9][.)]|[❯›>])\s+\S/m

export type TerminalAttentionKind = 'command' | 'confirmation' | null

export function capTerminalTail(text: string): string {
  return text.length > TAIL_CHARS ? text.slice(text.length - TAIL_CHARS) : text
}

export function cleanTerminalOutput(buffer: string): string {
  return buffer.replace(ANSI_PATTERN, '').replace(/\r\n/g, '\n').replace(CONTROL_PATTERN, '')
}

export function lastVisibleTerminalLine(buffer: string): string {
  const lines = cleanTerminalOutput(buffer).split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    let line = lines[index]
    const carriageReturn = line.lastIndexOf('\r')
    if (carriageReturn >= 0) line = line.slice(carriageReturn + 1)
    const cleaned = line.replace(/\t/g, ' ').trim()
    if (cleaned) return cleaned
  }
  return ''
}

export function terminalIsWaitingForInput(buffer: string): boolean {
  return terminalAttentionKind(buffer) !== null
}

export function terminalAttentionKind(buffer: string): TerminalAttentionKind {
  const line = lastVisibleTerminalLine(buffer)
  if (!line) return null
  if (COMMAND_PROMPT_PATTERNS.some((pattern) => pattern.test(line))) return 'command'
  if (CONFIRMATION_PROMPT_PATTERNS.some((pattern) => pattern.test(line))) return 'confirmation'
  const recentLines = cleanTerminalOutput(buffer).split('\n').slice(-12).join('\n')
  if (
    CONFIRMATION_MENU_PATTERNS.some((pattern) => pattern.test(recentLines)) ||
    (NUMBERED_OPTION_PATTERN.test(recentLines) &&
      /\b(?:yes|no|allow|deny|trust|approve|cancel)\b/i.test(recentLines))
  ) {
    return 'confirmation'
  }
  return null
}
