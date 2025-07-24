import type {
  CustomDurableObjectNamespace,
  D1Database,
  ExecutionContext,
  TableDataResult,
} from '../types/cloudflare'
import type { WhereClause } from '../types/database'
import { createTimestamps, getCurrentDateTimeISO } from './datetime-utils'
import { HookManager } from './hook-manager'
import {
  createColumnList,
  validateAndEscapeColumnName,
  validateAndEscapeTableName,
  validateNotSystemTable,
} from './sql-utils'
import { SYSTEM_TABLES } from './table-manager'

interface DataManagerEnvironment {
  REALTIME?: CustomDurableObjectNamespace
  WORKER_DOMAIN?: string
}

export class DataManager {
  private hookManager: HookManager

  constructor(
    private db: D1Database,
    private env?: DataManagerEnvironment,
    private executionCtx?: ExecutionContext
  ) {
    this.hookManager = new HookManager(db, env?.WORKER_DOMAIN)
  }

  private async enableForeignKeys(): Promise<void> {
    try {
      await this.db.prepare('PRAGMA foreign_keys = ON').run()
    } catch (error) {
      console.warn('Failed to enable foreign keys:', error)
    }
  }

  // Create a record in a table
  async createRecord(tableName: string, data: Record<string, unknown>): Promise<void> {
    await this.enableForeignKeys()

    // Verify foreign keys are enabled
    const _pragmaResult = await this.db.prepare('PRAGMA foreign_keys').first()

    // Validate table name and check if it's a system table
    validateNotSystemTable(tableName, SYSTEM_TABLES)
    const safeTableName = validateAndEscapeTableName(tableName)

    // Add timestamps if not provided
    const dataWithTimestamps = { ...data }
    const timestamps = createTimestamps()
    if (!dataWithTimestamps.created_at) {
      dataWithTimestamps.created_at = timestamps.created_at
    }
    if (!dataWithTimestamps.updated_at) {
      dataWithTimestamps.updated_at = timestamps.updated_at
    }

    // Build INSERT statement
    const columns = Object.keys(dataWithTimestamps)
    const values = Object.values(dataWithTimestamps)
    const placeholders = columns.map(() => '?').join(', ')
    const safeColumns = createColumnList(columns)

    const sql = `INSERT INTO ${safeTableName} (${safeColumns}) VALUES (${placeholders})`

    await this.db
      .prepare(sql)
      .bind(...(values as (string | number | boolean | null)[]))
      .run()
  }

  // Delete a record from a table
  async deleteRecord(tableName: string, id: string): Promise<void> {
    await this.enableForeignKeys()

    // Validate table name and check if it's a system table
    validateNotSystemTable(tableName, SYSTEM_TABLES)
    const safeTableName = validateAndEscapeTableName(tableName)

    // Get record data before deletion for hooks
    const record = await this.db
      .prepare(`SELECT * FROM ${safeTableName} WHERE id = ?`)
      .bind(id)
      .first()

    await this.db.prepare(`DELETE FROM ${safeTableName} WHERE id = ?`).bind(id).run()

    // Process hooks after successful delete
    if (record) {
      await this.hookManager.processDataEvent(
        tableName,
        id,
        'delete',
        record as Record<string, unknown>,
        {
          env: this.env,
          executionCtx: this.executionCtx,
        }
      )
    }
  }

