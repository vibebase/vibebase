export type DataEventAction = 'insert' | 'update' | 'delete'

export interface DataEvent {
  table: string
  action: DataEventAction
  recordId: string
  data: Record<string, unknown>
  userId?: string
}

export type EventListener = (event: DataEvent) => void | Promise<void>

export class EventBus {
  private listeners: Set<EventListener> = new Set()

  /**
   * Subscribe to data change events
   * @param listener Function to call when an event is published
   * @returns Unsubscribe function
   */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)

    // Return unsubscribe function
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Publish a data change event to all subscribers
   * @param event The data event to publish
   */
  async publish(event: DataEvent): Promise<void> {
    const promises: Promise<void>[] = []

    for (const listener of this.listeners) {
      try {
        const result = listener(event)
        if (result instanceof Promise) {
          promises.push(
            result.catch((error) => {
              console.error('[EVENT-BUS] Listener error:', error)
            })
          )
        }
      } catch (error) {
        console.error('[EVENT-BUS] Listener error:', error)
      }
    }

    // Wait for all async listeners to complete
    await Promise.all(promises)
  }

  /**
   * Get the number of active listeners (mainly for testing)
   */
  listenerCount(): number {
    return this.listeners.size
  }

  /**
   * Clear all listeners (mainly for testing)
   */
  clear(): void {
    this.listeners.clear()
  }
}

// Export a singleton instance
export const globalEventBus = new EventBus()
