import { beforeEach, describe, expect, it } from 'vitest'
import { TableManager } from '../lib/table-manager'
import type { D1Database, ExecutionContext, R2Bucket } from '../types/cloudflare'
import { createMockD1Database, createMockExecutionContext, createMockR2Bucket } from './setup'

describe('RBAC Matrix Tests', () => {
  let tm: TableManager
  let mockDb: D1Database
  let mockStorage: R2Bucket
  let mockCtx: ExecutionContext

  const ADMIN_ID = 'admin-id'
  const USER_ID = 'user-id'
  const OTHER_USER_ID = 'other-user-id'

  beforeEach(async () => {
    mockDb = createMockD1Database() as unknown as D1Database
    mockStorage = createMockR2Bucket() as unknown as R2Bucket
    mockCtx = createMockExecutionContext() as unknown as ExecutionContext

    tm = new TableManager(mockDb, mockStorage, mockCtx, { REALTIME: undefined })

    // Initialize DB with necessary tables
    // 1. table_policies
    await mockDb
      .prepare(`
      CREATE TABLE table_policies (
        id TEXT PRIMARY KEY,
        table_name TEXT UNIQUE,
        access_policy TEXT,
        created_at DATETIME,
        updated_at DATETIME
      )
    `)
      .run()

    // 2. posts table for testing
    await mockDb
      .prepare(`
      CREATE TABLE posts (
        id TEXT PRIMARY KEY,
        title TEXT,
        owner_id TEXT,
        created_at DATETIME,
        updated_at DATETIME
      )
    `)
      .run()
  })

  async function checkPermission(
    role: 'admin' | 'user' | 'anon',
    resource: string,
    action: 'create' | 'read' | 'update' | 'delete',
    owner: 'self' | 'other' | 'any',
    isPublic: boolean = false
  ): Promise<boolean> {
    // Set policy
    await tm.setTableAccessPolicy(resource, isPublic ? 'public' : 'private')

    // Prepare data
    const recordId = 'test-record-id'
    const ownerId = owner === 'self' ? USER_ID : OTHER_USER_ID

    // Clean up and insert a fresh record for read/update/delete
    if (action !== 'create') {
      await mockDb.prepare(`DELETE FROM ${resource}`).run()
      await mockDb
        .prepare(`
            INSERT INTO ${resource} (id, title, owner_id) VALUES (?, ?, ?)
        `)
        .bind(recordId, 'Test Post', ownerId)
        .run()
    }

    // Determine current user
    let currentUser: string | undefined
    let _authType: 'admin' | 'user' | 'api_key' | undefined

    if (role === 'admin') {
      _authType = 'admin'
      currentUser = ADMIN_ID
    } else if (role === 'user') {
      _authType = 'user'
      currentUser = USER_ID
    } else {
      _authType = undefined
      currentUser = undefined
    }

    try {
      if (role === 'admin') {
        switch (action) {
          case 'create':
            await tm.createRecordWithId(resource, { id: 'new-id', title: 'New' })
            break
          case 'read': {
            const r = await tm.getRecordById(resource, recordId)
            if (!r) throw new Error('Not found')
            break
          }
          case 'update':
            await tm.updateRecord(resource, recordId, { title: 'Updated' })
            break
          case 'delete':
            await tm.deleteRecord(resource, recordId)
            break
        }
      } else if (role === 'user') {
        switch (action) {
          case 'create':
            await tm.createRecordWithAccessControl(resource, { title: 'New' }, currentUser)
            break
          case 'read': {
            const r = await tm.getRecordByIdWithAccessControl(resource, recordId, currentUser)
            if (!r) throw new Error('Not found')
            break
          }
          case 'update':
            await tm.updateRecordWithAccessControl(
              resource,
              recordId,
              { title: 'Updated' },
              currentUser
            )
            break
          case 'delete':
            await tm.deleteRecordWithAccessControl(resource, recordId, currentUser)
            break
        }
      } else {
        // Anon
        switch (action) {
          case 'create':
            await tm.createRecordWithAccessControl(resource, { title: 'New' }, undefined)
            break
          case 'read': {
            const r = await tm.getRecordByIdWithAccessControl(resource, recordId, undefined)
            if (!r) throw new Error('Not found')
            break
          }
          case 'update':
            await tm.updateRecordWithAccessControl(
              resource,
              recordId,
              { title: 'Updated' },
              undefined
            )
            break
          case 'delete':
            await tm.deleteRecordWithAccessControl(resource, recordId, undefined)
            break
        }
      }
      return true
    } catch (_e) {
      return false
    }
  }

  type TestCase = {
    role: 'admin' | 'user' | 'anon'
    resource: string
    action: 'create' | 'read' | 'update' | 'delete'
    owner: 'self' | 'other' | 'any'
    isPublic: boolean
    allow: boolean
    desc: string
  }

  const cases: TestCase[] = [
    // Admin
    {
      role: 'admin',
      resource: 'posts',
      action: 'create',
      owner: 'any',
      isPublic: false,
      allow: true,
      desc: 'Admin can create',
    },
    {
      role: 'admin',
      resource: 'posts',
      action: 'read',
      owner: 'other',
      isPublic: false,
      allow: true,
      desc: 'Admin can read any',
    },
    {
      role: 'admin',
      resource: 'posts',
      action: 'update',
      owner: 'other',
      isPublic: false,
      allow: true,
      desc: 'Admin can update any',
    },
    {
      role: 'admin',
      resource: 'posts',
      action: 'delete',
      owner: 'other',
      isPublic: false,
      allow: true,
      desc: 'Admin can delete any',
    },

    // User - Private Table
    {
      role: 'user',
      resource: 'posts',
      action: 'create',
      owner: 'self',
      isPublic: false,
      allow: true,
      desc: 'User can create in private table',
    },
    {
      role: 'user',
      resource: 'posts',
      action: 'read',
      owner: 'self',
      isPublic: false,
      allow: true,
      desc: 'User can read own data',
    },
    {
      role: 'user',
      resource: 'posts',
      action: 'update',
      owner: 'self',
      isPublic: false,
      allow: true,
      desc: 'User can update own data',
    },
    {
      role: 'user',
      resource: 'posts',
      action: 'delete',
      owner: 'self',
      isPublic: false,
      allow: true,
      desc: 'User can delete own data',
    },

    {
      role: 'user',
      resource: 'posts',
      action: 'read',
      owner: 'other',
      isPublic: false,
      allow: false,
      desc: 'User CANNOT read other data in private table',
    },
    {
      role: 'user',
      resource: 'posts',
      action: 'update',
      owner: 'other',
      isPublic: false,
      allow: false,
      desc: 'User CANNOT update other data',
    },
    {
      role: 'user',
      resource: 'posts',
      action: 'delete',
      owner: 'other',
      isPublic: false,
      allow: false,
      desc: 'User CANNOT delete other data',
    },

    // User - Public Table
    {
      role: 'user',
      resource: 'posts',
      action: 'read',
      owner: 'other',
      isPublic: true,
      allow: true,
      desc: 'User can read other data in public table',
    },
    {
      role: 'user',
      resource: 'posts',
      action: 'create',
      owner: 'self',
      isPublic: true,
      allow: true,
      desc: 'User can create in public table',
    },
    {
      role: 'user',
      resource: 'posts',
      action: 'update',
      owner: 'other',
      isPublic: true,
      allow: true,
      desc: 'User can update other data in public table',
    },

    // Anon - Public Table
    {
      role: 'anon',
      resource: 'posts',
      action: 'read',
      owner: 'any',
      isPublic: true,
      allow: true,
      desc: 'Anon can read public table',
    },
    {
      role: 'anon',
      resource: 'posts',
      action: 'create',
      owner: 'any',
      isPublic: true,
      allow: true,
      desc: 'Anon can create in public table',
    },

    // Anon - Private Table
    {
      role: 'anon',
      resource: 'posts',
      action: 'read',
      owner: 'any',
      isPublic: false,
      allow: false,
      desc: 'Anon CANNOT read private table',
    },
    {
      role: 'anon',
      resource: 'posts',
      action: 'create',
      owner: 'any',
      isPublic: false,
      allow: false,
      desc: 'Anon CANNOT create in private table',
    },
  ]

  it.each(cases)('$desc', async ({ role, resource, action, owner, isPublic, allow }) => {
    const result = await checkPermission(role, resource, action, owner, isPublic)
    expect(result).toBe(allow)
  })
})
