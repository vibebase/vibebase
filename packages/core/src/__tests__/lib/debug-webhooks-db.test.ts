import { beforeEach, describe, expect, it } from 'vitest'
import { createMockD1Database } from '../setup'

interface WebhookRow {
  id: string
  url: string
  events: string
  secret?: string
  is_enabled: number
  created_at: string
  updated_at: string
}

describe('Mock D1 Webhooks Table Debug', () => {
  let db: ReturnType<typeof createMockD1Database>

  beforeEach(async () => {
    db = createMockD1Database()

    // Create table
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
  })

  it('should insert and retrieve webhook', async () => {
    console.log('=== TEST START ===')

    // Insert webhook
    const insertResult = await db
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

    console.log('Insert result:', insertResult)

    // Retrieve all webhooks
    const allResult = await db.prepare('SELECT * FROM webhooks').all<WebhookRow>()
    console.log('All webhooks:', allResult)

    expect(allResult.results).toBeDefined()
    expect(allResult.results.length).toBeGreaterThan(0)

    // Retrieve enabled webhooks
    const enabledResult = await db
      .prepare('SELECT * FROM webhooks WHERE is_enabled = 1')
      .all<WebhookRow>()
    console.log('Enabled webhooks:', enabledResult)

    expect(enabledResult.results).toBeDefined()
    expect(enabledResult.results.length).toBeGreaterThan(0)
  })

  it('should handle JSON events column', async () => {
    await db
      .prepare(`
      INSERT INTO webhooks (id, url, events, is_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .bind(
        'webhook-2',
        'https://example.com/test',
        JSON.stringify(['*']),
        1,
        new Date().toISOString(),
        new Date().toISOString()
      )
      .run()

    const result = await db
      .prepare('SELECT * FROM webhooks WHERE id = ?')
      .bind('webhook-2')
      .first<{ events: string }>()
    console.log('Retrieved webhook:', result)

    expect(result).toBeDefined()
    expect(result?.events).toBeDefined()

    const events = typeof result?.events === 'string' ? JSON.parse(result.events) : result?.events
    console.log('Parsed events:', events)
    expect(Array.isArray(events)).toBe(true)
  })
})
