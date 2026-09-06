export type HostConnectionState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'host-unavailable'
  | 'restored-from-snapshot'

type EventHandler<T = unknown> = (payload: T) => void
type StateHandler = (state: HostConnectionState) => void

class HostEventClient {
  private socket: WebSocket | null = null
  private attempts = 0
  private reconnectTimer: number | null = null
  private eventHandlers = new Map<string, Set<EventHandler>>()
  private stateHandlers = new Set<StateHandler>()
  private currentState: HostConnectionState = 'connecting'

  subscribe<T>(event: string, handler: EventHandler<T>): () => void {
    const handlers = this.eventHandlers.get(event) ?? new Set<EventHandler>()
    handlers.add(handler as EventHandler)
    this.eventHandlers.set(event, handlers)
    this.ensureConnected()
    return () => {
      handlers.delete(handler as EventHandler)
    }
  }

  onState(handler: StateHandler): () => void {
    this.stateHandlers.add(handler)
    handler(this.currentState)
    this.ensureConnected()
    return () => this.stateHandlers.delete(handler)
  }

  markRestored(): void {
    this.setState('restored-from-snapshot')
    window.setTimeout(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.setState('live')
    }, 1200)
  }

  private ensureConnected(): void {
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      return
    }
    this.connect()
  }

  private connect(): void {
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting')
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.socket = new WebSocket(`${protocol}//${window.location.host}/events`)
    this.socket.addEventListener('open', () => {
      this.attempts = 0
      this.setState('live')
    })
    this.socket.addEventListener('message', (message) => {
      try {
        const envelope = JSON.parse(String(message.data)) as { event: string; data: unknown }
        for (const handler of this.eventHandlers.get(envelope.event) ?? []) {
          handler(envelope.data)
        }
      } catch (error) {
        console.warn('[events] ignored malformed host event', error)
      }
    })
    this.socket.addEventListener('close', () => this.scheduleReconnect())
    this.socket.addEventListener('error', () => this.socket?.close())
  }

  private scheduleReconnect(): void {
    this.socket = null
    this.attempts += 1
    this.setState(this.attempts >= 4 ? 'host-unavailable' : 'reconnecting')
    const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempts, 5))
    const jittered = delay * (0.8 + Math.random() * 0.4)
    this.reconnectTimer = window.setTimeout(() => this.connect(), jittered)
  }

  private setState(state: HostConnectionState): void {
    if (state === this.currentState) return
    this.currentState = state
    for (const handler of this.stateHandlers) handler(state)
  }
}

export const hostEvents = new HostEventClient()
