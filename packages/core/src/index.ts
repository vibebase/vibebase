import type { ExecutionContext, ScheduledEvent } from '@cloudflare/workers-types'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { AdminAuthManager } from './lib/admin-auth-manager'
import { AppSettingsManager } from './lib/app-settings-manager'
import { getOrGenerateJWTSecret, logSecurityWarnings } from './lib/security-utils'
import { multiAuth } from './middleware/auth'
import { securityHeaders } from './middleware/security-headers'
import { admin } from './routes/admin'
import adminOAuth from './routes/admin-oauth'
import { api } from './routes/api'
import { apiKeys } from './routes/api-keys'
import appSettings from './routes/app-settings'
import { auth } from './routes/auth'
import { custom } from './routes/custom'
import { customQueries } from './routes/custom-queries'
import { data } from './routes/data'
import { docs } from './routes/docs'
import { hooks } from './routes/hooks'
import { push } from './routes/push'
import { realtime } from './routes/realtime'
import { snapshots } from './routes/snapshots'
import { storage } from './routes/storage'
import { tables } from './routes/tables'
import userAuth from './routes/user-auth'
import { CURRENT_ASSETS } from './templates/assets'
import { getDashboardHTML } from './templates/html'
import type { Env, Variables } from './types'
import type { CustomDurableObjectNamespace } from './types/cloudflare'

// Export Durable Object class
export { RealtimeConnectionManager } from './durable-objects/realtime-connection'

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// Global error handler
app.onError((err, c) => {
  console.error('Global error handler:', err)
  return c.json(
    {
      error: 'Internal Server Error',
      message: err.message,
      stack: err.stack,
    },
    500
  )
})

app.use('*', logger())

// Debug SSE endpoint (before auth middleware)
app.get('/debug/test-sse', async (c) => {
  console.log('[DEBUG-SSE] Test SSE endpoint accessed')

  if (!c.env.REALTIME) {
    console.log('[DEBUG-SSE] REALTIME not configured')
    return c.json({ error: 'REALTIME not configured' }, 503)
  }

  try {
    const realtime = c.env.REALTIME as CustomDurableObjectNamespace
    const id = realtime.idFromName('global')
    const stub = realtime.get(id)
    const clientId = `debug-${Math.random().toString(36).substring(2)}`

    console.log('[DEBUG-SSE] Connecting to Durable Object with clientId:', clientId)
    console.log('[DEBUG-SSE] Durable Object namespace:', !!realtime)
    console.log('[DEBUG-SSE] Durable Object ID:', id)
    console.log('[DEBUG-SSE] Durable Object stub:', !!stub)

    const response = await stub.fetch(`http://internal/connect?clientId=${clientId}`)

    console.log('[DEBUG-SSE] DO response status:', response.status)
    console.log(
      '[DEBUG-SSE] DO response headers:',
      response.headers ? Object.fromEntries(response.headers.entries()) : 'No headers'
    )
    console.log('[DEBUG-SSE] DO response body stream:', !!response.body)

    // Log first few bytes if possible
    const clonedResponse = response.clone()
    try {
      const reader = clonedResponse.body?.getReader()
      if (reader) {
        const { value, done } = await reader.read()
        console.log(
          '[DEBUG-SSE] First chunk:',
          value ? new TextDecoder().decode(value) : 'No data',
          'Done:',
          done
        )
        reader.releaseLock()
      }
    } catch (readError) {
      console.log('[DEBUG-SSE] Could not read response body:', readError)
    }

    return response
  } catch (error) {
    console.error('[DEBUG-SSE] Error:', error)
    return c.json(
      {
        error: 'Failed to connect',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    )
  }
})

// Apply security headers to all responses
app.use('*', securityHeaders())

app.use('/api/*', cors())

// Initialize JWT_SECRET with security validation
app.use('*', async (c, next) => {
  // Initialize and validate JWT_SECRET
  const jwtSecretResult = getOrGenerateJWTSecret(c.env.JWT_SECRET, c.env.ENVIRONMENT)

  // Log security warnings if any
  if (jwtSecretResult.warnings.length > 0) {
    logSecurityWarnings(jwtSecretResult.warnings, 'JWT Secret')
  }

  // Update environment with the validated/generated secret
  c.env.JWT_SECRET = jwtSecretResult.secret

  // Set WORKER_DOMAIN: DB > リクエストhost の優先順位
  if (!c.env.WORKER_DOMAIN && c.env.DB) {
    const appSettings = new AppSettingsManager(c.env.DB)
    const storedDomain = await appSettings.getWorkerDomain()

    if (storedDomain) {
      // DBに保存済みの値を使用
      c.env.WORKER_DOMAIN = storedDomain
    } else {
      // DBにもない場合、hostから取得して保存
      const host = c.req.header('host')
      if (host) {
        c.env.WORKER_DOMAIN = host
        await appSettings.setWorkerDomain(host)
      }
    }
  }

  await next()
})

// 認証クライアントを初期化してコンテキストに設定
app.use('*', async (c, next) => {
  try {
    const authClient = new AdminAuthManager(c.env)
    await authClient.initialize()
    c.set('authClient', authClient)
    await next()
  } catch (error) {
    console.error('Failed to initialize auth client:', error)
    // 認証クライアントの初期化に失敗した場合
    c.set('authClient', undefined)

    // 認証ルート以外では初期化失敗をエラーとして返す
    if (!c.req.path.startsWith('/auth/')) {
      return c.json(
        {
          error: 'Authentication service initialization failed',
          details: error instanceof Error ? error.message : 'Unknown error',
        },
        503
      )
    }

    await next()
  }
})

// Apply authentication middleware to all routes except auth routes and static assets
app.use('*', async (c, next) => {
  // Skip auth check for auth routes and static assets
  if (
    c.req.path.startsWith('/auth/') ||
    c.req.path.startsWith('/api/auth/') ||
    c.req.path.startsWith('/assets/') ||
    c.req.path.startsWith('/favicon.') ||
    c.req.path === '/api/realtime/ping' ||
    c.req.path === '/api/push/vapid-public-key'
  ) {
    await next()
    return
  }

  // Use multi-auth middleware for API routes and dashboard
  return await multiAuth(c, next)
})

// Root route - Dashboard
app.get('/', async (c) => {
  const user = c.get('user')
  // User should be available after middleware authentication
  if (!user) {
    throw new Error('User not found after authentication')
  }

  return c.html(
    getDashboardHTML(
      {
        id: user.id,
        username: user.username || user.name || 'Unknown',
        email: user.email,
        name: user.name,
      },
      CURRENT_ASSETS.js,
      CURRENT_ASSETS.css
    )
  )
})

// Static assets handled by Workers Assets below

// Auth routes (public)
app.route('/auth', auth)
app.route('/api/auth', userAuth)

// API routes (protected by authentication)
app.route('/api', api)
app.route('/api/tables', tables)
app.route('/api/data', data)
app.route('/api/docs', docs)
app.route('/api/snapshots', snapshots)
app.route('/api/storage', storage)
app.route('/api/admin', admin)
app.route('/api/admin/oauth', adminOAuth)
app.route('/api/api-keys', apiKeys)
app.route('/api/app-settings', appSettings)
app.route('/api/hooks', hooks)
app.route('/api/realtime', realtime)
app.route('/api/custom-queries', customQueries)
app.route('/api/custom', custom)
app.route('/api/push', push)

// Handle static assets
app.get('/assets/*', async (c) => {
  // Let Workers Assets handle this through env.ASSETS
  return c.env.ASSETS.fetch(c.req.raw)
})

app.get('/favicon.svg', async (c) => {
  // Let Workers Assets handle this through env.ASSETS
  return c.env.ASSETS.fetch(c.req.raw)
})

app.get('/favicon.ico', async (c) => {
  // Redirect to SVG favicon
  return c.redirect('/favicon.svg', 301)
})

// Service Worker
app.get('/sw.js', async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw)
  // Set proper content type for Service Worker
  const newHeaders = new Headers(response.headers)
  newHeaders.set('Content-Type', 'application/javascript')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  })
})

