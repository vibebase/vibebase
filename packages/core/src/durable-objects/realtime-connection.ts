import { DurableObject } from 'cloudflare:workers'

export interface RealtimeMessage {
  type: 'event' | 'ping' | 'subscribe' | 'unsubscribe'
  event?: {
    id: string
    table: string
    recordId: string
    eventType: 'insert' | 'update' | 'delete'
    data: Record<string, unknown>
    timestamp: string
  }
  subscriptions?: {
    tables?: string[]
    hookIds?: string[]
  }
}

interface Connection {
  id: string
  userId?: string
  subscriptions: {
    tables: Set<string>
    hookIds: Set<string>
  }
  writer: WritableStreamDefaultWriter<Uint8Array>
  lastPing: number
}

export class RealtimeConnectionManager extends DurableObject {
  private connections: Map<string, Connection> = new Map()
  private pingInterval?: number

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    console.log('[DURABLE-OBJECT] Incoming request:', request.method, url.pathname, url.search)

    // Handle ping requests for debugging
    if (url.pathname === '/ping') {
      console.log('[DURABLE-OBJECT] Ping received, total connections:', this.connections.size)
      return new Response(
        JSON.stringify({
          status: 'ok',
          connections: this.connections.size,
          timestamp: new Date().toISOString(),
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    // Handle SSE connections
    if (url.pathname === '/connect') {
      console.log('[DURABLE-OBJECT] SSE connect request received')
      return this.handleSSEConnection(request)
    }

    // Handle event broadcasts
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      console.log('[DURABLE-OBJECT] Broadcast request received')
      return this.handleBroadcast(request)
    }

    // Handle connection management
    if (url.pathname === '/disconnect' && request.method === 'POST') {
      console.log('[DURABLE-OBJECT] Disconnect request received')
      return this.handleDisconnect(request)
    }

    // Handle subscription updates
    if (url.pathname === '/subscribe' && request.method === 'POST') {
      console.log('[DURABLE-OBJECT] Subscribe request received')
      return this.handleSubscribe(request)
    }

    console.log('[DURABLE-OBJECT] Unknown path:', url.pathname)
    return new Response('Not Found', { status: 404 })
  }

  private async handleSSEConnection(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const clientId = url.searchParams.get('clientId')
    const userId = url.searchParams.get('userId')

    console.log('[DURABLE-OBJECT] SSE connection request', { clientId, userId })

    if (!clientId) {
      console.log('[DURABLE-OBJECT] Missing clientId')
      return new Response('Missing clientId', { status: 400 })
    }

    try {
      console.log(
        '[DURABLE-OBJECT] Creating SSE stream using simplified approach for clientId:',
        clientId
      )

      const encoder = new TextEncoder()
      const { readable, writable } = new TransformStream()
      const writer = writable.getWriter()

      // Create initial message
      const initialMessage = `data: ${JSON.stringify({
        type: 'connected',
        clientId,
        timestamp: new Date().toISOString(),
        message: 'SSE connection established',
      })}\n\n`

      console.log('[DURABLE-OBJECT] Preparing initial message for clientId:', clientId)

      // Store connection with simplified writer interface
      const connection: Connection = {
        id: clientId,
        userId: userId || undefined,
        subscriptions: {
          tables: new Set(['*']), // Subscribe to all tables by default
          hookIds: new Set(),
        },
        writer,
        lastPing: Date.now(),
      }

      this.connections.set(clientId, connection)
      console.log(
        '[DURABLE-OBJECT] Connection stored for clientId:',
        clientId,
        'Total connections:',
        this.connections.size
      )

      // Send initial message immediately and synchronously after storing connection
      const writePromise = writer.write(encoder.encode(initialMessage))
      console.log('[DURABLE-OBJECT] Initial message write initiated for clientId:', clientId)

      // Don't await the write to avoid blocking the response
      writePromise
        .then(() => {
          console.log(
            '[DURABLE-OBJECT] ✅ Initial message successfully sent to clientId:',
            clientId
          )
        })
        .catch((error) => {
          console.error(
            '[DURABLE-OBJECT] ❌ Failed to send initial message to clientId:',
            clientId,
            error
          )
        })

      // Start ping interval if not already running
      if (!this.pingInterval) {
        this.startPingInterval()
      }

      // Handle stream closure
      const _originalReadable = readable

      // Return the SSE stream with proper headers
      return new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Cache-Control, Content-Type, Authorization',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'X-Content-Type-Options': 'nosniff',
          'X-Accel-Buffering': 'no', // Disable nginx buffering
        },
      })
    } catch (error) {
      console.error('[DURABLE-OBJECT] Error creating SSE connection:', error)
      return new Response(
        `Internal Server Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { status: 500 }
      )
    }
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    try {
      const message: RealtimeMessage = await request.json()

      if (message.type !== 'event' || !message.event) {
        return new Response('Invalid message', { status: 400 })
      }

      const event = message.event
      let broadcastCount = 0

      // Broadcast to all relevant connections
      console.log('[DURABLE-OBJECT] Broadcasting event to', this.connections.size, 'connections')
      for (const [clientId, connection] of this.connections) {
        console.log(
          '[DURABLE-OBJECT] Checking clientId:',
          clientId,
          'subscribed tables:',
          Array.from(connection.subscriptions.tables)
        )
        // Check if connection is subscribed to this event
        if (
          connection.subscriptions.tables.has(event.table) ||
          connection.subscriptions.tables.has('*')
        ) {
          console.log('[DURABLE-OBJECT] Sending event to clientId:', clientId)
          await this.sendToClient(connection, {
            type: 'event',
            ...event,
          })
          broadcastCount++
        } else {
          console.log(
            '[DURABLE-OBJECT] Skipping clientId:',
            clientId,
            'not subscribed to table:',
            event.table
          )
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          broadcastCount,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      )
    } catch (error) {
      console.error('Broadcast error:', error)
      return new Response('Internal Server Error', { status: 500 })
    }
  }

  private async handleDisconnect(request: Request): Promise<Response> {
    try {
      const { clientId } = (await request.json()) as { clientId?: string }

      if (!clientId) {
        return new Response('Missing clientId', { status: 400 })
      }

      const connection = this.connections.get(clientId)
      if (connection) {
        await connection.writer.close().catch(() => {})
        this.connections.delete(clientId)
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (error) {
      console.error('Disconnect error:', error)
      return new Response('Internal Server Error', { status: 500 })
    }
  }

  private async handleSubscribe(request: Request): Promise<Response> {
    try {
      const { clientId, subscriptions } = (await request.json()) as {
        clientId?: string
        subscriptions?: RealtimeMessage['subscriptions']
      }

      if (!clientId) {
        return new Response('Missing clientId', { status: 400 })
      }

      await this.updateSubscriptions(clientId, subscriptions)

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (error) {
      console.error('Subscribe error:', error)
      return new Response('Internal Server Error', { status: 500 })
    }
  }

  private async sendToClient(connection: Connection, data: Record<string, unknown>): Promise<void> {
    try {
      const encoder = new TextEncoder()
      const message = `data: ${JSON.stringify(data)}\n\n`
      console.log(
        `[DURABLE-OBJECT] Sending message to client ${connection.id}:`,
        JSON.stringify(data)
      )

      // Write message to the stream
      await connection.writer.write(encoder.encode(message))
      console.log(`[DURABLE-OBJECT] ✅ Message sent successfully to client ${connection.id}`)

      // Update last ping time for keep-alive tracking
      connection.lastPing = Date.now()
    } catch (error) {
      // Connection might be closed or failed
      console.error(`[DURABLE-OBJECT] ❌ Failed to send to client ${connection.id}:`, error)
      this.connections.delete(connection.id)
      throw error
    }
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now()
      const timeout = 30000 // 30 seconds

      for (const [clientId, connection] of this.connections) {
        // Send ping
        this.sendToClient(connection, {
          type: 'ping',
          timestamp: new Date().toISOString(),
        }).catch(() => {
          // Remove dead connections
          this.connections.delete(clientId)
        })

        // Check for stale connections
        if (now - connection.lastPing > timeout * 2) {
          connection.writer.close().catch(() => {})
          this.connections.delete(clientId)
        }
      }

      // Stop interval if no connections
      if (this.connections.size === 0 && this.pingInterval) {
        clearInterval(this.pingInterval)
        this.pingInterval = undefined
      }
    }, 25000) as unknown as number // Ping every 25 seconds
  }

  // Handle subscription updates from clients
  async updateSubscriptions(
    clientId: string,
    subscriptions: RealtimeMessage['subscriptions']
  ): Promise<void> {
    console.log(
      '[DURABLE-OBJECT] Updating subscriptions for clientId:',
      clientId,
      'subscriptions:',
      subscriptions
    )
    const connection = this.connections.get(clientId)
    if (!connection) {
      console.log('[DURABLE-OBJECT] Connection not found for clientId:', clientId)
      return
    }

    if (subscriptions?.tables) {
      connection.subscriptions.tables = new Set(subscriptions.tables)
    }
    if (subscriptions?.hookIds) {
      connection.subscriptions.hookIds = new Set(subscriptions.hookIds)
    }

    console.log(
      '[DURABLE-OBJECT] Updated subscriptions for clientId:',
      clientId,
      'tables:',
      Array.from(connection.subscriptions.tables)
    )

    // Send confirmation
    await this.sendToClient(connection, {
      type: 'subscriptions_updated',
      subscriptions: {
        tables: Array.from(connection.subscriptions.tables),
        hookIds: Array.from(connection.subscriptions.hookIds),
      },
      timestamp: new Date().toISOString(),
    })
  }
}