  // Get data from any table
  async getTableData(tableName: string, limit = 100, offset = 0): Promise<TableDataResult> {
    const safeTableName = validateAndEscapeTableName(tableName)
    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as total FROM ${safeTableName}`)
      .first()

    // Check if table has created_at column for ordering
    const columns = await this.getTableColumns(tableName)
    const hasCreatedAt = columns.some((col) => col.name === 'created_at')

    let orderClause = ''
    if (hasCreatedAt) {
      orderClause = 'ORDER BY created_at DESC'
    } else {
      // For tables without created_at, use ROWID if available
      orderClause = 'ORDER BY ROWID'
    }

    const dataResult = await this.db
      .prepare(`SELECT * FROM ${safeTableName} ${orderClause} LIMIT ? OFFSET ?`)
      .bind(limit, offset)
      .all()

    return {
      data: dataResult.results as Record<string, unknown>[],
      total: (countResult as { total: number })?.total || 0,
    }
  }

  // Get data from table with custom sorting
  async getTableDataWithSort(
    tableName: string,
    limit = 100,
    offset = 0,
    sortBy?: string,
    sortOrder: 'ASC' | 'DESC' = 'DESC'
  ): Promise<TableDataResult> {
    return this.getTableDataWithSortAndFilter(tableName, limit, offset, sortBy, sortOrder)
  }

  // Get data from table with custom sorting and WHERE filtering
  async getTableDataWithSortAndFilter(
    tableName: string,
    limit = 100,
    offset = 0,
    sortBy?: string,
    sortOrder: 'ASC' | 'DESC' = 'DESC',
    whereClause?: WhereClause
  ): Promise<TableDataResult> {
    const safeTableName = validateAndEscapeTableName(tableName)

    // Build WHERE clause
    let whereSQL = ''
    const bindParams: Array<string | number | boolean | null> = []

    if (whereClause && Object.keys(whereClause).length > 0) {
      const conditions: string[] = []

      for (const [key, value] of Object.entries(whereClause)) {
        const safeColumn = validateAndEscapeColumnName(key)
        conditions.push(`${safeColumn} = ?`)
        bindParams.push(value)
      }

      whereSQL = ` WHERE ${conditions.join(' AND ')}`
    }

    // Count total with filters
    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as total FROM ${safeTableName}${whereSQL}`)
      .bind(...bindParams)
      .first()

    // Determine sortBy if not provided
    if (!sortBy) {
      const columns = await this.getTableColumns(tableName)
      const hasCreatedAt = columns.some((col) => col.name === 'created_at')
      sortBy = hasCreatedAt ? 'created_at' : 'ROWID'
    }

    // Validate sortBy column name if provided
    const safeSortBy = sortBy && sortBy !== 'ROWID' ? validateAndEscapeColumnName(sortBy) : sortBy

    // Query data with filters and pagination
    const dataResult = await this.db
      .prepare(
        `SELECT * FROM ${safeTableName}${whereSQL} ORDER BY ${safeSortBy === 'ROWID' ? 'ROWID' : safeSortBy} ${sortOrder} LIMIT ? OFFSET ?`
      )
      .bind(...bindParams, limit, offset)
      .all()