// Catch-all route for SPA fallback
app.get('*', async (c) => {
  // Don't handle API routes, auth routes, or static assets
  if (
    c.req.path.startsWith('/api/') ||
    c.req.path.startsWith('/auth/') ||
    c.req.path.startsWith('/assets/') ||
    c.req.path.startsWith('/favicon.')
  ) {
    return c.json({ error: 'Not Found' }, 404)
  }

  // For SPA routes, user is already authenticated via middleware
  const user = c.get('user')
  // User should be available after middleware authentication
  if (!user) {
    throw new Error('User not found after authentication')
  }

  // Return the SPA HTML with auth state
  return c.html(
    getDashboardHTML(
      {
        id: user.id,
        username: user.username || user.name || 'Unknown',
        email: user.email,
        name: user.name,
      },
      CURRENT_ASSETS.js,
      CURRENT_ASSETS.css
    )
  )
})

// Export default handler with both fetch and scheduled handlers
export default {
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log('Cron trigger executed:', event.cron)

    try {
      // Get WORKER_DOMAIN from environment or DB
      let workerDomain = env.WORKER_DOMAIN

      if (!workerDomain && env.DB) {
        const appSettings = new AppSettingsManager(env.DB)
        workerDomain = (await appSettings.getWorkerDomain()) || undefined
      }

      if (!workerDomain) {
        console.warn('WORKER_DOMAIN not found, skipping cron processing')
        return
      }

      // Call the process-events endpoint internally
      const url = `https://${workerDomain}/api/realtime/process-events`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.JWT_SECRET}`, // Use internal auth
        },
      })

      if (!response.ok) {
        console.error('Failed to process events via cron:', response.status, await response.text())
      }
    } catch (error) {
      console.error('Error in cron handler:', error)
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx)
  },
}
