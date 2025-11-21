import { beforeEach, describe, expect, it } from 'vitest'
import { type DataEvent, EventBus } from '../../lib/event-bus'

describe('EventBus', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  describe('subscribe and publish', () => {
    it('should notify subscribers when an event is published', async () => {
      const events: DataEvent[] = []

      eventBus.subscribe((event) => {
        events.push(event)
      })

      await eventBus.publish({
        table: 'posts',
        action: 'insert',
        recordId: '123',
        data: { title: 'Test Post' },
        userId: 'user1',
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        table: 'posts',
        action: 'insert',
        recordId: '123',
      })
    })

    it('should support multiple subscribers', async () => {
      const events1: DataEvent[] = []
      const events2: DataEvent[] = []

      eventBus.subscribe((event) => {
        events1.push(event)
      })

      eventBus.subscribe((event) => {
        events2.push(event)
      })

      await eventBus.publish({
        table: 'posts',
        action: 'update',
        recordId: '456',
        data: { title: 'Updated' },
      })

      expect(events1).toHaveLength(1)
      expect(events2).toHaveLength(1)
    })

    it('should handle async subscribers', async () => {
      let callCount = 0

      eventBus.subscribe(async (_event) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        callCount++
      })

      await eventBus.publish({
        table: 'posts',
        action: 'delete',
        recordId: '789',
        data: {},
      })

      expect(callCount).toBe(1)
    })

    it('should allow unsubscribing', async () => {
      const events: DataEvent[] = []

      const unsubscribe = eventBus.subscribe((event) => {
        events.push(event)
      })

      await eventBus.publish({
        table: 'posts',
        action: 'insert',
        recordId: '1',
        data: {},
      })

      expect(events).toHaveLength(1)

      unsubscribe()

      await eventBus.publish({
        table: 'posts',
        action: 'insert',
        recordId: '2',
        data: {},
      })

      expect(events).toHaveLength(1) // Still 1, not 2
    })

    it('should continue with other subscribers if one throws an error', async () => {
      const events: DataEvent[] = []

      eventBus.subscribe(() => {
        throw new Error('Subscriber error')
      })

      eventBus.subscribe((event) => {
        events.push(event)
      })

      await eventBus.publish({
        table: 'posts',
        action: 'insert',
        recordId: '123',
        data: {},
      })

      expect(events).toHaveLength(1)
    })
  })

  describe('event types', () => {
    it('should handle insert events', async () => {
      const events: DataEvent[] = []

      eventBus.subscribe((event) => {
        if (event.action === 'insert') {
          events.push(event)
        }
      })

      await eventBus.publish({
        table: 'posts',
        action: 'insert',
        recordId: '123',
        data: { title: 'New Post' },
      })

      await eventBus.publish({
        table: 'posts',
        action: 'update',
        recordId: '123',
        data: { title: 'Updated Post' },
      })

      expect(events).toHaveLength(1)
      expect(events[0].action).toBe('insert')
    })

    it('should include userId when provided', async () => {
      const events: DataEvent[] = []

      eventBus.subscribe((event) => {
        events.push(event)
      })

      await eventBus.publish({
        table: 'posts',
        action: 'insert',
        recordId: '123',
        data: {},
        userId: 'user1',
      })

      expect(events[0].userId).toBe('user1')
    })

    it('should allow undefined userId for anonymous operations', async () => {
      const events: DataEvent[] = []

      eventBus.subscribe((event) => {
        events.push(event)
      })

      await eventBus.publish({
        table: 'posts',
        action: 'insert',
        recordId: '123',
        data: {},
      })

      expect(events[0].userId).toBeUndefined()
    })
  })
})
