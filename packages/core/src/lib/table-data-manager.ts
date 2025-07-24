import type {
  CustomDurableObjectNamespace,
  D1Database,
  ExecutionContext,
  TableDataResult,
} from '../types/cloudflare'
import type { CountResult, IndexColumnInfo, WhereClause } from '../types/database'
import { DataManager } from './data-manager'
import { ErrorHandler } from './error-handler'
import type { IndexInfo } from './index-manager'
import { validateAndEscapeTableName } from './sql-utils'

interface TableDataManagerEnvironment {
  REALTIME?: CustomDurableObjectNamespace
  WORKER_DOMAIN?: string
}

/**
 * Handles table data CRUD operations and search functionality
 */
export class TableDataManager {
  private errorHandler: ErrorHandler
  private dataManager: DataManager

  constructor(
    private db: D1Database,
    private env?: TableDataManagerEnvironment,
    private executionCtx?: ExecutionContext
  ) {
    this.errorHandler = ErrorHandler.getInstance()
    this.dataManager = new DataManager(db, env, executionCtx)
  }

  /**
   * Create a record in a table
   */
  async createRecord(tableName: string, data: Record<string, unknown>): Promise<void> {
    return this.dataManager.createRecord(tableName, data)
  }

  /**
   * Create a record with a specific ID (or let the system generate one)
   */
  async createRecordWithId(tableName: string, data: Record<string, unknown>): Promise<string> {
    return this.dataManager.createRecordWithId(tableName, data)
  }

  /**
   * Create record with access control (auto-set owner_id for private tables)
   */
  async createRecordWithAccessControl(
    tableName: string,
    data: Record<string, unknown>,
    accessPolicy: 'public' | 'private',
    userId?: string
  ): Promise<string> {
    return this.dataManager.createRecordWithAccessControl(tableName, data, accessPolicy, userId)
  }

  /**
   * Update a record in a table
   */
  async updateRecord(tableName: string, id: string, data: Record<string, unknown>): Promise<void> {
    return this.dataManager.updateRecord(tableName, id, data)
  }

  /**
   * Update record with access control
   */
  async updateRecordWithAccessControl(
    tableName: string,
    id: string,
    data: Record<string, unknown>,
    accessPolicy: 'public' | 'private',
    userId?: string
  ): Promise<void> {
    return this.dataManager.updateRecordWithAccessControl(tableName, id, data, accessPolicy, userId)
  }

  /**
   * Delete a record from a table
   */
  async deleteRecord(tableName: string, id: string): Promise<void> {
    return this.dataManager.deleteRecord(tableName, id)
  }

  /**
   * Delete record with access control
   */
  async deleteRecordWithAccessControl(
    tableName: string,
    id: string,
    accessPolicy: 'public' | 'private',
    userId?: string
  ): Promise<void> {
    return this.dataManager.deleteRecordWithAccessControl(tableName, id, accessPolicy, userId)
  }

  /**
   * Get single record by ID
   */
  async getRecordById(tableName: string, id: string): Promise<Record<string, unknown> | null> {
    return this.dataManager.getRecordById(tableName, id)
  }

  /**
   * Get single record by ID with access control
   */
  async getRecordByIdWithAccessControl(
    tableName: string,
    id: string,
    accessPolicy: 'public' | 'private',
    userId?: string
  ): Promise<Record<string, unknown> | null> {
    return this.dataManager.getRecordByIdWithAccessControl(tableName, id, accessPolicy, userId)
  }

  /**
   * Get data from any table
   */
  async getTableData(tableName: string, limit = 100, offset = 0): Promise<TableDataResult> {
    return this.dataManager.getTableData(tableName, limit, offset)
  }

  /**
   * Get data from table with custom sorting
   */
  async getTableDataWithSort(
    tableName: string,
    limit = 100,
    offset = 0,
    sortBy?: string,
    sortOrder: 'ASC' | 'DESC' = 'DESC'
  ): Promise<TableDataResult> {
    return this.dataManager.getTableDataWithSort(tableName, limit, offset, sortBy, sortOrder)
  }

  /**
   * Get data from table with custom sorting and WHERE filtering
   */
  async getTableDataWithSortAndFilter(
    tableName: string,
    limit = 100,
    offset = 0,
    sortBy?: string,
    sortOrder: 'ASC' | 'DESC' = 'DESC',
    whereClause?: WhereClause
  ): Promise<TableDataResult> {
    return this.dataManager.getTableDataWithSortAndFilter(
      tableName,
      limit,
      offset,
      sortBy,
      sortOrder,
      whereClause
    )
  }

  /**
   * Get data from table with access control
   */
  async getTableDataWithAccessControl(
    tableName: string,
    accessPolicy: 'public' | 'private',
    userId?: string,
    limit = 100,
    offset = 0,
    sortBy?: string,
    sortOrder: 'ASC' | 'DESC' = 'DESC'
  ): Promise<TableDataResult> {
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
   * Get data from table with access control and WHERE filtering
   */
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
    return this.dataManager.getTableDataWithAccessControlAndFilter(
      tableName,
      accessPolicy,
      userId,
      limit,
      offset,
      sortBy,
      sortOrder,
      whereClause
    )
  }

