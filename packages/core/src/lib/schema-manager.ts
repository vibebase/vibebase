import type { D1Database } from '../types/cloudflare'
import type { CountResult, TableInfo } from '../types/database'
import type { SchemaSnapshotManager } from './schema-snapshot'
import {
  validateAndEscapeColumnName,
  validateAndEscapeTableName,
  validateAndNormalizeSQLDataType,
  validateNotSystemTable,
} from './sql-utils'
import { SYSTEM_TABLES } from './table-manager'

export interface ColumnInfo {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
  [key: string]: unknown
}

export interface ColumnDefinition {
  name: string
  type: string
  constraints?: string
  foreignKey?: { table: string; column: string }
}

export class SchemaManager {
  constructor(
    private db: D1Database,
    private snapshotManager: SchemaSnapshotManager,
    private createAsyncSnapshot: (options: {
      name?: string
      description?: string
      createdBy?: string
      snapshotType?: 'manual' | 'auto' | 'pre_change'
    }) => void
  ) {}

  private async enableForeignKeys(): Promise<void> {
    try {
      await this.db.prepare('PRAGMA foreign_keys = ON').run()
    } catch (error) {
      console.warn('Failed to enable foreign keys:', error)
    }
  }

  // Create a new user table
  async createTable(tableName: string, columns: ColumnDefinition[]): Promise<void> {
    await this.enableForeignKeys()

    // Create pre-change snapshot asynchronously
    this.createAsyncSnapshot({
      description: `Before creating table: ${tableName}`,
      snapshotType: 'pre_change',
    })

    // Validate table name and check if it's a system table
    validateNotSystemTable(tableName, SYSTEM_TABLES)
    const safeTableName = validateAndEscapeTableName(tableName)

    // Build CREATE TABLE statement
    const columnDefs = columns
      .map((col) => {
        const safeColumnName = validateAndEscapeColumnName(col.name)
        const safeType = validateAndNormalizeSQLDataType(col.type)
        let def = `${safeColumnName} ${safeType}`
        if (col.constraints) def += ` ${col.constraints}`
        return def
      })
      .join(', ')

    // Build foreign key constraints
    const foreignKeys = columns
      .filter((col) => col.foreignKey?.table && col.foreignKey.column)
      .map((col) => {
        const safeColumnName = validateAndEscapeColumnName(col.name)
        const safeRefTable = validateAndEscapeTableName(col.foreignKey?.table as string)
        const safeRefColumn = validateAndEscapeColumnName(col.foreignKey?.column as string)
        return `FOREIGN KEY (${safeColumnName}) REFERENCES ${safeRefTable}(${safeRefColumn})`
      })
      .join(', ')

    const sql = `CREATE TABLE ${safeTableName} (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      ${columnDefs},
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP${foreignKeys ? `, ${foreignKeys}` : ''}
    )`

    await this.db.prepare(sql).run()
  }

  // Drop a user table
  async dropTable(tableName: string): Promise<void> {
    // Validate table name and check if it's a system table
    validateNotSystemTable(tableName, SYSTEM_TABLES)
    const safeTableName = validateAndEscapeTableName(tableName)

    // Create pre-change snapshot asynchronously
    this.createAsyncSnapshot({
      description: `Before dropping table: ${tableName}`,
      snapshotType: 'pre_change',
    })

    await this.db.prepare(`DROP TABLE IF EXISTS ${safeTableName}`).run()
  }

  // Get columns for a specific table
  async getTableColumns(tableName: string): Promise<ColumnInfo[]> {
    const safeTableName = validateAndEscapeTableName(tableName)
    const result = await this.db.prepare(`PRAGMA table_info(${safeTableName})`).all()

    return result.results as ColumnInfo[]
  }

  // Get foreign key constraints for a specific table
  async getForeignKeys(tableName: string): Promise<{ from: string; table: string; to: string }[]> {
    const safeTableName = validateAndEscapeTableName(tableName)
    const result = await this.db.prepare(`PRAGMA foreign_key_list(${safeTableName})`).all()

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
  }

