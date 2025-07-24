/**
 * Realtime Client for Server-Sent Events
 */
import type { ApiResponse, RealtimeEvent, RealtimeSubscription } from '../types'
import type { HttpClient } from './http-client'

export class RealtimeClient {
  private subscriptions = new Map<string, RealtimeSubscription>()
  private eventSource: EventSource | null = null
  private baseUrl: string
  private authToken: string | null = null

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  /**
   * Set authentication token
   */
  setAuth(token: string): void {
    this.authToken = token
  }

  /**
   * Subscribe to table changes
   */
  subscribe(
    tableName: string,
    eventType: 'insert' | 'update' | 'delete' | '*',
    callback: (event: RealtimeEvent) => void
  ): RealtimeSubscription {
    const id = `${tableName}:${eventType}:${Date.now()}`

    const subscription: RealtimeSubscription = {
      id,
      tableName,
      eventType,
      callback,
      unsubscribe: () => this.unsubscribe(id),
    }

    this.subscriptions.set(id, subscription)
    this.ensureConnection()

    return subscription
  }

  /**
   * Unsubscribe from table changes
   */
  unsubscribe(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId)

    // Close connection if no more subscriptions
    if (this.subscriptions.size === 0) {
      this.disconnect()
    }
  }

  /**
   * Unsubscribe from all subscriptions
   */
  unsubscribeAll(): void {
    this.subscriptions.clear()
    this.disconnect()
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN
  }

  /**
   * Manually connect to realtime stream
   */
  connect(): void {
    this.ensureConnection()
  }

  /**
   * Disconnect from realtime stream
   */
  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
  }

  /**
   * Ensure EventSource connection is active
   */
  private ensureConnection(): void {
    if (this.eventSource && this.eventSource.readyState !== EventSource.CLOSED) {
      return
    }

    const url = new URL('/api/realtime/sse', this.baseUrl)

    // Add auth token to URL if available (since EventSource doesn't support headers)
    if (this.authToken) {
      url.searchParams.set('token', this.authToken)
    }

    // Use polyfilled EventSource if available
    const EventSourceConstructor =
      globalThis.EventSource || (globalThis as { EventSource?: typeof EventSource }).EventSource
    if (!EventSourceConstructor) {
      throw new Error('EventSource is not available. Please ensure EventSource polyfill is loaded.')
    }

    this.eventSource = new EventSourceConstructor(url.toString())

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        console.log('[REALTIME-CLIENT] Received event:', data)

        // Skip connection events
        if (data.type === 'connected') {
          console.log('[REALTIME-CLIENT] Connection confirmed')
          return
        }

        // Handle realtime events with different formats
        if (data.type === 'event' || (data.type && (data.table || data.tableName))) {
          console.log('[REALTIME-CLIENT] Processing realtime event:', data)
          this.handleRealtimeEvent(data as RealtimeEvent)
        } else {
          console.warn('[REALTIME-CLIENT] Unknown event format:', data)
        }
      } catch (error) {
        console.error('Failed to parse realtime event:', error, 'Raw data:', event.data)
      }
    }

    this.eventSource.onerror = (error) => {
      console.error(
        '[REALTIME-CLIENT] Connection error:',
        error,
        'ReadyState:',
        this.eventSource?.readyState
      )

      // Attempt to reconnect after delay
      setTimeout(() => {
        if (this.subscriptions.size > 0) {
          console.log('[REALTIME-CLIENT] Attempting reconnection...')
          this.ensureConnection()
        }
      }, 5000)
    }

    this.eventSource.onopen = () => {
      console.log('[REALTIME-CLIENT] Connection opened successfully')
    }
  }

  /**
   * Handle incoming realtime events
   */
  private handleRealtimeEvent(event: RealtimeEvent): void {
    for (const subscription of this.subscriptions.values()) {
      // Match table name
      if (subscription.tableName !== event.table && subscription.tableName !== '*') {
        continue
      }

      // Match event type
      if (subscription.eventType !== event.eventType && subscription.eventType !== '*') {
        continue
      }

      try {
        subscription.callback(event)
      } catch (error) {
        console.error('Error in realtime callback:', error)
      }
    }
  }
}

/**
 * Utility functions for working with realtime subscriptions
 */
export class RealtimeManager {
  private http: HttpClient

  constructor(http: HttpClient) {
    this.http = http
  }

  /**
   * Create a database hook for realtime events
   */
  async createHook(
    tableName: string,
    eventType: 'insert' | 'update' | 'delete'
  ): Promise<ApiResponse<{ id: string }>> {
    return this.http.post('/api/hooks', {
      table_name: tableName,
      event_type: eventType,
    })
  }

  /**
   * List existing hooks
   */
  async listHooks(): Promise<
    ApiResponse<
      Array<{
        id: string
        table_name: string
        event_type: string
        is_enabled: boolean
        created_at: string
      }>
    >
  > {
    return this.http.get('/api/hooks')
  }

  /**
   * Delete a hook
   */
  async deleteHook(hookId: string): Promise<ApiResponse<void>> {
    return this.http.delete(`/api/hooks/${hookId}`)
  }

  /**
   * Toggle hook status
   */
  async toggleHook(hookId: string, enabled: boolean): Promise<ApiResponse<void>> {
    return this.http.put(`/api/hooks/${hookId}`, { enabled })
  }

  /**
   * Process failed events from the queue
   */
  async processEvents(): Promise<ApiResponse<{ processed: number; message: string }>> {
    return this.http.post('/api/realtime/process-events')
  }
}