    return {
      data: (dataResult.results as Array<Record<string, unknown>>) || [],
      total: (countResult as { total: number })?.total || 0,
    }
  }

  // Get table data with access control for user tables
  async getTableDataWithAccessControl(
    tableName: string,
    accessPolicy: 'public' | 'private',
    userId?: string,
    limit = 100,
    offset = 0,
    sortBy?: string,
    sortOrder: 'ASC' | 'DESC' = 'DESC'
  ): Promise<TableDataResult> {
    const safeTableName = validateAndEscapeTableName(tableName)

    // Build WHERE clause for private tables
    let whereClause = ''
    let countWhereClause = ''
    const bindings: (string | number | boolean | null)[] = []

    if (accessPolicy === 'private' && userId) {
      whereClause = ' WHERE owner_id = ?'
      countWhereClause = ' WHERE owner_id = ?'
      bindings.push(userId)
    }

    // Get total count with access control
    const countSql = `SELECT COUNT(*) as total FROM ${safeTableName}${countWhereClause}`
    const countResult = await this.db
      .prepare(countSql)
      .bind(...bindings)
      .first()

    // Determine sortBy if not provided
    if (!sortBy) {
      const columns = await this.getTableColumns(tableName)
      const hasCreatedAt = columns.some((col) => col.name === 'created_at')
      sortBy = hasCreatedAt ? 'created_at' : 'ROWID'
    }

    // Validate sortBy column name if provided
    const safeSortBy = sortBy && sortBy !== 'ROWID' ? validateAndEscapeColumnName(sortBy) : sortBy

    // Get data with access control and sorting
    const dataSql = `SELECT * FROM ${safeTableName}${whereClause} ORDER BY ${safeSortBy === 'ROWID' ? 'ROWID' : safeSortBy} ${sortOrder} LIMIT ? OFFSET ?`
    const dataBindings = [...bindings, limit, offset]

    const dataResult = await this.db
      .prepare(dataSql)
      .bind(...dataBindings)
      .all()

    return {
      data: dataResult.results as Record<string, unknown>[],
      total: (countResult as { total: number })?.total || 0,
    }
  }

  // Get table data with access control and WHERE filtering
  async getTableDataWithAccessControlAndFilter(
    tableName: string,
    accessPolicy: 'public' | 'private',
    userId?: string,
    limit = 100,
    offset = 0,
    sortBy?: string,
    sortOrder: 'ASC' | 'DESC' = 'DESC',
    whereClause?: WhereClause
  ): Promise<TableDataResult> {
    const safeTableName = validateAndEscapeTableName(tableName)

    // Build WHERE clause combining access control and user filters
    const conditions: string[] = []
    const bindings: (string | number | boolean | null)[] = []

    // Add access control condition for private tables
    if (accessPolicy === 'private' && userId) {
      conditions.push('owner_id = ?')
      bindings.push(userId)
    }

    // Add user-provided WHERE conditions
    if (whereClause && Object.keys(whereClause).length > 0) {
      for (const [key, value] of Object.entries(whereClause)) {
        const safeColumn = validateAndEscapeColumnName(key)
        conditions.push(`${safeColumn} = ?`)
        bindings.push(value)
      }
    }

    const whereSQL = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''

    // Get total count with access control and filters
    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as total FROM ${safeTableName}${whereSQL}`)
      .bind(...bindings)
      .first()

    // Determine sortBy if not provided
    if (!sortBy) {
      const columns = await this.getTableColumns(tableName)
      const hasCreatedAt = columns.some((col) => col.name === 'created_at')
      sortBy = hasCreatedAt ? 'created_at' : 'ROWID'
    }

    // Validate sortBy column name if provided
    const safeSortBy = sortBy && sortBy !== 'ROWID' ? validateAndEscapeColumnName(sortBy) : sortBy

    // Get data with access control, filters and sorting
    const dataResult = await this.db
      .prepare(
        `SELECT * FROM ${safeTableName}${whereSQL} ORDER BY ${safeSortBy === 'ROWID' ? 'ROWID' : safeSortBy} ${sortOrder} LIMIT ? OFFSET ?`
      )
      .bind(...bindings, limit, offset)
      .all()

    return {
      data: dataResult.results as Record<string, unknown>[],
      total: (countResult as { total: number })?.total || 0,
    }
  }

  // Get single record by ID
  async getRecordById(tableName: string, id: string): Promise<Record<string, unknown> | null> {
    const safeTableName = validateAndEscapeTableName(tableName)
    const result = await this.db
      .prepare(`SELECT * FROM ${safeTableName} WHERE id = ? LIMIT 1`)
      .bind(id)
      .first()

    return (result as Record<string, unknown>) || null
  }

  // Get single record by ID with access control
  async getRecordByIdWithAccessControl(
    tableName: string,
    id: string,
    accessPolicy: 'public' | 'private',
    userId?: string
  ): Promise<Record<string, unknown> | null> {
    let whereClause = 'WHERE id = ?'
    const bindings: (string | number | boolean | null)[] = [id]

    if (accessPolicy === 'private' && userId) {
      whereClause += ' AND owner_id = ?'
      bindings.push(userId)
    }

    const safeTableName = validateAndEscapeTableName(tableName)
    const result = await this.db
      .prepare(`SELECT * FROM ${safeTableName} ${whereClause} LIMIT 1`)
      .bind(...bindings)
      .first()

    return (result as Record<string, unknown>) || null
  }

  // Check if table has a specific column
  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    try {
      const columns = await this.getTableColumns(tableName)
      return columns.some((col) => col.name === columnName)
    } catch (error) {
      console.error(`Error checking column ${columnName} in table ${tableName}:`, error)
      return false
    }
  }

  // Create record and return the generated ID
  async createRecordWithId(tableName: string, data: Record<string, unknown>): Promise<string> {
    await this.enableForeignKeys()

    // Validate table name and check if it's a system table
    validateNotSystemTable(tableName, SYSTEM_TABLES)
    const safeTableName = validateAndEscapeTableName(tableName)

    // Generate ID if not provided
    const id = (data.id as string) || this.generateId()
    const dataWithId = { ...data, id } as Record<string, unknown>

    // Add timestamps if not provided
    const timestamps = createTimestamps()
    if (!dataWithId.created_at) {
      dataWithId.created_at = timestamps.created_at
    }
    if (!dataWithId.updated_at) {
      dataWithId.updated_at = timestamps.updated_at
    }

    // Build INSERT statement
    const columns = Object.keys(dataWithId)
    const values = Object.values(dataWithId)
    const placeholders = columns.map(() => '?').join(', ')
    const safeColumns = createColumnList(columns)

    const sql = `INSERT INTO ${safeTableName} (${safeColumns}) VALUES (${placeholders})`

    await this.db
      .prepare(sql)
      .bind(...(values as (string | number | boolean | null)[]))
      .run()

    // Process hooks after successful insert
    console.log(`[DATA-MANAGER] ===== About to process insert hooks =====`)
    console.log(`[DATA-MANAGER] Table: ${tableName}, ID: ${id}`)
    console.log(`[DATA-MANAGER] DataWithId:`, JSON.stringify(dataWithId, null, 2))
    console.log(`[DATA-MANAGER] Env:`, this.env ? 'available' : 'not available')
    console.log(`[DATA-MANAGER] ExecutionCtx:`, this.executionCtx ? 'available' : 'not available')

    await this.hookManager.processDataEvent(tableName, id as string, 'insert', dataWithId, {
      env: this.env,
      executionCtx: this.executionCtx,
    })
    console.log(
      `[DATA-MANAGER] ===== Insert hooks processing completed for ${tableName}:${id} =====`
    )

    return id as string
  }

  // Create record with access control (auto-set owner_id for private tables)
  async createRecordWithAccessControl(
    tableName: string,
    data: Record<string, unknown>,
    accessPolicy: 'public' | 'private',
    userId?: string
  ): Promise<string> {
    await this.enableForeignKeys()

    // Validate table name and check if it's a system table
    validateNotSystemTable(tableName, SYSTEM_TABLES)
    const safeTableName = validateAndEscapeTableName(tableName)

    // Generate ID if not provided
    const id = (data.id as string) || this.generateId()
    const dataWithId = { ...data, id } as Record<string, unknown>

    // Add owner_id for private tables
    if (accessPolicy === 'private' && userId) {
      dataWithId.owner_id = userId
    }

    // Add timestamps if not provided
    const timestamps = createTimestamps()
    if (!dataWithId.created_at) {
      dataWithId.created_at = timestamps.created_at
    }
    if (!dataWithId.updated_at) {
      dataWithId.updated_at = timestamps.updated_at
    }

    // Build INSERT statement
    const columns = Object.keys(dataWithId)
    const values = Object.values(dataWithId)
    const placeholders = columns.map(() => '?').join(', ')
    const safeColumns = createColumnList(columns)

    const sql = `INSERT INTO ${safeTableName} (${safeColumns}) VALUES (${placeholders})`

    await this.db
      .prepare(sql)
      .bind(...(values as (string | number | boolean | null)[]))
      .run()

    // Process hooks after successful insert
    console.log(`[DATA-MANAGER] ===== About to process insert hooks =====`)
    console.log(`[DATA-MANAGER] Table: ${tableName}, ID: ${id}`)
    console.log(`[DATA-MANAGER] DataWithId:`, JSON.stringify(dataWithId, null, 2))
    console.log(`[DATA-MANAGER] Env:`, this.env ? 'available' : 'not available')
    console.log(`[DATA-MANAGER] ExecutionCtx:`, this.executionCtx ? 'available' : 'not available')

    await this.hookManager.processDataEvent(tableName, id as string, 'insert', dataWithId, {
      env: this.env,
      executionCtx: this.executionCtx,
    })
    console.log(
      `[DATA-MANAGER] ===== Insert hooks processing completed for ${tableName}:${id} =====`
    )

    return id as string
  }

  // Update record
  async updateRecord(tableName: string, id: string, data: Record<string, unknown>): Promise<void> {
    await this.enableForeignKeys()

    // Validate table name and check if it's a system table
    validateNotSystemTable(tableName, SYSTEM_TABLES)
    const safeTableName = validateAndEscapeTableName(tableName)

    // Remove system fields from update data
    const updateData = { ...data }
    delete updateData.id
    delete updateData.created_at

    // Add updated_at timestamp
    updateData.updated_at = getCurrentDateTimeISO()

    const columns = Object.keys(updateData)
    const values = Object.values(updateData)
    const safeColumns = columns.map((col) => validateAndEscapeColumnName(col))
    const setClause = safeColumns.map((col) => `${col} = ?`).join(', ')

    const sql = `UPDATE ${safeTableName} SET ${setClause} WHERE id = ?`

    const _result = await this.db
      .prepare(sql)
      .bind(...(values as (string | number | boolean | null)[]), id)
      .run()

    // Process hooks after successful update
    console.log(`[DATA-MANAGER] Processing update hook for table: ${tableName}, id: ${id}`)
    await this.hookManager.processDataEvent(tableName, id, 'update', updateData, {
      env: this.env,
      executionCtx: this.executionCtx,
    })
    console.log(`[DATA-MANAGER] Update hook processing completed for ${tableName}:${id}`)
  }

  // Update record with access control
  async updateRecordWithAccessControl(
    tableName: string,
    id: string,
    data: Record<string, unknown>,
    accessPolicy: 'public' | 'private',
    userId?: string
  ): Promise<void> {
    await this.enableForeignKeys()

    // Validate table name and check if it's a system table
    validateNotSystemTable(tableName, SYSTEM_TABLES)
    const safeTableName = validateAndEscapeTableName(tableName)

    // Remove system fields from update data
    const updateData = { ...data }
    delete updateData.id
    delete updateData.created_at
    delete updateData.owner_id // Don't allow changing ownership

    // Add updated_at timestamp
    updateData.updated_at = getCurrentDateTimeISO()

    const columns = Object.keys(updateData)
    const values = Object.values(updateData)
    const safeColumns = columns.map((col) => validateAndEscapeColumnName(col))
    const setClause = safeColumns.map((col) => `${col} = ?`).join(', ')

    let whereClause = 'WHERE id = ?'
    const bindings: (string | number | boolean | null)[] = [
      ...(values as (string | number | boolean | null)[]),
      id,
    ]

    // Additional access control for private tables
    if (accessPolicy === 'private' && userId) {
      whereClause += ' AND owner_id = ?'
      bindings.push(userId)
    }

    const sql = `UPDATE ${safeTableName} SET ${setClause} ${whereClause}`

    const result = await this.db
      .prepare(sql)
      .bind(...bindings)
      .run()

    // Check if any rows were affected (record existed and was owned by user)
    // Note: D1's result.meta contains the changes count
    if (result.meta && 'changes' in result.meta && result.meta.changes === 0) {
      throw new Error('Record not found')
    }

    // Process hooks after successful update
    console.log(`[DATA-MANAGER] Processing update hook for table: ${tableName}, id: ${id}`)
    await this.hookManager.processDataEvent(tableName, id, 'update', updateData, {
      env: this.env,
      executionCtx: this.executionCtx,
    })
    console.log(`[DATA-MANAGER] Update hook processing completed for ${tableName}:${id}`)
  }

  // Delete record with access control
  async deleteRecordWithAccessControl(
    tableName: string,
    id: string,
    accessPolicy: 'public' | 'private',
    userId?: string
  ): Promise<void> {
    await this.enableForeignKeys()

    // Validate table name and check if it's a system table
    validateNotSystemTable(tableName, SYSTEM_TABLES)
    const safeTableName = validateAndEscapeTableName(tableName)

    // Get record data before deletion for hooks and access control
    let whereClause = 'WHERE id = ?'
    const bindings: (string | number | boolean | null)[] = [id]

    if (accessPolicy === 'private' && userId) {
      whereClause += ' AND owner_id = ?'
      bindings.push(userId)
    }

    const record = await this.db
      .prepare(`SELECT * FROM ${safeTableName} ${whereClause}`)
      .bind(...bindings)
      .first()

    if (!record) {
      throw new Error('Record not found or access denied')
    }

    // Delete the record
    await this.db
      .prepare(`DELETE FROM ${safeTableName} ${whereClause}`)
      .bind(...bindings)
      .run()

    // Process hooks after successful delete
    await this.hookManager.processDataEvent(
      tableName,
      id,
      'delete',
      record as Record<string, unknown>,
      {
        env: this.env,
        executionCtx: this.executionCtx,
      }
    )
  }

  // Generate unique ID (similar to what SQLite's randomblob would generate)
  private generateId(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36)
  }

  // Helper method to get table columns (simplified version)
  private async getTableColumns(tableName: string): Promise<{ name: string }[]> {
    const safeTableName = validateAndEscapeTableName(tableName)
    const result = await this.db.prepare(`PRAGMA table_info(${safeTableName})`).all()

    return (result.results as unknown[]).map((col) => ({
      name: (col as Record<string, unknown>).name as string,
    }))
  }
}
