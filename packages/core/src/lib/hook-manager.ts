import { nanoid } from 'nanoid'
import type {
  CustomDurableObjectNamespace,
  D1Database,
  DurableObjectStub,
  ExecutionContext,
} from '../types/cloudflare'
import { getCurrentDateTimeISO } from './datetime-utils'
import { NotificationManager } from './notification-manager'
import { VapidStorage } from './vapid-storage'

interface RealtimeEnvironment {
  REALTIME?: CustomDurableObjectNamespace
  WORKER_DOMAIN?: string
}

interface BroadcastOptions {
  env?: RealtimeEnvironment
  executionCtx?: ExecutionContext
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
    private workerDomain: string = 'vibebase.app'
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
    console.log(`[HOOK-MANAGER] Options:`, options ? 'provided' : 'not provided')

    // 即時ブロードキャスト（Durable Objects経由）
    console.log(`[HOOK-MANAGER] ===== BROADCAST ATTEMPT START =====`)
    try {
      console.log(`[HOOK-MANAGER] Attempting broadcast for ${tableName} ${eventType}`)
      console.log(`[HOOK-MANAGER] Options available:`, {
        hasOptions: !!options,
        hasEnv: !!options?.env,
        hasREALTIME: !!options?.env?.REALTIME,
        envKeys: options?.env ? Object.keys(options.env) : [],
      })

      if (options?.env?.REALTIME) {
        console.log('[HOOK-MANAGER] ✅ REALTIME env available - proceeding with broadcast')
        await this.broadcastRealtime(
          tableName,
          eventType,
          recordId,
          eventData,
          options.env.REALTIME
        )
        console.log('[HOOK-MANAGER] ✅ Broadcast call completed')
      } else {
        console.error('[HOOK-MANAGER] ❌ No REALTIME env available for broadcast')
        console.log('[HOOK-MANAGER] Missing REALTIME environment - events will not be broadcast')
      }
    } catch (error) {
      console.error('[HOOK-MANAGER] ❌ Durable Objects broadcast failed:', error)
      console.error(
        '[HOOK-MANAGER] Broadcast error stack:',
        error instanceof Error ? error.stack : 'No stack'
      )
    }
    console.log(`[HOOK-MANAGER] ===== BROADCAST ATTEMPT END =====`)

    // プッシュ通知処理（waitUntilでバックグラウンド実行）
    if (options?.executionCtx) {
      const workerDomain = options?.env?.WORKER_DOMAIN || this.workerDomain
      options.executionCtx.waitUntil(
        this.processNotifications(tableName, eventType, eventData, workerDomain)
      )
    }

    // フック記録（バックアップ用）
    if (options?.executionCtx) {
      options.executionCtx.waitUntil(this.triggerHooks(tableName, eventType, recordId, eventData))
    } else {
      // fallback: 同期実行
      await this.triggerHooks(tableName, eventType, recordId, eventData)
    }
  }

  private async processNotifications(
    tableName: string,
    eventType: HookEventType,
    eventData: Record<string, unknown>,
    workerDomain: string
  ): Promise<void> {
    try {
      const vapidStorage = new VapidStorage(this.db, workerDomain)
      const vapidKeys = await vapidStorage.retrieve()

      if (!vapidKeys) {
        // VAPID keys not configured, skip push notification processing
        return
      }

      const notificationManager = new NotificationManager(this.db, {
        publicKey: vapidKeys.publicKey,
        privateKey: vapidKeys.privateKey,
        subject: vapidKeys.subject,
      })

      await notificationManager.processDbChange(tableName, eventType, eventData)
    } catch (error) {
      console.error('Push notification processing failed:', error)
      // エラーでもメイン処理には影響しない
    }
  }

  private async broadcastRealtime(
    tableName: string,
    eventType: HookEventType,
    recordId: string,
    eventData: Record<string, unknown>,
    realtimeNamespace: CustomDurableObjectNamespace
  ): Promise<void> {
    console.log(`[HOOK-MANAGER] ===== broadcastRealtime called =====`)
    console.log(
      `[HOOK-MANAGER] Table: ${tableName}, EventType: ${eventType}, RecordId: ${recordId}`
    )
    console.log(`[HOOK-MANAGER] EventData keys:`, Object.keys(eventData))

    try {
      console.log('[HOOK-MANAGER] Getting Durable Object ID...')
      const id = realtimeNamespace.idFromName('global')
      console.log('[HOOK-MANAGER] Getting Durable Object stub...')
      const stub = realtimeNamespace.get(id) as DurableObjectStub

      const payload = {
        type: 'event',
        event: {
          table: tableName,
          recordId,
          eventType,
          data: eventData,
          timestamp: getCurrentDateTimeISO(),
        },
      }
      console.log('[HOOK-MANAGER] Broadcast payload:', JSON.stringify(payload, null, 2))

      console.log('[HOOK-MANAGER] Sending broadcast request to Durable Object...')
      const response = await stub.fetch('http://internal/broadcast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      console.log(`[HOOK-MANAGER] Durable Object response status: ${response.status}`)
      const responseText = await response.text()
      console.log(`[HOOK-MANAGER] Durable Object response body: ${responseText}`)

      if (!response.ok) {
        console.error(`[HOOK-MANAGER] ❌ Broadcast failed with status ${response.status}`)
      } else {
        console.log(`[HOOK-MANAGER] ✅ Broadcast successful`)
      }
    } catch (error) {
      console.error('[HOOK-MANAGER] ❌ Realtime broadcast error:', error)
      console.error(
        '[HOOK-MANAGER] Error stack:',
        error instanceof Error ? error.stack : 'No stack'
      )
    }
  }
}
