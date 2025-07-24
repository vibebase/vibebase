import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { HookManager } from '../lib/hook-manager'
import type { Env, Variables } from '../types'
import type { CustomDurableObjectNamespace, DurableObjectStub } from '../types/cloudflare'

export const realtime = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /api/realtime/ping - Test Durable Object connectivity
realtime.get('/ping', async (c) => {
  console.log('[SSE] Ping request received')

  if (!c.env.REALTIME) {
    return c.json({ error: 'REALTIME env not configured' }, 503)
  }

  try {
    const realtime = c.env.REALTIME as CustomDurableObjectNamespace
    const id = realtime.idFromName('global')
    const stub = realtime.get(id)

    const response = await stub.fetch('http://internal/ping')
    const data = await response.json()

    return c.json({
      durable_object: data,
      realtime_configured: true,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[SSE] Ping error:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        realtime_configured: !!c.env.REALTIME,
      },
      500
    )
  }
})

// Schema for subscription request
const subscribeSchema = z.object({
  tables: z.array(z.string()).optional(),
  hookIds: z.array(z.string()).optional(),
})

// Note: All SSE connections and broadcasting are handled by the Durable Object
// This ensures consistency and scalability across multiple worker instances

// GET /api/realtime/test-sse - Test SSE endpoint without auth (for debugging only)
realtime.get('/test-sse', async (c) => {
  console.log('[TEST-SSE] Direct test connection without auth')

  if (!c.env.REALTIME) {
    console.error('[TEST-SSE] REALTIME Durable Object not configured')
    return c.json({ error: 'Realtime service not configured' }, 503)
  }

  const clientId = `test-${Math.random().toString(36).substring(2)}`
  console.log('[TEST-SSE] Generated test clientId:', clientId)

  try {
    const realtime = c.env.REALTIME as CustomDurableObjectNamespace
    const id = realtime.idFromName('global')
    const stub = realtime.get(id)

    console.log('[TEST-SSE] Connecting to Durable Object...')
    const url = new URL(`http://internal/connect?clientId=${clientId}&userId=test-user`)
    const response = await stub.fetch(url.toString())

    console.log('[TEST-SSE] Durable Object response:', response.status)

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[TEST-SSE] Failed:', errorText)
      return c.json({ error: 'Failed to connect', details: errorText }, 500)
    }

    return response
  } catch (error) {
    console.error('[TEST-SSE] Error:', error)
    return c.json(
      {
        error: 'Connection error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    )
  }
})

// GET /api/realtime/sse - Server-Sent Events endpoint (using multiAuth middleware)
realtime.get('/sse', async (c) => {
  console.log('[SSE] Incoming SSE connection request')
  console.log('[SSE] Request URL:', c.req.url)

  // multiAuth middleware already handles token validation via URL parameter
  // The middleware supports both API keys and user JWT tokens
  const authContext = c.get('authContext')

  // DEBUG: For testing only - accept debug parameter
  const debugMode = c.req.query('debug') === 'true'
  if (debugMode) {
    console.log('[SSE] DEBUG MODE - bypassing auth for testing')
  }

  if (!authContext && !debugMode) {
    console.log('[SSE] No auth context - returning 401')
    return c.text('Unauthorized - Authentication required', 401)
  }

  console.log('[SSE] Auth context type:', authContext?.type || 'debug')

  // Check if Durable Object is available
  if (!c.env.REALTIME) {
    console.error('[SSE] REALTIME Durable Object not configured')
    return c.json({ error: 'Realtime service not configured' }, 503)
  }

  // Generate unique client ID
  const clientId = Math.random().toString(36).substring(2) + Date.now().toString(36)
  const currentAuthContext = c.get('authContext')
  const userId = currentAuthContext?.type === 'user' ? currentAuthContext.user?.id : undefined

  console.log('[SSE] Generated clientId:', clientId, 'userId:', userId)

  // Connect to Durable Object
  try {
    console.log('[SSE] Getting REALTIME namespace...')
    const realtime = c.env.REALTIME as CustomDurableObjectNamespace
    console.log('[SSE] REALTIME namespace:', realtime ? 'available' : 'not available')

    console.log('[SSE] Getting Durable Object ID...')
    const id = realtime.idFromName('global')
    console.log('[SSE] Durable Object ID created')

    console.log('[SSE] Getting Durable Object stub...')
    const stub = realtime.get(id)
    console.log('[SSE] Durable Object stub created')

    console.log('[SSE] Connecting to Durable Object for clientId:', clientId)

    // Proxy the SSE connection to the Durable Object
    const url = new URL(
      `http://internal/connect?clientId=${clientId}${userId ? `&userId=${userId}` : ''}`
    )
    console.log('[SSE] Durable Object URL:', url.toString())

    console.log('[SSE] Sending request to Durable Object...')
    const response = await stub.fetch(url.toString())

    console.log('[SSE] Durable Object response status:', response.status)
    console.log(
      '[SSE] Durable Object response headers:',
      response.headers ? Object.fromEntries(response.headers.entries()) : 'No headers'
    )

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[SSE] Durable Object connection failed:', response.status, errorText)
      return c.json({ error: 'Failed to establish realtime connection', details: errorText }, 500)
    }

    console.log('[SSE] Returning Durable Object SSE response to client')
    // Return the Durable Object's SSE response
    return response
  } catch (error) {
    console.error('[SSE] Error connecting to Durable Object:', error)
    console.error('[SSE] Error stack:', error instanceof Error ? error.stack : 'No stack')
    return c.json(
      {
        error: 'Failed to connect to realtime service',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    )
  }
})

// POST /api/realtime/subscribe - Update subscriptions
realtime.post('/subscribe', zValidator('json', subscribeSchema), async (c) => {
  try {
    const { tables, hookIds } = c.req.valid('json')
    const clientId = c.req.header('X-Client-Id')

    if (!clientId) {
      return c.json({ error: 'Missing X-Client-Id header' }, 400)
    }

    if (!c.env.REALTIME) {
      return c.json({ error: 'Realtime service not configured' }, 503)
    }

    // Get Durable Object
    const realtime = c.env.REALTIME as CustomDurableObjectNamespace
    const id = realtime.idFromName('global')
    const stub = realtime.get(id)

    // Update subscriptions
    const extendedStub = stub as DurableObjectStub
    if (extendedStub.updateSubscriptions) {
      await extendedStub.updateSubscriptions(clientId, { tables, hookIds })
    }

    return c.json({
      success: true,
      message: 'Subscriptions updated',
      subscriptions: { tables, hookIds },
    })
  } catch (error) {
    console.error('Error updating subscriptions:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to update subscriptions',
      },
      500
    )
  }
})

