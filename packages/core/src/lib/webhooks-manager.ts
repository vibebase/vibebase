import type { D1Database } from '@cloudflare/workers-types'
import { getCurrentDateTimeISO } from './datetime-utils'
import { type DataEvent, EventBus, type EventListener } from './event-bus'
import { generateId } from './utils'

interface Webhook {
  id: string
  url: string
  events: string[] // e.g., ['posts.insert', 'users.delete', '*']
  secret?: string
  is_enabled: boolean
  created_at: string
  updated_at: string
}

interface WebhookDelivery {
  id: string
  webhook_id: string
  event_type: string
  payload: string
  response_status?: number
  response_body?: string
  attempt_count: number
  delivered_at?: string
  created_at: string
}

export class WebhooksManager {
  private unsubscribe?: () => void
  private maxRetries = 3
  private initialBackoff = 100 // ms

  constructor(
    private db: D1Database,
    private eventBus: EventBus = new EventBus()
  ) {}

  /**
   * Start listening to Event Bus
   */
  start(): void {
    console.log('[WEBHOOKS] Starting webhook manager')

    const listener: EventListener = async (event: DataEvent) => {
      await this.handleEvent(event)
    }

    this.unsubscribe = this.eventBus.subscribe(listener)
  }

  /**
   * Stop listening to Event Bus
   */
  stop(): void {
    if (this.unsubscribe) {
      console.log('[WEBHOOKS] Stopping webhook manager')
      this.unsubscribe()
      this.unsubscribe = undefined
    }
  }

  /**
   * Handle incoming event from Event Bus
   */
  private async handleEvent(event: DataEvent): Promise<void> {
    try {
      // Get all enabled webhooks
      const result = await this.db
        .prepare(`
        SELECT * FROM webhooks WHERE is_enabled = 1
      `)
        .all()

      if (!result.results || result.results.length === 0) {
        console.log('[WEBHOOKS] No enabled webhooks found')
        return
      }

      const webhooks = result.results.map((row) => ({
        ...row,
        events: typeof row.events === 'string' ? JSON.parse(row.events) : row.events,
      })) as Webhook[]

      // Filter webhooks that match this event
      const eventType = `${event.table}.${event.action}`
      const matchingWebhooks = webhooks.filter((webhook) => {
        const events = Array.isArray(webhook.events) ? webhook.events : []
        return events.includes('*') || events.includes(eventType)
      })

      console.log(`[WEBHOOKS] Found ${matchingWebhooks.length} matching webhooks for ${eventType}`)

      // Deliver to each matching webhook
      for (const webhook of matchingWebhooks) {
        await this.deliverWebhook(webhook, event)
      }
    } catch (error) {
      console.error('[WEBHOOKS] Error handling event:', error)
    }
  }

  /**
   * Deliver webhook with retry logic
   */
  private async deliverWebhook(webhook: Webhook, event: DataEvent): Promise<void> {
    const payload = {
      event: `${event.table}.${event.action}`,
      table: event.table,
      action: event.action,
      record_id: event.recordId,
      data: event.data,
      user_id: event.userId,
      timestamp: getCurrentDateTimeISO(),
    }

    let attempt = 0
    let delivered = false
    let lastStatus: number | undefined
    let lastResponse: string | undefined

    while (attempt < this.maxRetries && !delivered) {
      attempt++

      try {
        console.log(`[WEBHOOKS] Delivering to ${webhook.url} (attempt ${attempt})`)

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': 'Vibebase-Webhooks/1.0',
        }

        // Add HMAC signature if secret is configured
        if (webhook.secret) {
          const signature = await this.generateSignature(JSON.stringify(payload), webhook.secret)
          headers['X-Webhook-Signature'] = signature
        }

        const response = await fetch(webhook.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000), // 10 second timeout
        })

        lastStatus = response.status
        lastResponse = await response.text().catch(() => '')

        if (response.ok) {
          delivered = true
          console.log(`[WEBHOOKS] ✅ Delivered successfully to ${webhook.url}`)
        } else {
          console.error(`[WEBHOOKS] ❌ Delivery failed with status ${response.status}`)

          // Exponential backoff for retry
          if (attempt < this.maxRetries) {
            const backoff = this.initialBackoff * 2 ** (attempt - 1)
            console.log(`[WEBHOOKS] Retrying in ${backoff}ms...`)
            await new Promise((resolve) => setTimeout(resolve, backoff))
          }
        }
      } catch (error) {
        console.error(`[WEBHOOKS] Delivery error:`, error)
        lastResponse = error instanceof Error ? error.message : 'Unknown error'

        // Retry on network errors
        if (attempt < this.maxRetries) {
          const backoff = this.initialBackoff * 2 ** (attempt - 1)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      }
    }

    // Log the delivery attempt
    await this.logDelivery({
      webhook_id: webhook.id,
      event_type: `${event.table}.${event.action}`,
      payload: JSON.stringify(payload),
      response_status: lastStatus,
      response_body: lastResponse,
      attempt_count: attempt,
      delivered_at: delivered ? getCurrentDateTimeISO() : undefined,
    })
  }

  /**
   * Generate HMAC signature for webhook payload
   */
  private async generateSignature(payload: string, secret: string): Promise<string> {
    const encoder = new TextEncoder()
    const keyData = encoder.encode(secret)
    const messageData = encoder.encode(payload)

    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )

    const signature = await crypto.subtle.sign('HMAC', key, messageData)

    // Convert to hex string
    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  /**
   * Log webhook delivery
   */
  private async logDelivery(delivery: Omit<WebhookDelivery, 'id' | 'created_at'>): Promise<void> {
    try {
      await this.db
        .prepare(`
        INSERT INTO webhook_deliveries (
          id, webhook_id, event_type, payload, 
          response_status, response_body, attempt_count, 
          delivered_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .bind(
          generateId(),
          delivery.webhook_id,
          delivery.event_type,
          delivery.payload,
          delivery.response_status || null,
          delivery.response_body || null,
          delivery.attempt_count,
          delivery.delivered_at || null,
          getCurrentDateTimeISO()
        )
        .run()
    } catch (error) {
      console.error('[WEBHOOKS] Failed to log delivery:', error)
    }
  }
}
