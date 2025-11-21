import { nanoid } from 'nanoid'
import type {
  CustomDurableObjectNamespace,
  D1Database,
  ExecutionContext,
} from '../types/cloudflare'
import { getCurrentDateTimeISO } from './datetime-utils'
import { globalEventBus } from './event-bus'

interface RealtimeEnvironment {
  REALTIME?: CustomDurableObjectNamespace
  WORKER_DOMAIN?: string
}

interface BroadcastOptions {
  env?: RealtimeEnvironment
  executionCtx?: ExecutionContext
  userId?: string
}

export type HookEventType = 'insert' | 'update' | 'delete'

export interface Hook {
  id: string
  table_name: string
  event_type: HookEventType
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface EventQueueItem {
  id: string
  hook_id: string
  table_name: string
  record_id: string
  event_type: HookEventType
  event_data: string
  processed: boolean
  created_at: string
  processed_at: string | null
}

export class HookManager {
  constructor(
    private db: D1Database,
    private workerDomain: string = 'vibebase.app',
    private eventBus = globalEventBus
  ) {}

  async listHooks(): Promise<Hook[]> {
    const result = await this.db
      .prepare('SELECT * FROM hooks ORDER BY table_name, event_type')
      .all<Hook>()

    return result.results || []
  }

  async getAllHooks(): Promise<Hook[]> {
    return this.listHooks()
  }

  async createHook(tableName: string, eventType: HookEventType): Promise<string> {
    const id = nanoid()
    const now = getCurrentDateTimeISO()

    await this.db
      .prepare(
        'INSERT INTO hooks (id, table_name, event_type, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(id, tableName, eventType, true, now, now)
      .run()

    return id
  }

  async toggleHook(id: string, enabled: boolean): Promise<Hook> {
    const now = getCurrentDateTimeISO()

    await this.db
      .prepare('UPDATE hooks SET enabled = ?, updated_at = ? WHERE id = ?')
      .bind(enabled, now, id)
      .run()

    const result = await this.db.prepare('SELECT * FROM hooks WHERE id = ?').bind(id).first<Hook>()

    if (!result) {
      throw new Error('Hook not found')
    }

    return result
  }

  async updateHookStatus(id: string, enabled: boolean): Promise<void> {
    await this.toggleHook(id, enabled)
  }

  async deleteHook(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM hooks WHERE id = ?').bind(id).run()
  }

  async getActiveHooks(tableName: string, eventType: HookEventType): Promise<Hook[]> {
    const result = await this.db
      .prepare('SELECT * FROM hooks WHERE table_name = ? AND event_type = ? AND enabled = true')
      .bind(tableName, eventType)
      .all<Hook>()

    return result.results || []
  }

  async queueEvent(
    hook: Hook,
    recordId: string,
    eventData: Record<string, unknown>
  ): Promise<void> {
    const id = nanoid()
    const now = getCurrentDateTimeISO()
    const data = JSON.stringify(eventData)

    await this.db
      .prepare(
        'INSERT INTO event_queue (id, hook_id, table_name, record_id, event_type, event_data, processed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(id, hook.id, hook.table_name, recordId, hook.event_type, data, false, now)
      .run()
  }

  async getUnprocessedEvents(limit: number = 100): Promise<EventQueueItem[]> {
    const result = await this.db
      .prepare('SELECT * FROM event_queue WHERE processed = false ORDER BY created_at ASC LIMIT ?')
      .bind(limit)
      .all<EventQueueItem>()

    return result.results || []
  }

  async markEventProcessed(id: string): Promise<void> {
    const now = getCurrentDateTimeISO()

    await this.db
      .prepare(
        'UPDATE event_queue SET processed = true, processed_at = ?, updated_at = ? WHERE id = ?'
      )
      .bind(now, now, id)
      .run()
  }

  async cleanupProcessedEvents(daysOld: number = 7): Promise<number> {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysOld)
    const cutoffDateStr = cutoffDate.toISOString()

    const result = await this.db
      .prepare('DELETE FROM event_queue WHERE processed = true AND processed_at < ?')
      .bind(cutoffDateStr)
      .run()

    return result.meta.changes
  }

  async triggerHooks(
    tableName: string,
    eventType: HookEventType,
    recordId: string,
    eventData: Record<string, unknown>
  ): Promise<void> {
    try {
      const hooks = await this.getActiveHooks(tableName, eventType)

      for (const hook of hooks) {
        await this.queueEvent(hook, recordId, {
          table_name: tableName,
          event_type: eventType,
          record_id: recordId,
          timestamp: getCurrentDateTimeISO(),
          data: eventData,
        })
      }
    } catch (error) {
      console.error('Error triggering hooks:', error)
    }
  }

  async processDataEvent(
    tableName: string,
    recordId: string,
    eventType: HookEventType,
    eventData: Record<string, unknown>,
    options?: BroadcastOptions
  ): Promise<void> {
    console.log(`[HOOK-MANAGER] ===== processDataEvent called =====`)
    console.log(`[HOOK-MANAGER] Table: ${tableName}, Event: ${eventType}, RecordId: ${recordId}`)
    console.log(`[HOOK-MANAGER] EventData:`, JSON.stringify(eventData, null, 2))

    // Publish to Event Bus
    // Event Bus subscribers (like RealtimeBridge) will handle the event
    console.log('[HOOK-MANAGER] ===== EVENT BUS PUBLISH START =====')
    try {
      await this.eventBus.publish({
        table: tableName,
        action: eventType,
        recordId: recordId,
        data: eventData,
        userId: options?.userId,
      })
      console.log('[HOOK-MANAGER] ===== EVENT BUS PUBLISH END =====')
    } catch (error) {
      console.error('[HOOK-MANAGER] Event Bus publish error:', error)
    }

    // フック記録（バックアップ用）
    if (options?.executionCtx) {
      options.executionCtx.waitUntil(this.triggerHooks(tableName, eventType, recordId, eventData))
    } else {
      // fallback: 同期実行
      await this.triggerHooks(tableName, eventType, recordId, eventData)
    }
  }
}