  // Add column to existing table
  async addColumn(tableName: string, column: ColumnDefinition): Promise<void> {
    await this.enableForeignKeys()

    // Validate table name and check if it's a system table
    validateNotSystemTable(tableName, SYSTEM_TABLES)
    const safeTableName = validateAndEscapeTableName(tableName)
    const safeColumnName = validateAndEscapeColumnName(column.name)
    const safeType = validateAndNormalizeSQLDataType(column.type)

    // Build ALTER TABLE statement
    let alterSQL = `ALTER TABLE ${safeTableName} ADD COLUMN ${safeColumnName} ${safeType}`
    if (column.constraints) {
      alterSQL += ` ${column.constraints}`
    }

    // Create pre-change snapshot asynchronously
    this.createAsyncSnapshot({
      description: `Before adding column ${column.name} to ${tableName}`,
      snapshotType: 'pre_change',
    })

    await this.db.prepare(alterSQL).run()

    // If foreign key is specified, we need to recreate the table (SQLite limitation)
    if (column.foreignKey) {
      await this.addForeignKeyByRecreatingTable(tableName, column.name, column.foreignKey)
    }
  }

  // Rename column (requires table recreation in SQLite)
  async renameColumn(tableName: string, oldName: string, newName: string): Promise<void> {
    await this.enableForeignKeys()

    validateNotSystemTable(tableName, SYSTEM_TABLES)
    const safeTableName = validateAndEscapeTableName(tableName)
    const safeOldName = validateAndEscapeColumnName(oldName)
    const safeNewName = validateAndEscapeColumnName(newName)

    // Create pre-change snapshot asynchronously
    this.createAsyncSnapshot({
      description: `Before renaming column ${oldName} to ${newName} in ${tableName}`,
      snapshotType: 'pre_change',
    })

    // SQLite 3.25.0+ supports ALTER TABLE RENAME COLUMN
    const sql = `ALTER TABLE ${safeTableName} RENAME COLUMN ${safeOldName} TO ${safeNewName}`
    await this.db.prepare(sql).run()
  }

  // Drop column (requires table recreation in SQLite)
  async dropColumn(tableName: string, columnName: string): Promise<void> {
    await this.enableForeignKeys()

    validateNotSystemTable(tableName, SYSTEM_TABLES)
    const safeTableName = validateAndEscapeTableName(tableName)
    const safeColumnName = validateAndEscapeColumnName(columnName)

    // Create pre-change snapshot asynchronously
    this.createAsyncSnapshot({
      description: `Before dropping column ${columnName} from ${tableName}`,
      snapshotType: 'pre_change',
    })

    // SQLite 3.35.0+ supports ALTER TABLE DROP COLUMN
    const sql = `ALTER TABLE ${safeTableName} DROP COLUMN ${safeColumnName}`
    await this.db.prepare(sql).run()
  }

