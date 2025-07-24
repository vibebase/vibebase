// Push notification service interfaces and implementations

import {
  buildPushPayload,
  type PushSubscription as WebPushSubscription,
} from '@block65/webcrypto-web-push'

export interface PushSubscription {
  id: string
  userId: string
  provider: 'webpush' | 'fcm'
  endpoint?: string
  p256dh?: string
  auth?: string
  fcmToken?: string
  deviceInfo?: Record<string, unknown>
  platform?: 'web' | 'ios' | 'android' | 'desktop'
}

export interface NotificationPayload {
  title: string
  body: string
  icon?: string
  image?: string
  badge?: string
  tag?: string
  data?: Record<string, unknown>
  actions?: NotificationAction[]
  requireInteraction?: boolean
  silent?: boolean

  // Platform-specific options
  ios?: {
    sound?: string
    badge?: number
    category?: string
  }
  android?: {
    channelId?: string
    color?: string
    priority?: 'high' | 'normal' | 'low'
  }
}

export interface NotificationAction {
  action: string
  title: string
  icon?: string
}

export interface SendResult {
  success: boolean
  statusCode?: number
  headers?: Record<string, string>
  error?: string
}

// Abstract push service interface
export abstract class PushService {
  abstract send(subscription: PushSubscription, payload: NotificationPayload): Promise<SendResult>
  abstract sendBatch(
    subscriptions: PushSubscription[],
    payload: NotificationPayload
  ): Promise<SendResult[]>
}

// Web Push implementation
export class WebPushService extends PushService {
  private vapidPublicKey: string
  private vapidPrivateKey: string
  private vapidSubject: string

  constructor(vapidPublicKey: string, vapidPrivateKey: string, vapidSubject: string) {
    super()
    this.vapidPublicKey = vapidPublicKey
    this.vapidPrivateKey = vapidPrivateKey
    this.vapidSubject = vapidSubject
  }

  async send(subscription: PushSubscription, payload: NotificationPayload): Promise<SendResult> {
    if (!subscription.endpoint || !subscription.p256dh || !subscription.auth) {
      return {
        success: false,
        error: 'Invalid subscription: missing endpoint, p256dh, or auth',
      }
    }

    try {
      // Convert our subscription to webcrypto-web-push format
      const webPushSubscription: WebPushSubscription = {
        endpoint: subscription.endpoint,
        expirationTime: null,
        keys: {
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
      }

      // VAPID configuration
      const vapidConfig = {
        subject: this.vapidSubject,
        publicKey: this.vapidPublicKey,
        privateKey: this.vapidPrivateKey,
      }

      // Message payload - Web Push standard requires all data to be in the data field
      const message = {
        data: {
          title: payload.title,
          body: payload.body,
          icon: payload.icon,
          image: payload.image,
          badge: payload.badge,
          tag: payload.tag,
          data: payload.data ? JSON.parse(JSON.stringify(payload.data)) : {},
          actions: payload.actions ? JSON.parse(JSON.stringify(payload.actions)) : undefined,
          requireInteraction: payload.requireInteraction,
          silent: payload.silent,
        },
      }

      // Build push payload using webcrypto-web-push
      const pushPayload = await buildPushPayload(message, webPushSubscription, vapidConfig)

      // Send the push notification
      const response = await fetch(subscription.endpoint, pushPayload)

      return {
        success: response.ok,
        statusCode: response.status,
        headers: response.headers ? Object.fromEntries(response.headers.entries()) : {},
        error: response.ok ? undefined : `HTTP ${response.status}: ${response.statusText}`,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  async sendBatch(
    subscriptions: PushSubscription[],
    payload: NotificationPayload
  ): Promise<SendResult[]> {
    // Send notifications in parallel with concurrency limit
    const BATCH_SIZE = 100
    const results: SendResult[] = []

    for (let i = 0; i < subscriptions.length; i += BATCH_SIZE) {
      const batch = subscriptions.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(batch.map((sub) => this.send(sub, payload)))
      results.push(...batchResults)
    }

    return results
  }
}

// Factory function to create push service based on provider
export function createPushService(
  provider: 'webpush' | 'fcm',
  config: {
    vapidPublicKey?: string
    vapidPrivateKey?: string
    vapidSubject?: string
  }
): PushService {
  switch (provider) {
    case 'webpush':
      if (!config.vapidPrivateKey) {
        throw new Error('VAPID private key is required for webpush')
      }
      if (!config.vapidSubject) {
        throw new Error('VAPID subject is required for webpush')
      }
      if (!config.vapidPublicKey) {
        throw new Error('VAPID public key is required for webpush')
      }
      return new WebPushService(config.vapidPublicKey, config.vapidPrivateKey, config.vapidSubject)
    case 'fcm':
      // TODO: Implement FCM service
      throw new Error('FCM service not implemented yet')
    default:
      throw new Error(`Unknown push provider: ${provider}`)
  }
}