// POST /api/realtime/process-events - Process failed events from queue
// This endpoint is called periodically to retry failed events (backup mechanism)
realtime.post('/process-events', async (c) => {
  try {
    if (!c.env.DB || !c.env.REALTIME) {
      return c.json({ error: 'Required services not configured' }, 503)
    }

    const hookManager = new HookManager(c.env.DB)

    // Get unprocessed events (these are typically failed immediate broadcasts)
    const events = await hookManager.getUnprocessedEvents(100)

    if (events.length === 0) {
      return c.json({
        success: true,
        message: 'No failed events to retry',
        processed: 0,
      })
    }

    // Get Durable Object
    const realtime = c.env.REALTIME as CustomDurableObjectNamespace
    const id = realtime.idFromName('global')
    const stub = realtime.get(id)

    let processedCount = 0

    // Process each event
    for (const event of events) {
      try {
        // Parse event data
        const eventData = JSON.parse(event.event_data)

        // Broadcast to connected clients
        const broadcastResponse = await stub.fetch('http://internal/broadcast', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'event',
            event: {
              id: event.id,
              table: event.table_name,
              recordId: event.record_id,
              eventType: event.event_type,
              data: eventData,
              timestamp: event.created_at,
            },
          }),
        })

        if (broadcastResponse.ok) {
          // Mark event as processed
          await hookManager.markEventProcessed(event.id)
          processedCount++
        }
      } catch (error) {
        console.error(`Failed to process event ${event.id}:`, error)
      }
    }

    return c.json({
      success: true,
      message: `Retried ${processedCount} of ${events.length} failed events`,
      processed: processedCount,
      total: events.length,
    })
  } catch (error) {
    console.error('Error processing events:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to process events',
      },
      500
    )
  }
})

// OPTIONS /api/realtime/* - Handle CORS preflight
realtime.options('*', async (_c) => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Id',
      'Access-Control-Max-Age': '86400',
    },
  })
})
