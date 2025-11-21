import { beforeEach, describe, expect, it } from 'vitest'
import { SchemaManager } from '../../lib/schema-manager'
import { SchemaSnapshotManager, type TableSchema } from '../../lib/schema-snapshot'
import { createMockD1Database } from '../setup'

describe('Schema Migration', () => {
  let db: ReturnType<typeof createMockD1Database>
  let snapshotManager: SchemaSnapshotManager
  let schemaManager: SchemaManager

  beforeEach(async () => {
    db = createMockD1Database()
    snapshotManager = new SchemaSnapshotManager(db)

    // Initialize snapshot tables
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_snapshots (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        table_name TEXT,
        schema_json TEXT,
        name TEXT,
        description TEXT,
        full_schema TEXT,
        tables_json TEXT,
        schema_hash TEXT,
        created_at TEXT,
        created_by TEXT,
        snapshot_type TEXT,
        d1_bookmark_id TEXT
      )
    `)

    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_snapshot_counter (
        id TEXT PRIMARY KEY,
        current_version INTEGER DEFAULT 0,
        updated_at TEXT
      )
    `)

    const createAsyncSnapshot = () => {}
    schemaManager = new SchemaManager(db, snapshotManager, createAsyncSnapshot)
  })

  describe('applySchemaMigration', () => {
    it('should create new tables that do not exist', async () => {
      const targetSchema: TableSchema[] = [
        {
          name: 'users',
          sql: `CREATE TABLE users (
            id TEXT PRIMARY KEY,
            name TEXT,
            email TEXT,
            created_at DATETIME,
            updated_at DATETIME
          )`,
          columns: [
            { cid: 0, name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
            { cid: 1, name: 'name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
            { cid: 2, name: 'email', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
            { cid: 3, name: 'created_at', type: 'DATETIME', notnull: 0, dflt_value: null, pk: 0 },
            { cid: 4, name: 'updated_at', type: 'DATETIME', notnull: 0, dflt_value: null, pk: 0 },
          ],
          foreignKeys: [],
          indexes: [],
        },
      ]

      await schemaManager.applySchemaMigration(targetSchema)

      // Verify table was created
      const tableExists = await db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`)
        .first()

      expect(tableExists).toBeTruthy()
    })

    it('should add missing columns to existing tables', async () => {
      // Create initial table
      await db.exec(`
        CREATE TABLE posts (
          id TEXT PRIMARY KEY,
          title TEXT,
          created_at DATETIME,
          updated_at DATETIME
        )
      `)

      const targetSchema: TableSchema[] = [
        {
          name: 'posts',
          sql: `CREATE TABLE posts (
            id TEXT PRIMARY KEY,
            title TEXT,
            content TEXT,
            status TEXT,
            created_at DATETIME,
            updated_at DATETIME
          )`,
          columns: [
            { cid: 0, name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
            { cid: 1, name: 'title', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
            { cid: 2, name: 'content', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
            { cid: 3, name: 'status', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
            { cid: 4, name: 'created_at', type: 'DATETIME', notnull: 0, dflt_value: null, pk: 0 },
            { cid: 5, name: 'updated_at', type: 'DATETIME', notnull: 0, dflt_value: null, pk: 0 },
          ],
          foreignKeys: [],
          indexes: [],
        },
      ]

      await schemaManager.applySchemaMigration(targetSchema)

      // Verify new columns were added
      const columns = await db.prepare(`PRAGMA table_info(posts)`).all<{ name: string }>()
      const columnNames = columns.results.map((col) => col.name)

      expect(columnNames).toContain('content')
      expect(columnNames).toContain('status')
    })

    it('should NOT drop existing columns (non-destructive)', async () => {
      // Create table with extra column
      await db.exec(`
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          name TEXT,
          deprecated_field TEXT,
          created_at DATETIME,
          updated_at DATETIME
        )
      `)

      const targetSchema: TableSchema[] = [
        {
          name: 'items',
          sql: `CREATE TABLE items (
            id TEXT PRIMARY KEY,
            name TEXT,
            created_at DATETIME,
            updated_at DATETIME
          )`,
          columns: [
            { cid: 0, name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
            { cid: 1, name: 'name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
            { cid: 2, name: 'created_at', type: 'DATETIME', notnull: 0, dflt_value: null, pk: 0 },
            { cid: 3, name: 'updated_at', type: 'DATETIME', notnull: 0, dflt_value: null, pk: 0 },
          ],
          foreignKeys: [],
          indexes: [],
        },
      ]

      await schemaManager.applySchemaMigration(targetSchema)

      // Verify deprecated_field still exists
      const columns = await db.prepare(`PRAGMA table_info(items)`).all<{ name: string }>()
      const columnNames = columns.results.map((col) => col.name)

      expect(columnNames).toContain('deprecated_field')
    })

    it('should NOT drop existing tables (non-destructive)', async () => {
      // Create a table
      await db.exec(`
        CREATE TABLE legacy_data (
          id TEXT PRIMARY KEY,
          data TEXT
        )
      `)

      const targetSchema: TableSchema[] = []

      await schemaManager.applySchemaMigration(targetSchema)

      // Verify legacy_data still exists
      const tableExists = await db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_data'`)
        .first()

      expect(tableExists).toBeTruthy()
    })
  })
})
