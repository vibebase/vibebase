import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../lib/event-bus'
import { WebhooksManager } from '../../lib/webhooks-manager'
import { createMockD1Database } from '../setup'

interface WebhookDeliveryRow {
  id: string
  webhook_id: string
  event_type: string
  payload: string
  response_status: number
  response_body: string
  attempt_count: number
  delivered_at: string
  created_at: string
}

describe('WebhooksManager', () => {
  let db: ReturnType<typeof createMockD1Database>
  let eventBus: EventBus
  let webhooksManager: WebhooksManager
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    db = createMockD1Database()
    eventBus = new EventBus()

    // Mock global fetch
    fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    // Initialize webhooks table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        events TEXT NOT NULL,
        secret TEXT,
        is_enabled INTEGER DEFAULT 1,
        created_at TEXT,
        updated_at TEXT
      )
    `)

    await db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        response_status INTEGER,
        response_body TEXT,
        attempt_count INTEGER DEFAULT 1,
        delivered_at TEXT,
        created_at TEXT
      )
    `)

    webhooksManager = new WebhooksManager(db, eventBus)
  })

  describe('Event Bus integration', () => {
    it('should subscribe to Event Bus on start', () => {
      expect(eventBus.listenerCount()).toBe(0)

      webhooksManager.start()

      expect(eventBus.listenerCount()).toBe(1)
    })

    it('should unsubscribe from Event Bus on stop', () => {
      webhooksManager.start()
      expect(eventBus.listenerCount()).toBe(1)

      webhooksManager.stop()

      expect(eventBus.listenerCount()).toBe(0)
    })

    it('should trigger webhook delivery when event is published', async () => {
      // Create a webhook
      await db
        .prepare(`
        INSERT INTO webhooks (id, url, events, is_enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
        .bind(
          'webhook-1',
          'https://example.com/webhook',
          JSON.stringify(['posts.insert']),
          1,
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run()

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'OK',
      })

      webhooksManager.start()

      // Publish event
      await eventBus.publish({
        table: 'posts',
        action: 'insert',
        recordId: '123',
        data: { title: 'Test' },
      })

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      )
    })
  })

  describe('Event filtering', () => {
    it('should only trigger webhooks matching event filters', async () => {
      // Webhook for posts.insert only
      await db
        .prepare(`
        INSERT INTO webhooks (id, url, events, is_enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
        .bind(
          'webhook-1',
          'https://example.com/posts',
          JSON.stringify(['posts.insert']),
          1,
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run()

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'OK',
      })

      webhooksManager.start()

      // Publish matching event
      await eventBus.publish({
        table: 'posts',
        action: 'insert',
        recordId: '123',
        data: { title: 'Test' },
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // Publish non-matching event
      await eventBus.publish({
        table: 'posts',
        action: 'update',
        recordId: '123',
        data: { title: 'Updated' },
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fetchMock).toHaveBeenCalledTimes(1) // Still 1, not called again
    })

    it('should support wildcard events', async () => {
      await db
        .prepare(`
        INSERT INTO webhooks (id, url, events, is_enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
        .bind(
          'webhook-1',
          'https://example.com/all',
          JSON.stringify(['*']),
          1,
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run()

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'OK',
      })

      webhooksManager.start()

      // All events should trigger
      await eventBus.publish({
        table: 'posts',
        action: 'insert',
        recordId: '1',
        data: {},
      })

      await eventBus.publish({
        table: 'users',
        action: 'delete',
        recordId: '2',
        data: {},
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('Retry logic', () => {
    it('should retry on failure with exponential backoff', async () => {
      await db
        .prepare(`
        INSERT INTO webhooks (id, url, events, is_enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
        .bind(
          'webhook-1',
          'https://example.com/webhook',
          JSON.stringify(['posts.insert']),
          1,
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run()

      // Fail first 2 times, succeed on 3rd
      let callCount = 0
      fetchMock.mockImplementation(() => {
        callCount++
        if (callCount < 3) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: async () => 'Server Error',
          })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => 'OK',
        })
      })

      webhooksManager.start()

      await eventBus.publish({
        table: 'posts',
        action: 'insert',
        recordId: '123',
        data: { title: 'Test' },
      })

      // Wait for retries (with exponential backoff: 100ms, 200ms, 400ms)
      await new Promise((resolve) => setTimeout(resolve, 1000))

      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
  })

  describe('Delivery logging', () => {
    it('should log successful deliveries', async () => {
      await db
        .prepare(`
        INSERT INTO webhooks (id, url, events, is_enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
        .bind(
          'webhook-1',
          'https://example.com/webhook',
          JSON.stringify(['posts.insert']),
          1,
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run()

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'Success',
      })

      webhooksManager.start()

      await eventBus.publish({
        table: 'posts',
        action: 'insert',
        recordId: '123',
        data: { title: 'Test' },
      })

      await new Promise((resolve) => setTimeout(resolve, 100))

      const deliveries = await db
        .prepare(`
        SELECT * FROM webhook_deliveries WHERE webhook_id = ?
      `)
        .bind('webhook-1')
        .all<WebhookDeliveryRow>()

      expect(deliveries.results).toHaveLength(1)
      expect(deliveries.results[0]).toMatchObject({
        webhook_id: 'webhook-1',
        event_type: 'posts.insert',
        response_status: 200,
        attempt_count: 1,
      })
    })
  })
})
