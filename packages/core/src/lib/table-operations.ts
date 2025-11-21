import type { D1Database } from '../types/cloudflare'
import type { CountResult, TableInfo } from '../types/database'
import { ErrorHandler } from './error-handler'
import type { ColumnDefinition, ColumnInfo, SchemaManager } from './schema-manager'
import { validateAndEscapeTableName } from './sql-utils'

// System tables that cannot be modified by users
export const SYSTEM_TABLES = [
  'admins',
  'sessions',
  'schema_snapshots',
  'schema_snapshot_counter',
  'd1_migrations',
  'api_keys',
  'user_sessions',
  'oauth_providers',
  'app_settings',
  'table_policies',
  'hooks',
  'event_queue',
  'realtime_subscriptions',
  'custom_queries',
  'custom_query_logs',
  'vapid_config',
  'push_subscriptions',
  'notification_rules',
  'notification_templates',
  'notification_logs',
] as const

type SystemTable = (typeof SYSTEM_TABLES)[number]

/**
 * Check if a table name is a system table
 */
export function isSystemTable(tableName: string): boolean {
  return SYSTEM_TABLES.includes(tableName as SystemTable)
}

export interface LocalTableInfo {
  name: string
  type: 'system' | 'user'
  sql: string // CREATE TABLE statement
  rowCount?: number
  access_policy?: 'public' | 'private'
}

/**
 * Handles table structure operations like creation, deletion, and metadata queries
 */
export class TableOperations {
  private errorHandler: ErrorHandler
  private schemaManager: SchemaManager

  constructor(
    private db: D1Database,
    schemaManager: SchemaManager
  ) {
    this.errorHandler = ErrorHandler.getInstance()
    this.schemaManager = schemaManager
  }

  /**
   * Get list of all tables (both system and user tables)
   */
  async getTables(): Promise<LocalTableInfo[]> {
    return this.errorHandler.handleOperation(
      async () => {
        const result = await this.db
          .prepare(
            `SELECT name, sql FROM sqlite_master 
             WHERE type='table' 
             AND name NOT LIKE 'sqlite_%' 
             AND name NOT LIKE '_cf_%'
             ORDER BY name`
          )
          .all()

        const tables: LocalTableInfo[] = []

        for (const table of result.results as TableInfo[]) {
          // Get row count for each table
          let rowCount = 0
          try {
            const countResult = await this.db
              .prepare(`SELECT COUNT(*) as count FROM "${table.name}"`)
              .first()
            rowCount = (countResult as CountResult)?.count || 0
          } catch {
            // If we can't get count, just use 0
            rowCount = 0
          }

          // Check if it's a system table
          const isSystemTableCheck = isSystemTable(table.name)

          // Get access policy for user tables
          let accessPolicy: 'public' | 'private' | undefined
          if (!isSystemTableCheck) {
            try {
              accessPolicy = await this.getTableAccessPolicy(table.name)
            } catch {
              // Default to private if we can't determine policy
              accessPolicy = 'private'
            }
          }

          tables.push({
            name: table.name,
            type: isSystemTableCheck ? 'system' : 'user',
            sql: table.sql,
            rowCount,
            access_policy: accessPolicy,
          })
        }

        return tables
      },
      { operationName: 'getTables' }
    )
  }

  /**
   * Get column information for a specific table
   */
  async getTableColumns(tableName: string): Promise<ColumnInfo[]> {
    return this.schemaManager.getTableColumns(tableName)
  }

  /**
   * Get foreign key relationships for a table
   */
  async getForeignKeys(tableName: string): Promise<{ from: string; table: string; to: string }[]> {
    return this.errorHandler.handleOperation(
      async () => {
        const result = await this.db.prepare(`PRAGMA foreign_key_list("${tableName}")`).all()

        // Type assertion for foreign key results
        interface ForeignKeyInfo {
          from: string
          table: string
          to: string
        }

        return result.results.map((fk) => {
          const foreignKey = fk as unknown as ForeignKeyInfo
          return {
            from: foreignKey.from,
            table: foreignKey.table,
            to: foreignKey.to,
          }
        })
      },
      { operationName: 'getForeignKeys', tableName }
    )
  }

  /**
   * Create a new user table
   */
  async createTable(tableName: string, columns: ColumnDefinition[]): Promise<void> {
    return this.schemaManager.createTable(tableName, columns)
  }

  /**
   * Drop a user table
   */
  async dropTable(tableName: string): Promise<void> {
    return this.schemaManager.dropTable(tableName)
  }

  /**
   * Validate table name and check if it's a system table
   */
  validateTableName(tableName: string): void {
    validateAndEscapeTableName(tableName)

    if (isSystemTable(tableName)) {
      throw new Error('Cannot modify system table')
    }
  }

  /**
   * Get access policy for a table
   */
  private async getTableAccessPolicy(tableName: string): Promise<'public' | 'private'> {
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
}
