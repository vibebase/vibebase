import type { CustomDurableObjectNamespace, DurableObjectStub } from '../types/cloudflare'
import { getCurrentDateTimeISO } from './datetime-utils'
import { type DataEvent, globalEventBus } from './event-bus'

/**
 * RealtimeBridge: Event BusとRealtime Durable Objectの間のブリッジ
 * Event Busからのイベントをリッスンし、Durable Objectに転送
 */
export class RealtimeBridge {
  private unsubscribe?: () => void

  constructor(private realtimeNamespace: CustomDurableObjectNamespace) {}

  /**
   * Event Busへの接続を開始
   */
  start(): void {
    console.log('[REALTIME-BRIDGE] Starting Event Bus listener')

    this.unsubscribe = globalEventBus.subscribe(async (event: DataEvent) => {
      await this.forwardToDurableObject(event)
    })
  }

  /**
   * Event Busからのイベントをリッスン停止
   */
  stop(): void {
    if (this.unsubscribe) {
      console.log('[REALTIME-BRIDGE] Stopping Event Bus listener')
      this.unsubscribe()
      this.unsubscribe = undefined
    }
  }

  /**
   * イベントをDurable Objectに転送
   */
  private async forwardToDurableObject(event: DataEvent): Promise<void> {
    try {
      console.log('[REALTIME-BRIDGE] Forwarding event to Durable Object:', {
        table: event.table,
        action: event.action,
        recordId: event.recordId,
      })

      const id = this.realtimeNamespace.idFromName('global')
      const stub = this.realtimeNamespace.get(id) as DurableObjectStub

      const payload = {
        type: 'event',
        event: {
          id: `${event.recordId}-${Date.now()}`,
          table: event.table,
          recordId: event.recordId,
          eventType: event.action,
          data: event.data,
          timestamp: getCurrentDateTimeISO(),
        },
      }

      const response = await stub.fetch('http://internal/broadcast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        console.error('[REALTIME-BRIDGE] ❌ Failed to forward event, status:', response.status)
      } else {
        console.log('[REALTIME-BRIDGE] ✅ Event forwarded successfully')
      }
    } catch (error) {
      console.error('[REALTIME-BRIDGE] ❌ Error forwarding event:', error)
    }
  }
}
