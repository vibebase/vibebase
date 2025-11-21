import type {
  CustomDurableObjectNamespace,
  D1Database,
  ExecutionContext,
  TableDataResult,
} from '../types/cloudflare'
import { DataManager } from './data-manager'
import { ErrorHandler } from './error-handler'
import { SYSTEM_TABLES } from './table-operations'
import { generateId } from './utils'

interface TableAccessControllerEnvironment {
  REALTIME?: CustomDurableObjectNamespace
  WORKER_DOMAIN?: string
}

/**
 * Handles table access control and user-specific data operations
 */
export class TableAccessController {
  private errorHandler: ErrorHandler
  private dataManager: DataManager

  constructor(
    private db: D1Database,
    private env?: TableAccessControllerEnvironment,
    private executionCtx?: ExecutionContext
  ) {
    this.errorHandler = ErrorHandler.getInstance()
    this.dataManager = new DataManager(db, env, executionCtx)
  }

  /**
   * Get table data with access control
   */
  async getTableDataWithAccessControl(
    tableName: string,
    userId?: string,
    limit = 100,
    offset = 0,
    sortBy?: string,
    sortOrder: 'ASC' | 'DESC' = 'DESC'
  ): Promise<TableDataResult> {
    // Get access policy for the table
    const accessPolicy = await this.getTableAccessPolicy(tableName)

    return this.dataManager.getTableDataWithAccessControl(
      tableName,
      accessPolicy,
      userId,
      limit,
      offset,
      sortBy,
      sortOrder
    )
  }

  /**
   * Get single record by ID with access control
   */
  async getRecordByIdWithAccessControl(
    tableName: string,
    id: string,
    userId?: string
  ): Promise<Record<string, unknown> | null> {
    // Get access policy for the table
    const accessPolicy = await this.getTableAccessPolicy(tableName)

    return this.dataManager.getRecordByIdWithAccessControl(tableName, id, accessPolicy, userId)
  }

  /**
   * Create record with access control (auto-set owner_id for private tables)
   */
  async createRecordWithAccessControl(
    tableName: string,
    data: Record<string, unknown>,
    userId?: string
  ): Promise<string> {
    // Get access policy for the table
    const accessPolicy = await this.getTableAccessPolicy(tableName)

    if (accessPolicy === 'private' && !userId) {
      throw new Error('Access denied: Cannot create record in private table without authentication')
    }

    return this.dataManager.createRecordWithAccessControl(tableName, data, accessPolicy, userId)
  }

  /**
   * Update record with access control
   */
  async updateRecordWithAccessControl(
    tableName: string,
    id: string,
    data: Record<string, unknown>,
    userId?: string
  ): Promise<void> {
    // Get access policy for the table
    const accessPolicy = await this.getTableAccessPolicy(tableName)

    return this.dataManager.updateRecordWithAccessControl(tableName, id, data, accessPolicy, userId)
  }

  /**
   * Delete record with access control
   */
  async deleteRecordWithAccessControl(
    tableName: string,
    id: string,
    userId?: string
  ): Promise<void> {
    // Get access policy for the table
    const accessPolicy = await this.getTableAccessPolicy(tableName)

    return this.dataManager.deleteRecordWithAccessControl(tableName, id, accessPolicy, userId)
  }

  /**
   * Get access policy for a table
   */
  async getTableAccessPolicy(tableName: string): Promise<'public' | 'private'> {
    return this.errorHandler.handleOperation(
      async () => {
        const result = await this.db
          .prepare('SELECT access_policy FROM table_policies WHERE table_name = ?')
          .bind(tableName)
          .first()

        return (result as { access_policy: 'public' | 'private' })?.access_policy || 'private'
      },
      { operationName: 'getTableAccessPolicy', tableName }
    )
  }

  /**
   * Set access policy for a table
   */
  async setTableAccessPolicy(tableName: string, policy: 'public' | 'private'): Promise<void> {
    return this.errorHandler.handleOperation(
      async () => {
        await this.db
          .prepare(`
            INSERT INTO table_policies (id, table_name, access_policy, created_at, updated_at)
            VALUES (?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(table_name) DO UPDATE SET
              access_policy = excluded.access_policy,
              updated_at = excluded.updated_at
          `)
          .bind(generateId(), tableName, policy)
          .run()
      },
      { operationName: 'setTableAccessPolicy', tableName }
    )
  }

  /**
   * Check if user has access to a table based on policy and ownership
   */
  async checkTableAccess(
    tableName: string,
    userId?: string,
    _operation: 'read' | 'write' = 'read'
  ): Promise<{ hasAccess: boolean; reason?: string }> {
    return this.errorHandler.handleOperation(
      async () => {
        const accessPolicy = await this.getTableAccessPolicy(tableName)

        // Public tables allow all operations for all users
        if (accessPolicy === 'public') {
          return { hasAccess: true }
        }

        // Private tables require user authentication
        if (!userId) {
          return { hasAccess: false, reason: 'Authentication required for private table' }
        }

        // For private tables, user has access (ownership is checked at record level)
        return { hasAccess: true }
      },
      { operationName: 'checkTableAccess', tableName }
    )
  }

  /**
   * Check if user owns a specific record (for private tables)
   */
  async checkRecordOwnership(
    tableName: string,
    recordId: string,
    userId: string
  ): Promise<{ isOwner: boolean; reason?: string }> {
    return this.errorHandler.handleOperation(
      async () => {
        const accessPolicy = await this.getTableAccessPolicy(tableName)

        // Public tables don't have ownership restrictions
        if (accessPolicy === 'public') {
          return { isOwner: true }
        }

        // Check if the record belongs to the user
        const record = await this.db
          .prepare(`SELECT owner_id FROM "${tableName}" WHERE id = ?`)
          .bind(recordId)
          .first()

        if (!record) {
          return { isOwner: false, reason: 'Record not found' }
        }

        const ownerId = (record as { owner_id?: string }).owner_id
        if (ownerId === userId) {
          return { isOwner: true }
        }

        return { isOwner: false, reason: 'User does not own this record' }
      },
      { operationName: 'checkRecordOwnership', tableName }
    )
  }

  /**
   * Get all accessible tables for a user
   */
  async getAccessibleTables(userId?: string): Promise<
    Array<{
      name: string
      accessPolicy: 'public' | 'private'
      canRead: boolean
      canWrite: boolean
    }>
  > {
    return this.errorHandler.handleOperation(
      async () => {
        // Get all user tables (non-system tables)
        const tablesResult = await this.db
          .prepare(`
            SELECT name FROM sqlite_master 
            WHERE type='table' 
            AND name NOT LIKE 'sqlite_%' 
            AND name NOT LIKE '_cf_%'
            AND name NOT IN (${SYSTEM_TABLES.map(() => '?').join(',')})
            ORDER BY name
          `)
          .bind(...SYSTEM_TABLES)
          .all()

        const accessibleTables = []

        for (const table of tablesResult.results as { name: string }[]) {
          const accessPolicy = await this.getTableAccessPolicy(table.name)
          const readAccess = await this.checkTableAccess(table.name, userId, 'read')
          const writeAccess = await this.checkTableAccess(table.name, userId, 'write')

          accessibleTables.push({
            name: table.name,
            accessPolicy,
            canRead: readAccess.hasAccess,
            canWrite: writeAccess.hasAccess,
          })
        }

        return accessibleTables
      },
      { operationName: 'getAccessibleTables' }
    )
  }
}
