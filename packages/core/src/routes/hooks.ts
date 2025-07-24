import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { HookManager } from '../lib/hook-manager'
import { TableManager } from '../lib/table-manager'
import type { Env, Variables } from '../types'
import type { CustomDurableObjectNamespace } from '../types/cloudflare'

export const hooks = new Hono<{ Bindings: Env; Variables: Variables }>()

// Middleware to add managers
hooks.use('*', async (c, next) => {
  if (!c.env.DB) {
    return c.json({ error: 'Database not configured' }, 500)
  }
  c.set('hookManager', new HookManager(c.env.DB, c.env.WORKER_DOMAIN))
  c.set(
    'tableManager',
    new TableManager(c.env.DB, c.env.SYSTEM_STORAGE, c.executionCtx, {
      REALTIME: c.env.REALTIME as CustomDurableObjectNamespace,
      WORKER_DOMAIN: c.env.WORKER_DOMAIN,
    })
  )
  await next()
})

// Schema for creating hooks
const createHookSchema = z.object({
  table_name: z.string().min(1),
  event_type: z.enum(['insert', 'update', 'delete']),
})

// Schema for updating hooks
const updateHookSchema = z.object({
  enabled: z.boolean(),
})

// GET /api/hooks - List all hooks
hooks.get('/', async (c) => {
  try {
    const hookManager = c.get('hookManager') as HookManager
    const hooks = await hookManager.getAllHooks()

    return c.json({
      data: hooks,
      total: hooks.length,
    })
  } catch (error) {
    console.error('Error fetching hooks:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to fetch hooks',
      },
      500
    )
  }
})

// POST /api/hooks - Create a new hook
hooks.post('/', zValidator('json', createHookSchema), async (c) => {
  try {
    const hookManager = c.get('hookManager') as HookManager
    const tableManager = c.get('tableManager') as TableManager
    const { table_name, event_type } = c.req.valid('json')

    // Validate table exists
    const tables = await tableManager.getTables()
    const table = tables.find((t) => t.name === table_name)

    if (!table) {
      return c.json({ error: `Table '${table_name}' not found` }, 404)
    }

    // Don't allow hooks on system tables
    if (table.type === 'system') {
      return c.json({ error: 'Cannot create hooks on system tables' }, 400)
    }

    // Check if hook already exists
    const existingHooks = await hookManager.getActiveHooks(table_name, event_type)
    if (existingHooks.length > 0) {
      const existingHook = existingHooks[0]
      return c.json(
        {
          success: true,
          data: {
            id: existingHook.id,
            table_name: existingHook.table_name,
            event_type: existingHook.event_type,
            enabled: existingHook.enabled,
            created_at: existingHook.created_at,
            updated_at: existingHook.updated_at,
          },
          message: 'Hook already exists, returning existing hook',
        },
        200
      )
    }

    // Create the hook
    const hookId = await hookManager.createHook(table_name, event_type)

    return c.json(
      {
        success: true,
        data: {
          id: hookId,
          table_name,
          event_type,
          enabled: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        message: 'Hook created successfully',
      },
      201
    )
  } catch (error) {
    console.error('Error creating hook:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to create hook',
      },
      500
    )
  }
})

// PUT /api/hooks/:id - Update hook status
hooks.put('/:id', zValidator('json', updateHookSchema), async (c) => {
  try {
    const hookManager = c.get('hookManager') as HookManager
    const hookId = c.req.param('id')
    const { enabled } = c.req.valid('json')

    await hookManager.updateHookStatus(hookId, enabled)

    return c.json({
      success: true,
      message: `Hook ${enabled ? 'enabled' : 'disabled'} successfully`,
    })
  } catch (error) {
    console.error('Error updating hook:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to update hook',
      },
      500
    )
  }
})

// DELETE /api/hooks/:id - Delete a hook
hooks.delete('/:id', async (c) => {
  try {
    const hookManager = c.get('hookManager') as HookManager
    const hookId = c.req.param('id')

    await hookManager.deleteHook(hookId)

    return c.json({
      success: true,
      message: 'Hook deleted successfully',
    })
  } catch (error) {
    console.error('Error deleting hook:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to delete hook',
      },
      500
    )
  }
})

// GET /api/hooks/events - Get unprocessed events
hooks.get('/events', async (c) => {
  try {
    const hookManager = c.get('hookManager') as HookManager
    const limit = parseInt(c.req.query('limit') || '100')

    const events = await hookManager.getUnprocessedEvents(limit)

    return c.json({
      data: events,
      total: events.length,
    })
  } catch (error) {
    console.error('Error fetching events:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to fetch events',
      },
      500
    )
  }
})

// POST /api/hooks/events/:id/process - Mark event as processed
hooks.post('/events/:id/process', async (c) => {
  try {
    const hookManager = c.get('hookManager') as HookManager
    const eventId = c.req.param('id')

    await hookManager.markEventProcessed(eventId)

    return c.json({
      success: true,
      message: 'Event marked as processed',
    })
  } catch (error) {
    console.error('Error processing event:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to process event',
      },
      500
    )
  }
})

// POST /api/hooks/cleanup - Clean up old processed events
hooks.post('/cleanup', async (c) => {
  try {
    const hookManager = c.get('hookManager') as HookManager
    const daysToKeep = parseInt(c.req.query('days') || '7')

    const deletedCount = await hookManager.cleanupProcessedEvents(daysToKeep)

    return c.json({
      success: true,
      message: `Cleaned up ${deletedCount} processed events older than ${daysToKeep} days`,
    })
  } catch (error) {
    console.error('Error cleaning up events:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to cleanup events',
      },
      500
    )
  }
})