  /**
   * Get searchable columns for a table (only indexed TEXT and INTEGER columns)
   */
  async getSearchableColumns(tableName: string): Promise<Array<{ name: string; type: string }>> {
    return this.errorHandler.handleOperation(
      async () => {
        // Get all columns for the table
        const columnsResult = await this.db
          .prepare(`PRAGMA table_info(${validateAndEscapeTableName(tableName)})`)
          .all()

        const columns = columnsResult.results as Array<{
          name: string
          type: string
          notnull: number
          dflt_value: unknown
          pk: number
        }>

        // Get all indexes for the table
        const indexesResult = await this.db
          .prepare(`PRAGMA index_list(${validateAndEscapeTableName(tableName)})`)
          .all()

        const searchableColumns: Array<{ name: string; type: string }> = []

        // Check each index to find indexed columns
        for (const indexRow of indexesResult.results) {
          const index = indexRow as unknown as IndexInfo
          const indexName = index.name

          // Skip SQLite auto-created indexes for primary keys/unique constraints
          if (indexName.startsWith('sqlite_autoindex_')) continue

          // Get columns in this index
          const indexColumnsResult = await this.db
            .prepare(`PRAGMA index_info(${validateAndEscapeTableName(indexName)})`)
            .all()

          for (const indexColumnRow of indexColumnsResult.results) {
            const columnInfo = indexColumnRow as IndexColumnInfo
            const columnName = columnInfo.name
            const column = columns.find((col) => col.name === columnName)

            if (column && ['TEXT', 'INTEGER'].includes(column.type.toUpperCase())) {
              // Avoid duplicates
              if (!searchableColumns.some((sc) => sc.name === columnName)) {
                searchableColumns.push({
                  name: columnName,
                  type: column.type,
                })
              }
            }
          }
        }

        // Always include primary key if it's TEXT or INTEGER
        const primaryKey = columns.find((col) => col.pk === 1)
        if (
          primaryKey &&
          ['TEXT', 'INTEGER'].includes(primaryKey.type.toUpperCase()) &&
          !searchableColumns.some((sc) => sc.name === primaryKey.name)
        ) {
          searchableColumns.unshift({
            name: primaryKey.name,
            type: primaryKey.type,
          })
        }

        return searchableColumns
      },
      { operationName: 'getSearchableColumns', tableName }
    )
  }

  /**
   * Search records in a table using indexed columns
   */
  async searchRecords(
    tableName: string,
    searchParams: Array<{ column: string; value: string; operator?: string }>,
    limit = 100,
    offset = 0
  ): Promise<TableDataResult> {
    return this.errorHandler.handleOperation(
      async () => {
        // Get searchable columns to validate search parameters
        const searchableColumns = await this.getSearchableColumns(tableName)
        const searchableColumnNames = searchableColumns.map((col) => col.name)

        // Validate search parameters
        const validSearchParams = searchParams.filter((param) =>
          searchableColumnNames.includes(param.column)
        )

        if (validSearchParams.length === 0) {
          // No valid search parameters, return empty result
          return {
            data: [],
            total: 0,
            limit,
            offset,
          }
        }

        // Build WHERE clause
        const whereConditions: string[] = []
        const bindValues: (string | number | boolean | null)[] = []

        for (const param of validSearchParams) {
          const column = searchableColumns.find((col) => col.name === param.column)
          if (!column) continue

          const columnName = validateAndEscapeTableName(param.column)
          const operator = param.operator || '='

          if (column.type.toUpperCase() === 'TEXT') {
            if (operator === 'LIKE' || operator === 'CONTAINS') {
              whereConditions.push(`"${columnName}" LIKE ?`)
              bindValues.push(`%${param.value}%`)
            } else {
              whereConditions.push(`"${columnName}" = ?`)
              bindValues.push(param.value)
            }
          } else if (column.type.toUpperCase() === 'INTEGER') {
            // Support comparison operators for integers
            const validOperators = ['=', '!=', '<', '>', '<=', '>=']
            const op = validOperators.includes(operator) ? operator : '='
            whereConditions.push(`"${columnName}" ${op} ?`)
            bindValues.push(Number.parseInt(param.value) || 0)
          }
        }

        // Build final query
        const whereClause = whereConditions.join(' AND ')
        const tableName_escaped = validateAndEscapeTableName(tableName)

        // Get total count
        const countQuery = `SELECT COUNT(*) as count FROM "${tableName_escaped}" WHERE ${whereClause}`
        const countResult = await this.db
          .prepare(countQuery)
          .bind(...bindValues)
          .first()
        const total = (countResult as CountResult)?.count || 0

        // Get data with pagination
        const dataQuery = `
          SELECT * FROM "${tableName_escaped}" 
          WHERE ${whereClause}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `
        const dataResult = await this.db
          .prepare(dataQuery)
          .bind(...bindValues, limit, offset)
          .all()

        return {
          data: dataResult.results as Record<string, unknown>[],
          total,
          limit,
          offset,
        }
      },
      { operationName: 'searchRecords', tableName }
    )
  }

  /**
   * Get table row count
   */
  async getTableRowCount(tableName: string): Promise<number> {
    return this.errorHandler.handleOperation(
      async () => {
        const result = await this.db
          .prepare(`SELECT COUNT(*) as count FROM "${validateAndEscapeTableName(tableName)}"`)
          .first()
        return (result as CountResult)?.count || 0
      },
      { operationName: 'getTableRowCount', tableName }
    )
  }

  /**
   * Check if a table exists
   */
  async tableExists(tableName: string): Promise<boolean> {
    return this.errorHandler.handleOperation(
      async () => {
        const result = await this.db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name=? AND name NOT LIKE 'sqlite_%'`
          )
          .bind(tableName)
          .first()
        return !!result
      },
      { operationName: 'tableExists', tableName }
    )
  }
}