  // Validate data before constraint/type changes
  async validateColumnChanges(
    tableName: string,
    columnName: string,
    changes: {
      type?: string
      notNull?: boolean
      foreignKey?: { table: string; column: string } | null
    }
  ): Promise<{ valid: boolean; errors: string[]; conflictingRows: number }> {
    const safeTableName = validateAndEscapeTableName(tableName)
    const safeColumnName = validateAndEscapeColumnName(columnName)
    const errors: string[] = []
    let conflictingRows = 0

    // Check for NOT NULL constraint violations
    if (changes.notNull === true) {
      const nullCheckResult = await this.db
        .prepare(`SELECT COUNT(*) as count FROM ${safeTableName} WHERE ${safeColumnName} IS NULL`)
        .first()

      const nullCount = (nullCheckResult as CountResult)?.count || 0
      if (nullCount > 0) {
        errors.push(
          `Cannot add NOT NULL constraint: ${nullCount} rows have NULL values in column '${columnName}'`
        )
        conflictingRows += nullCount
      }
    }

    // Check for foreign key constraint violations
    if (changes.foreignKey) {
      const safeRefTable = validateAndEscapeTableName(changes.foreignKey.table)
      const safeRefColumn = validateAndEscapeColumnName(changes.foreignKey.column)

      const fkCheckResult = await this.db
        .prepare(`
          SELECT COUNT(*) as count 
          FROM ${safeTableName} t1 
          WHERE t1.${safeColumnName} IS NOT NULL 
          AND NOT EXISTS (
            SELECT 1 FROM ${safeRefTable} t2 
            WHERE t2.${safeRefColumn} = t1.${safeColumnName}
          )
        `)
        .first()

      const fkViolationCount = (fkCheckResult as CountResult)?.count || 0
      if (fkViolationCount > 0) {
        errors.push(
          `Cannot add foreign key constraint: ${fkViolationCount} rows reference non-existent values in '${changes.foreignKey.table}.${changes.foreignKey.column}'`
        )
        conflictingRows += fkViolationCount
      }
    }

    // Check for type conversion issues
    if (changes.type) {
      const currentColumn = await this.db.prepare(`PRAGMA table_info(${safeTableName})`).all()

      interface TableInfoColumn {
        name: string
        type: string
        [key: string]: unknown
      }

      const column = currentColumn.results.find((col) => {
        const columnInfo = col as TableInfoColumn
        return columnInfo.name === columnName
      })
      if (column && (column as TableInfoColumn).type !== changes.type) {
        // Check if data can be safely converted
        if (changes.type === 'INTEGER') {
          const invalidIntegerResult = await this.db
            .prepare(`
              SELECT COUNT(*) as count 
              FROM ${safeTableName} 
              WHERE ${safeColumnName} IS NOT NULL 
              AND CAST(${safeColumnName} AS INTEGER) = 0 
              AND ${safeColumnName} != '0' 
              AND ${safeColumnName} != 0
            `)
            .first()

          const invalidCount = (invalidIntegerResult as CountResult)?.count || 0
          if (invalidCount > 0) {
            errors.push(
              `Cannot convert to INTEGER: ${invalidCount} rows contain non-numeric values in column '${columnName}'`
            )
            conflictingRows += invalidCount
          }
        } else if (changes.type === 'REAL') {
          const invalidRealResult = await this.db
            .prepare(`
              SELECT COUNT(*) as count 
              FROM ${safeTableName} 
              WHERE ${safeColumnName} IS NOT NULL 
              AND CAST(${safeColumnName} AS REAL) = 0.0 
              AND ${safeColumnName} != '0' 
              AND ${safeColumnName} != '0.0' 
              AND ${safeColumnName} != 0 
              AND ${safeColumnName} != 0.0
            `)
            .first()

          const invalidCount = (invalidRealResult as CountResult)?.count || 0
          if (invalidCount > 0) {
            errors.push(
              `Cannot convert to REAL: ${invalidCount} rows contain non-numeric values in column '${columnName}'`
            )
            conflictingRows += invalidCount
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      conflictingRows,
    }
  }

  // Modify column constraints (requires table recreation for most changes)
  async modifyColumn(
    tableName: string,
    columnName: string,
    changes: {
      type?: string
      notNull?: boolean
      foreignKey?: { table: string; column: string } | null
    }
  ): Promise<void> {
    await this.enableForeignKeys()

    validateNotSystemTable(tableName, SYSTEM_TABLES)
    const safeTableName = validateAndEscapeTableName(tableName)

    // Validate changes before proceeding
    const validation = await this.validateColumnChanges(tableName, columnName, changes)
    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.join('; ')}`)
    }

    // Get current table schema
    const tableInfo = await this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
      .bind(tableName)
      .first()

    if (!tableInfo) {
      throw new Error(`Table ${tableName} not found`)
    }

    // Get current column info
    const columns = await this.getTableColumns(tableName)
    const currentColumn = columns.find((col) => col.name === columnName)

    if (!currentColumn) {
      throw new Error(`Column ${columnName} not found in table ${tableName}`)
    }

    // Create temp table with modifications
    const tempTableName = `${tableName}_temp_${Date.now()}`
    const safeTempTableName = validateAndEscapeTableName(tempTableName)
    const modifiedSQL = this.modifyCreateStatementForColumn(
      (tableInfo as TableInfo).sql,
      columnName,
      changes,
      tempTableName,
      columns
    )

    // Create pre-change snapshot asynchronously
    this.createAsyncSnapshot({
      description: `Before modifying column ${columnName} in ${tableName}`,
      snapshotType: 'pre_change',
    })

    // Use batch operation for atomic transaction
    const statements = [
      this.db.prepare(modifiedSQL),
      this.db.prepare(`INSERT INTO ${safeTempTableName} SELECT * FROM ${safeTableName}`),
      this.db.prepare(`DROP TABLE ${safeTableName}`),
      this.db.prepare(`ALTER TABLE ${safeTempTableName} RENAME TO ${safeTableName}`),
    ]

    await this.db.batch(statements)
  }

  // Helper method to add foreign key by recreating table (SQLite limitation)
  private async addForeignKeyByRecreatingTable(
    tableName: string,
    columnName: string,
    foreignKey: { table: string; column: string }
  ): Promise<void> {
    // Get current table schema
    const tableInfo = await this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
      .bind(tableName)
      .first()

    if (!tableInfo) {
      throw new Error(`Table ${tableName} not found`)
    }

    // Create temp table with new foreign key
    const tempTableName = `${tableName}_temp_${Date.now()}`
    const originalSQL = (tableInfo as TableInfo).sql

    // Parse and modify the CREATE TABLE statement to add foreign key
    const modifiedSQL = this.addForeignKeyToCreateStatement(
      originalSQL,
      columnName,
      foreignKey,
      tempTableName
    )

    const safeTableName = validateAndEscapeTableName(tableName)
    const safeTempTableName = validateAndEscapeTableName(tempTableName)

    // Use batch operation for atomic transaction
    const statements = [
      this.db.prepare(modifiedSQL),
      this.db.prepare(`INSERT INTO ${safeTempTableName} SELECT * FROM ${safeTableName}`),
      this.db.prepare(`DROP TABLE ${safeTableName}`),
      this.db.prepare(`ALTER TABLE ${safeTempTableName} RENAME TO ${safeTableName}`),
    ]

    await this.db.batch(statements)
  }

  // Helper to modify CREATE TABLE statement to add foreign key
  private addForeignKeyToCreateStatement(
    sql: string,
    columnName: string,
    foreignKey: { table: string; column: string },
    newTableName: string
  ): string {
    const safeNewTableName = validateAndEscapeTableName(newTableName)
    const safeColumnName = validateAndEscapeColumnName(columnName)
    const safeRefTable = validateAndEscapeTableName(foreignKey.table)
    const safeRefColumn = validateAndEscapeColumnName(foreignKey.column)

    // Replace table name
    let modifiedSQL = sql.replace(/CREATE TABLE\s+(\w+)/i, `CREATE TABLE ${safeNewTableName}`)

    // Find the closing parenthesis and add foreign key before it
    const lastParen = modifiedSQL.lastIndexOf(')')
    const fkConstraint = `, FOREIGN KEY (${safeColumnName}) REFERENCES ${safeRefTable}(${safeRefColumn})`

    modifiedSQL = modifiedSQL.slice(0, lastParen) + fkConstraint + modifiedSQL.slice(lastParen)

    return modifiedSQL
  }

  // Helper to modify CREATE TABLE statement for column changes
  private modifyCreateStatementForColumn(
    sql: string,
    columnName: string,
    changes: {
      type?: string
      notNull?: boolean
      foreignKey?: { table: string; column: string } | null
    },
    newTableName: string,
    columns: ColumnInfo[]
  ): string {
    const safeNewTableName = validateAndEscapeTableName(newTableName)

    // Always rebuild the entire CREATE statement to avoid parsing issues
    const columnDefs = columns
      .map((col) => {
        if (col.name === columnName) {
          // Apply changes to this column
          const safeColName = validateAndEscapeColumnName(col.name)
          let def = `${safeColName} ${changes.type || col.type}`
          const shouldBeNotNull =
            changes.notNull !== undefined ? changes.notNull : col.notnull === 1
          if (col.pk) def += ' PRIMARY KEY'
          if (col.dflt_value !== null && col.dflt_value !== undefined) {
            // Handle different default value types
            if (typeof col.dflt_value === 'string') {
              if (col.dflt_value === 'CURRENT_TIMESTAMP' || col.dflt_value === 'NULL') {
                // Simple SQL keywords
                def += ` DEFAULT ${col.dflt_value}`
              } else if (col.dflt_value.includes('(')) {
                // Complex function call - wrap in parentheses for SQLite
                def += ` DEFAULT (${col.dflt_value})`
              } else {
                // String literal
                def += ` DEFAULT '${col.dflt_value}'`
              }
            } else {
              def += ` DEFAULT ${col.dflt_value}`
            }
          }
          if (shouldBeNotNull) def += ' NOT NULL'
          return def
        } else {
          // Keep existing column definition
          const safeColName = validateAndEscapeColumnName(col.name)
          let def = `${safeColName} ${col.type}`
          if (col.pk) def += ' PRIMARY KEY'
          if (col.dflt_value !== null && col.dflt_value !== undefined) {
            // Handle different default value types
            if (typeof col.dflt_value === 'string') {
              if (col.dflt_value === 'CURRENT_TIMESTAMP' || col.dflt_value === 'NULL') {
                // Simple SQL keywords
                def += ` DEFAULT ${col.dflt_value}`
              } else if (col.dflt_value.includes('(')) {
                // Complex function call - wrap in parentheses for SQLite
                def += ` DEFAULT (${col.dflt_value})`
              } else {
                // String literal
                def += ` DEFAULT '${col.dflt_value}'`
              }
            } else {
              def += ` DEFAULT ${col.dflt_value}`
            }
          }
          if (col.notnull) def += ' NOT NULL'
          return def
        }
      })
      .join(', ')

    // Build foreign key constraints array
    const foreignKeys: string[] = []

    // Add new foreign key if specified
    if (changes.foreignKey) {
      const safeColumnName = validateAndEscapeColumnName(columnName)
      const safeRefTable = validateAndEscapeTableName(changes.foreignKey.table)
      const safeRefColumn = validateAndEscapeColumnName(changes.foreignKey.column)
      foreignKeys.push(
        `FOREIGN KEY (${safeColumnName}) REFERENCES ${safeRefTable}(${safeRefColumn})`
      )
    }

    // Extract existing foreign keys from original SQL (simple approach)
    // Look for patterns like: FOREIGN KEY (column) REFERENCES table(column)
    const originalFkRegex =
      /FOREIGN KEY\s*\(\s*"?([^)"]+)"?\s*\)\s*REFERENCES\s+"?([^"(]+)"?\s*\(\s*"?([^)"]+)"?\s*\)/gi
    let match: RegExpExecArray | null
    match = originalFkRegex.exec(sql)
    while (match !== null) {
      const [_fullMatch, fkColumn, refTable, refColumn] = match
      // Only keep if it's not the column we're modifying
      if (fkColumn !== columnName) {
        const safeFkColumn = validateAndEscapeColumnName(fkColumn)
        const safeRefTable = validateAndEscapeTableName(refTable)
        const safeRefColumn = validateAndEscapeColumnName(refColumn)
        foreignKeys.push(
          `FOREIGN KEY (${safeFkColumn}) REFERENCES ${safeRefTable}(${safeRefColumn})`
        )
      }
      match = originalFkRegex.exec(sql)
    }

    // If removing foreign key constraint for this column, don't add it back
    if (changes.foreignKey === null) {
      // Already handled by not including it above
    }

    // Build final SQL
    const fkClause = foreignKeys.length > 0 ? `, ${foreignKeys.join(', ')}` : ''
    const modifiedSQL = `CREATE TABLE ${safeNewTableName} (${columnDefs}${fkClause})`

    return modifiedSQL
  }

  // Apply schema migration (non-destructive)
  async applySchemaMigration(targetSchemas: TableSchema[]): Promise<void> {
    await this.enableForeignKeys()

    // Create pre-change snapshot asynchronously
    this.createAsyncSnapshot({
      description: 'Before applying schema migration',
      snapshotType: 'pre_change',
    })

    // Get current schemas
    const currentSchemas = await this.snapshotManager.getAllTableSchemas()
    const currentTableNames = new Set(currentSchemas.map((s) => s.name))

    // Process each target schema
    for (const targetSchema of targetSchemas) {
      const tableName = targetSchema.name

      // Skip system tables
      if ((SYSTEM_TABLES as readonly string[]).includes(tableName)) {
        continue
      }

      if (!currentTableNames.has(tableName)) {
        // Table doesn't exist, create it
        await this.db.prepare(targetSchema.sql).run()
      } else {
        // Table exists, check for missing columns
        const currentSchema = currentSchemas.find((s) => s.name === tableName)
        if (!currentSchema) continue

        const currentColumnNames = new Set(currentSchema.columns.map((c) => c.name))
        const targetColumns = targetSchema.columns

        for (const targetColumn of targetColumns) {
          if (!currentColumnNames.has(targetColumn.name)) {
            // Column is missing, add it
            const columnDef: ColumnDefinition = {
              name: targetColumn.name,
              type: targetColumn.type,
            }

            // Build constraints string
            const constraints: string[] = []
            if (targetColumn.notnull === 1 && targetColumn.pk !== 1) {
              // Skip NOT NULL check for now, as it requires data validation
              // constraints.push('NOT NULL')
            }
            if (targetColumn.dflt_value !== null && targetColumn.dflt_value !== undefined) {
              if (typeof targetColumn.dflt_value === 'string') {
                if (
                  targetColumn.dflt_value === 'CURRENT_TIMESTAMP' ||
                  targetColumn.dflt_value === 'NULL'
                ) {
                  constraints.push(`DEFAULT ${targetColumn.dflt_value}`)
                } else if (targetColumn.dflt_value.includes('(')) {
                  constraints.push(`DEFAULT (${targetColumn.dflt_value})`)
                } else {
                  constraints.push(`DEFAULT '${targetColumn.dflt_value}'`)
                }
              } else {
                constraints.push(`DEFAULT ${targetColumn.dflt_value}`)
              }
            }

            columnDef.constraints = constraints.join(' ')

            await this.addColumn(tableName, columnDef)
          }
        }
      }
    }
  }
}

interface TableSchema {
  name: string
  sql: string
  columns: {
    cid: number
    name: string
    type: string
    notnull: number
    dflt_value: unknown
    pk: number
  }[]
  foreignKeys: { from: string; table: string; to: string }[]
  indexes: { name: string; tableName: string; columns: string[]; unique: boolean; sql: string }[]
}
