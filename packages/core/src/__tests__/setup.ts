export interface MockD1Database {
  prepare: (sql: string) => MockD1PreparedStatement
  batch: <T = unknown>(statements: MockD1PreparedStatement[]) => Promise<D1Result<T>[]>
  exec: (sql: string) => Promise<D1ExecResult>
  withSession: (constraintOrBookmark?: string) => D1DatabaseSession
  dump: () => Promise<ArrayBuffer>
}

export interface MockD1PreparedStatement {
  bind: (...params: unknown[]) => MockD1PreparedStatement
  run: <T = unknown>() => Promise<{
    results: T[]
    success: true
    meta: {
      changes: number
      last_row_id: number
      duration: number
      size_after: number
      rows_read: number
      rows_written: number
      changed_db: boolean
    }
  }>
  all: <T = unknown>() => Promise<{
    results: T[]
    success: true
    meta: {
      changes: number
      last_row_id: number
      duration: number
      size_after: number
      rows_read: number
      rows_written: number
      changed_db: boolean
    }
  }>
  first: <T = unknown>(colName?: string) => Promise<T | null>
  raw: () => Promise<[string[], ...unknown[]]>
}

export interface MockR2Bucket {
  get: (key: string) => Promise<{
    key: string
    version: string
    size: number
    etag: string
    httpEtag: string
    uploaded: Date
    checksums: Record<string, string>
    text: () => Promise<string>
    json: () => Promise<unknown>
    arrayBuffer: () => Promise<ArrayBuffer>
    blob: () => Promise<Blob>
  } | null>
  put: (
    key: string,
    data: string
  ) => Promise<{
    key: string
    version: string
    size: number
    etag: string
    httpEtag: string
    uploaded: Date
    checksums: Record<string, string>
    text: () => Promise<string>
    json: () => Promise<unknown>
    arrayBuffer: () => Promise<ArrayBuffer>
    blob: () => Promise<Blob>
  }>
  delete: (key: string) => Promise<void>
  list: (
    options?: Record<string, unknown>
  ) => Promise<{ objects: unknown[]; truncated: boolean; delimitedPrefixes: string[] }>
  head: (key: string) => Promise<unknown>
}

export interface MockExecutionContext {
  waitUntil: (promise: Promise<unknown>) => void
  passThroughOnException: () => void
}

// Create mock D1 database
// Helper function to handle SELECT queries with WHERE clauses
function handleSelectWithWhere(
  sql: string,
  tableData: unknown[],
  bindings: unknown[] = []
): { results: unknown[] } {
  const normalizedSql = sql.trim().toUpperCase()
  const whereIndex = normalizedSql.indexOf('WHERE')

  if (whereIndex === -1) {
    return { results: tableData }
  }

  // Extract WHERE clause content, stopping at ORDER BY or LIMIT
  let whereClause = sql.substring(whereIndex + 5)
  const orderByIndex = whereClause.toUpperCase().indexOf('ORDER BY')
  const limitIndex = whereClause.toUpperCase().indexOf('LIMIT')

  if (orderByIndex !== -1) {
    whereClause = whereClause.substring(0, orderByIndex)
  } else if (limitIndex !== -1) {
    whereClause = whereClause.substring(0, limitIndex)
  }

  // Split by AND
  const conditions = whereClause.split(/\s+AND\s+/i)
  let currentBindingIndex = 0

  const _filteredData = tableData.filter((_record) => {
    // Reset binding index for each record check?
    // NO! Bindings are constant for the query.
    // We need to map conditions to bindings ONCE, then check records.
    return true
  })

  // Better approach: Parse conditions and values first
  const parsedConditions: { col: string; op: string; val: unknown }[] = []

  for (const condition of conditions) {
    const match = condition.trim().match(/["']?(\w+)["']?\s*([=<>!]+|IS NULL|IS NOT NULL)\s*(.+)?/i)
    if (match) {
      const [, column, operator, valueStr] = match
      let value: unknown = valueStr?.trim().replace(/['"`]/g, '')

      if (valueStr?.trim() === '?') {
        value = bindings[currentBindingIndex++]
      } else if (valueStr?.trim().match(/^['"].*['"]$/)) {
        // It's a string literal, already handled by replace
      } else if (!Number.isNaN(Number(value))) {
        value = Number(value)
      }

      parsedConditions.push({ col: column, op: operator.toUpperCase(), val: value })
    }
  }

  // Now filter data
  const results = tableData.filter((record) => {
    return parsedConditions.every(({ col, op, val }) => {
      const recordValue = (record as Record<string, unknown>)[col]

      switch (op) {
        case '=':
          return recordValue === val // Loose equality for numbers/strings
        case '>':
          return Number(recordValue) > Number(val)
        case '<':
          return Number(recordValue) < Number(val)
        case '>=':
          return Number(recordValue) >= Number(val)
        case '<=':
          return Number(recordValue) <= Number(val)
        case 'IS NULL':
          return recordValue === null || recordValue === undefined
        case 'IS NOT NULL':
          return recordValue !== null && recordValue !== undefined
        default:
          return false
      }
    })
  })

  return { results }
}

export function createMockD1Database(): MockD1Database {
  const tables = new Map<string, unknown[]>()
  const schemas = new Map<string, string>()
  const tableColumns = new Map<string, unknown[]>()
  const tableIndexes = new Map<string, unknown[]>()
  const snapshots = new Map<string, unknown>()
  let snapshotCounter = 0

  // Default system tables
  tables.set('schema_snapshots', [])
  tables.set('schema_snapshot_counter', [{ id: 'default', current_version: 0 }])

  // Push notification tables
  tables.set('push_subscriptions', [])
  tables.set('notification_rules', [])
  tables.set('notification_logs', [])

  // Helper to extract table name from various SQL statements
  function getTableNameFromSql(sql: string): string | null {
    // Handle both quoted and unquoted table names
    // Handle "IF NOT EXISTS" and "IF EXISTS" clauses
    const createTableMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/i)
    const alterTableMatch = sql.match(/ALTER\s+TABLE\s+["']?(\w+)["']?/i)
    const insertIntoMatch = sql.match(/INSERT\s+INTO\s+["']?(\w+)["']?/i)
    const updateMatch = sql.match(/UPDATE\s+["']?(\w+)["']?/i)
    const deleteMatch = sql.match(/DELETE\s+FROM\s+["']?(\w+)["']?/i)
    const selectMatch = sql.match(/FROM\s+["']?(\w+)["']?/i)
    const dropTableMatch = sql.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["']?(\w+)["']?/i)
    const pragmaMatch = sql.match(/PRAGMA\s+\w+\s*\(\s*["']?(\w+)["']?\s*\)/i)
    return (
      createTableMatch?.[1] ||
      alterTableMatch?.[1] ||
      insertIntoMatch?.[1] ||
      updateMatch?.[1] ||
      deleteMatch?.[1] ||
      selectMatch?.[1] ||
      dropTableMatch?.[1] ||
      pragmaMatch?.[1] ||
      null
    )
  }

  // Helper to normalize table names by removing quotes
  function normalizeTableName(tableName: string): string {
    return tableName.replace(/["'`]/g, '')
  }

  // Helper to find table with normalized name lookup
  function findTable(tableName: string): string | null {
    const normalizedName = normalizeTableName(tableName)
    for (const [key] of tables.entries()) {
      if (normalizeTableName(key) === normalizedName) {
        return key
      }
    }
    return null
  }

  const createMockStatement = (sql: string, bindings: unknown[] = []): MockD1PreparedStatement => {
    return {
      bind: (...params: unknown[]) => createMockStatement(sql, [...bindings, ...params]),
      run: async <T = unknown>() => {
        // Basic SQL execution simulation
        const normalizedSql = sql.trim().toUpperCase()

        if (normalizedSql.startsWith('CREATE TABLE')) {
          const tableName = getTableNameFromSql(sql)
          if (tableName) {
            const normalizedName = normalizeTableName(tableName)

            tables.set(normalizedName, [])
            schemas.set(normalizedName, sql)

            // Parse columns from CREATE TABLE statement more robustly
            // Handle nested parentheses properly
            const createTableMatch = sql.match(/CREATE\s+TABLE\s+[^(]+\((.*)\)/s)
            if (createTableMatch) {
              const columnStr = createTableMatch[1]
              // Parse the actual user-defined columns from the SQL
              const userColumnDefs: unknown[] = []

              // Split by comma and parse each column definition
              const columnParts = columnStr.split(',').map((c) => c.trim())
              let cidCounter = 1 // Start after the auto-generated id column

              for (const col of columnParts) {
                const trimmedCol = col.trim()

                // Skip auto-generated columns that are already handled by the table manager
                if (
                  trimmedCol.startsWith('id TEXT PRIMARY KEY') ||
                  trimmedCol.includes('created_at DATETIME') ||
                  trimmedCol.includes('updated_at DATETIME')
                ) {
                  continue
                }

                // Parse column definition
                const parts = trimmedCol.split(/\s+/)
                const colName = parts[0]?.replace(/["'`]/g, '')

                if (colName && !['id', 'created_at', 'updated_at'].includes(colName)) {
                  userColumnDefs.push({
                    cid: cidCounter++,
                    name: colName,
                    type: parts[1] || 'TEXT',
                    notnull: trimmedCol.includes('NOT NULL') ? 1 : 0,
                    dflt_value: null,
                    pk: trimmedCol.includes('PRIMARY KEY') ? 1 : 0,
                  })
                }
              }

              // Always add the auto-generated columns in the expected order
              const allColumns = [
                {
                  cid: 0,
                  name: 'id',
                  type: 'TEXT',
                  notnull: 0,
                  dflt_value: null,
                  pk: 1,
                },
                ...userColumnDefs,
                {
                  cid: cidCounter,
                  name: 'created_at',
                  type: 'DATETIME',
                  notnull: 1,
                  dflt_value: null,
                  pk: 0,
                },
                {
                  cid: cidCounter + 1,
                  name: 'updated_at',
                  type: 'DATETIME',
                  notnull: 1,
                  dflt_value: null,
                  pk: 0,
                },
              ]

              tableColumns.set(normalizedName, allColumns)
            }
            tableIndexes.set(normalizedName, [])
          }
        } else if (normalizedSql.startsWith('DROP TABLE')) {
          const tableName = getTableNameFromSql(sql)
          if (tableName) {
            const normalizedName = normalizeTableName(tableName)
            const actualTableName = findTable(normalizedName)
            if (actualTableName) {
              tables.delete(actualTableName)
              schemas.delete(actualTableName)
              tableColumns.delete(actualTableName)
              tableIndexes.delete(actualTableName)
            }
          }
        } else if (normalizedSql.startsWith('CREATE') && normalizedSql.includes('INDEX')) {
          const indexMatch = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+["']?(\w+)["']?/i)
          const tableMatch = sql.match(/ON\s+["']?(\w+)["']?/i)
          const columnsMatch = sql.match(/\(([^)]+)\)/i)
          if (indexMatch && tableMatch && columnsMatch) {
            const indexName = indexMatch[1]
            const tableName = normalizeTableName(tableMatch[1])
            const unique = sql.toUpperCase().includes('UNIQUE')
            const columns = columnsMatch[1]
              .split(',')
              .map((col) => col.trim().replace(/["'`]/g, ''))

            // Find the actual table name
            const actualTableName = findTable(tableName)
            if (actualTableName) {
              if (!tableIndexes.has(actualTableName)) {
                tableIndexes.set(actualTableName, [])
              }
              const existingIndexes = tableIndexes.get(actualTableName)
              if (!existingIndexes) {
                throw new Error(`Table "${actualTableName}" not found`)
              }

              // Check for duplicate index name
              if (existingIndexes.some((idx) => (idx as { name: string }).name === indexName)) {
                throw new Error(`Index "${indexName}" already exists`)
              }

              existingIndexes.push({
                name: indexName,
                unique: unique ? 1 : 0,
                sql: sql,
                columns: columns,
              })
            }
          }
        } else if (normalizedSql.startsWith('DROP INDEX')) {
          const indexMatch = sql.match(/DROP\s+INDEX\s+["']?(\w+)["']?/i)
          if (indexMatch) {
            const indexName = indexMatch[1]
            // Find and remove index from all tables
            for (const [_tableName, indexes] of tableIndexes.entries()) {
              const indexIndex = indexes.findIndex(
                (idx) => (idx as { name: string }).name === indexName
              )
              if (indexIndex !== -1) {
                indexes.splice(indexIndex, 1)
                return {
                  results: [],
                  success: true,
                  meta: {
                    changes: 1,
                    last_row_id: 0,
                    duration: 1,
                    size_after: 100,
                    rows_read: 0,
                    rows_written: 0,
                    changed_db: false,
                  },
                }
              }
            }
          }
        } else if (
          normalizedSql.startsWith('ALTER TABLE') &&
          normalizedSql.includes('ADD COLUMN')
        ) {
          const tableName = getTableNameFromSql(sql)
          if (tableName) {
            const normalizedName = normalizeTableName(tableName)
            const actualTableName = findTable(normalizedName)

            if (actualTableName && tableColumns.has(actualTableName)) {
              // Parse the new column from ALTER TABLE statement
              const addColumnMatch = sql.match(/ADD\s+COLUMN\s+["']?(\w+)["']?\s+(\w+)/i)

              if (addColumnMatch) {
                const [, columnName, columnType] = addColumnMatch
                const columns = tableColumns.get(actualTableName)
                if (!columns) {
                  throw new Error(`Table "${actualTableName}" columns not found`)
                }
                const newColumn = {
                  cid: columns.length,
                  name: columnName.replace(/["'`]/g, ''),
                  type: columnType,
                  notnull: sql.includes('NOT NULL') ? 1 : 0,
                  dflt_value: null,
                  pk: 0,
                }
                columns.push(newColumn)
              }
            }
          }
        } else if (normalizedSql.startsWith('INSERT')) {
          // Handle snapshot creation
          if (normalizedSql.includes('SCHEMA_SNAPSHOTS')) {
            snapshotCounter++
            const snapshotId = bindings[0] || `snapshot-${snapshotCounter}`
            const snapshot = {
              id: snapshotId,
              version: bindings[1] || snapshotCounter,
              table_name: bindings[2] || 'all_tables',
              schema_json: bindings[3] || '[]',
              name: bindings[4] || `Snapshot ${snapshotCounter}`,
              description: bindings[5] || null,
              full_schema: bindings[6] || '',
              tables_json: bindings[7] || '[]',
              schema_hash: bindings[8] || 'hash',
              created_at: bindings[9] || new Date().toISOString(),
              created_by: bindings[10] || null,
              snapshot_type: bindings[11] || 'manual',
              d1_bookmark_id: bindings[12] || null,
            } as Record<string, unknown>
            snapshots.set(snapshotId as string, snapshot)
            const snapshotsTable = tables.get('schema_snapshots')
            if (snapshotsTable) {
              snapshotsTable.push(snapshot)
            }
          } else {
            // Regular table insert
            const tableName = getTableNameFromSql(sql)
            if (tableName) {
              const normalizedName = normalizeTableName(tableName)
              const actualTableName = findTable(normalizedName)
              if (actualTableName && tables.has(actualTableName)) {
                // Parse column names from INSERT statement
                const columnsMatch = sql.match(/\(([^)]+)\)\s*VALUES/i)
                if (columnsMatch) {
                  const columns = columnsMatch[1]
                    .split(',')
                    .map((col) => col.trim().replace(/["`]/g, ''))

                  // Create record with bound parameters
                  const record: Record<string, unknown> = {
                    id: Math.random().toString(36).substring(2, 18), // Generate random ID
                  }

                  // Map parameters to columns
                  columns.forEach((column, index) => {
                    if (bindings[index] !== undefined) {
                      record[column] = bindings[index]
                    }
                  })

                  // Add timestamp fields if they don't exist
                  record.created_at = record.created_at || new Date().toISOString()
                  record.updated_at = record.updated_at || new Date().toISOString()

                  const tableData = tables.get(actualTableName)
                  if (tableData) {
                    tableData.push(record)
                  }
                }
              }
            }
          }
        } else if (normalizedSql.startsWith('UPDATE')) {
          const tableName = getTableNameFromSql(sql)
          if (tableName) {
            const normalizedName = normalizeTableName(tableName)
            const actualTableName = findTable(normalizedName)
            if (actualTableName && tables.has(actualTableName)) {
              const tableData = tables.get(actualTableName)
              if (!tableData)
                return {
                  results: [],
                  success: true,
                  meta: {
                    changes: 0,
                    last_row_id: 0,
                    duration: 1,
                    size_after: 100,
                    rows_read: 0,
                    rows_written: 0,
                    changed_db: false,
                  },
                }

              let changes = 0

              // Parse SET clause to count bindings
              const setStart = normalizedSql.indexOf('SET') + 3
              const whereStart = normalizedSql.indexOf('WHERE')
              const setClause = sql.substring(setStart, whereStart > -1 ? whereStart : undefined)
              const setBindingsCount = (setClause.match(/\?/g) || []).length

              // Parse WHERE clause
              let targetId: string | null = null
              let targetOwnerId: string | null = null

              if (whereStart > -1) {
                const whereClause = sql.substring(whereStart)

                // Check for ID condition
                if (whereClause.match(/id\s*=\s*\?/i)) {
                  targetId = bindings[setBindingsCount] as string
                }

                // Check for owner_id condition
                if (whereClause.match(/owner_id\s*=\s*\?/i)) {
                  // If ID is present, owner_id is next, otherwise it's first (unlikely for updateRecord)
                  targetOwnerId = bindings[setBindingsCount + (targetId ? 1 : 0)] as string
                }
              }

              // Perform Update
              for (const record of tableData) {
                const r = record as Record<string, unknown>

                // Check conditions
                if (targetId && r.id !== targetId) continue
                if (targetOwnerId && r.owner_id !== targetOwnerId) continue

                // Apply updates
                const setParts = setClause.split(',')
                let bindingIndex = 0

                setParts.forEach((part) => {
                  const match = part.match(/([a-zA-Z0-9_]+)\s*=\s*\?/)
                  if (match) {
                    const colName = match[1]
                    const val = bindings[bindingIndex++]
                    r[colName] = val
                  }
                })

                changes++
              }

              return {
                results: [],
                success: true,
                meta: {
                  changes,
                  last_row_id: 0,
                  duration: 1,
                  size_after: 100,
                  rows_read: 0,
                  rows_written: changes,
                  changed_db: true,
                },
              }
            }
          }
        } else if (normalizedSql.startsWith('DELETE')) {
          const tableName = getTableNameFromSql(sql)
          if (tableName) {
            const normalizedName = normalizeTableName(tableName)
            const actualTableName = findTable(normalizedName)
            if (actualTableName && tables.has(actualTableName)) {
              const tableData = tables.get(actualTableName)
              if (!tableData)
                return {
                  results: [],
                  success: true,
                  meta: {
                    changes: 0,
                    last_row_id: 0,
                    duration: 1,
                    size_after: 100,
                    rows_read: 0,
                    rows_written: 0,
                    changed_db: false,
                  },
                }

              const initialLength = tableData.length

              // Parse WHERE clause
              const whereStart = normalizedSql.indexOf('WHERE')
              let targetId: string | null = null
              let targetOwnerId: string | null = null

              if (whereStart > -1) {
                const whereClause = sql.substring(whereStart)

                // Check for ID condition
                if (whereClause.match(/id\s*=\s*\?/i)) {
                  targetId = bindings[0] as string
                }

                // Check for owner_id condition
                if (whereClause.match(/owner_id\s*=\s*\?/i)) {
                  targetOwnerId = bindings[targetId ? 1 : 0] as string
                }
              }

              // Filter data (keep rows that DO NOT match)
              const newTableData = tableData.filter((record) => {
                const r = record as Record<string, unknown>
                if (targetId && r.id !== targetId) return true
                if (targetOwnerId && r.owner_id !== targetOwnerId) return true
                return false // Match found, delete it
              })

              tables.set(actualTableName, newTableData)
              const changes = initialLength - newTableData.length

              return {
                results: [],
                success: true,
                meta: {
                  changes,
                  last_row_id: 0,
                  duration: 1,
                  size_after: 100,
                  rows_read: 0,
                  rows_written: changes,
                  changed_db: true,
                },
              }
            }
          }
        }

        return {
          results: [] as T[],
          success: true,
          meta: {
            changes: 0,
            last_row_id: 0,
            duration: 1,
            size_after: 100,
            rows_read: 0,
            rows_written: 0,
            changed_db: false,
          },
        }
      },
      all: async <T = unknown>() => {
        const normalizedSql = sql.trim().toUpperCase()

        if (normalizedSql.includes('FROM SQLITE_MASTER')) {
          if (normalizedSql.includes("TYPE='TABLE'")) {
            return {
              results: Array.from(schemas.entries()).map(([name, sql]) => ({
                name,
                sql,
                type: 'table',
              })) as T[],
              success: true,
              meta: {
                changes: 0,
                last_row_id: 0,
                duration: 1,
                size_after: 100,
                rows_read: Array.from(schemas.entries()).length,
                rows_written: 0,
                changed_db: false,
              },
            }
          } else if (normalizedSql.includes("TYPE = 'INDEX'")) {
            const allIndexes: unknown[] = []
            for (const [tableName, indexes] of tableIndexes.entries()) {
              for (const index of indexes) {
                const indexObj = index as { name: string; sql: string }
                allIndexes.push({
                  name: indexObj.name,
                  tbl_name: tableName,
                  sql: indexObj.sql,
                })
              }
            }
            return {
              results: allIndexes as T[],
              success: true,
              meta: {
                changes: 0,
                last_row_id: 0,
                duration: 1,
                size_after: 100,
                rows_read: allIndexes.length,
                rows_written: 0,
                changed_db: false,
              },
            }
          }
        } else if (normalizedSql.startsWith('PRAGMA TABLE_INFO')) {
          const tableName = getTableNameFromSql(sql)
          if (tableName) {
            const normalizedName = normalizeTableName(tableName)
            const actualTableName = findTable(normalizedName)
            if (actualTableName && tableColumns.has(actualTableName)) {
              const columns = tableColumns.get(actualTableName)
              if (!columns) {
                return {
                  results: [] as T[],
                  success: true,
                  meta: {
                    changes: 0,
                    last_row_id: 0,
                    duration: 1,
                    size_after: 100,
                    rows_read: 0,
                    rows_written: 0,
                    changed_db: false,
                  },
                }
              }
              return {
                results: columns as T[],
                success: true,
                meta: {
                  changes: 0,
                  last_row_id: 0,
                  duration: 1,
                  size_after: 100,
                  rows_read: columns.length,
                  rows_written: 0,
                  changed_db: false,
                },
              }
            }
          }
          return {
            results: [] as T[],
            success: true,
            meta: {
              changes: 0,
              last_row_id: 0,
              duration: 1,
              size_after: 100,
              rows_read: 0,
              rows_written: 0,
              changed_db: false,
            },
          }
        } else if (normalizedSql.startsWith('PRAGMA FOREIGN_KEY_LIST')) {
          return {
            results: [] as T[],
            success: true,
            meta: {
              changes: 0,
              last_row_id: 0,
              duration: 1,
              size_after: 100,
              rows_read: 0,
              rows_written: 0,
              changed_db: false,
            },
          }
        } else if (normalizedSql.startsWith('PRAGMA INDEX_LIST')) {
          const tableName = getTableNameFromSql(sql)
          if (tableName) {
            const normalizedName = normalizeTableName(tableName)
            const actualTableName = findTable(normalizedName)
            if (actualTableName && tableIndexes.has(actualTableName)) {
              const indexes = tableIndexes.get(actualTableName)
              if (!indexes) {
                return {
                  results: [] as T[],
                  success: true,
                  meta: {
                    changes: 0,
                    last_row_id: 0,
                    duration: 1,
                    size_after: 100,
                    rows_read: 0,
                    rows_written: 0,
                    changed_db: false,
                  },
                }
              }
              return {
                results: indexes as T[],
                success: true,
                meta: {
                  changes: 0,
                  last_row_id: 0,
                  duration: 1,
                  size_after: 100,
                  rows_read: indexes.length,
                  rows_written: 0,
                  changed_db: false,
                },
              }
            }
          }
          return {
            results: [] as T[],
            success: true,
            meta: {
              changes: 0,
              last_row_id: 0,
              duration: 1,
              size_after: 100,
              rows_read: 0,
              rows_written: 0,
              changed_db: false,
            },
          }
        } else if (normalizedSql.startsWith('PRAGMA INDEX_INFO')) {
          // Extract index name from sql
          const indexMatch = sql.match(/PRAGMA\s+index_info\s*\(\s*"?(\w+)"?\s*\)/i)
          if (indexMatch) {
            const indexName = indexMatch[1]
            // Find index and return column info
            for (const indexes of tableIndexes.values()) {
              const index = indexes.find((idx) => (idx as { name: string }).name === indexName)
              if (index) {
                const indexObj = index as { columns: string[] }
                return {
                  results: indexObj.columns.map((col: string, i: number) => ({
                    seqno: i,
                    cid: i,
                    name: col,
                  })) as T[],
                  success: true,
                  meta: {
                    changes: 0,
                    last_row_id: 0,
                    duration: 1,
                    size_after: 100,
                    rows_read: indexObj.columns.length,
                    rows_written: 0,
                    changed_db: false,
                  },
                }
              }
            }
          }
          return {
            results: [] as T[],
            success: true,
            meta: {
              changes: 0,
              last_row_id: 0,
              duration: 1,
              size_after: 100,
              rows_read: 0,
              rows_written: 0,
              changed_db: false,
            },
          }
        } else if (normalizedSql.startsWith('SELECT COUNT(*)')) {
          if (normalizedSql.includes('SCHEMA_SNAPSHOTS')) {
            return {
              results: [{ total: snapshots.size }] as T[],
              success: true,
              meta: {
                changes: 0,
                last_row_id: 0,
                duration: 1,
                size_after: 100,
                rows_read: 1,
                rows_written: 0,
                changed_db: false,
              },
            }
          }

          // Handle COUNT(*) for other tables
          const tableMatch = sql.match(/FROM\s+["']?(\w+)["']?/i)
          if (tableMatch) {
            const tableName = normalizeTableName(tableMatch[1])
            const actualTableName = findTable(tableName)
            const tableData = actualTableName ? tables.get(actualTableName) || [] : []

            // Handle WHERE clauses in COUNT queries
            if (normalizedSql.includes('WHERE')) {
              const filtered = handleSelectWithWhere(sql, tableData, bindings)
              return {
                results: [
                  { total: filtered.results.length, count: filtered.results.length },
                ] as T[],
                success: true,
                meta: {
                  changes: 0,
                  last_row_id: 0,
                  duration: 1,
                  size_after: 100,
                  rows_read: 1,
                  rows_written: 0,
                  changed_db: false,
                },
              }
            }

            return {
              results: [{ total: tableData.length, count: tableData.length }] as T[],
              success: true,
              meta: {
                changes: 0,
                last_row_id: 0,
                duration: 1,
                size_after: 100,
                rows_read: 1,
                rows_written: 0,
                changed_db: false,
              },
            }
          }

          return {
            results: [{ count: 0 }] as T[],
            success: true,
            meta: {
              changes: 0,
              last_row_id: 0,
              duration: 1,
              size_after: 100,
              rows_read: 0,
              rows_written: 0,
              changed_db: false,
            },
          }
        } else if (
          normalizedSql.startsWith('SELECT') &&
          normalizedSql.includes('FROM SCHEMA_SNAPSHOTS')
        ) {
          const snapshotList = Array.from(snapshots.values())
          if (normalizedSql.includes('ORDER BY version DESC')) {
            snapshotList.sort(
              (a, b) => (b as { version: number }).version - (a as { version: number }).version
            )
          }
          return {
            results: snapshotList as T[],
            success: true,
            meta: {
              changes: 0,
              last_row_id: 0,
              duration: 1,
              size_after: 100,
              rows_read: snapshotList.length,
              rows_written: 0,
              changed_db: false,
            },
          }
        } else if (normalizedSql.startsWith('SELECT')) {
          // Handle general SELECT queries
          const tableMatch = sql.match(/FROM\s+["']?(\w+)["']?/i)
          if (tableMatch) {
            const tableName = normalizeTableName(tableMatch[1])
            const actualTableName = findTable(tableName)
            let tableData = actualTableName ? tables.get(actualTableName) || [] : []

            // Handle WHERE clauses for search functionality
            if (normalizedSql.includes('WHERE')) {
              const filtered = handleSelectWithWhere(sql, tableData, bindings)
              tableData = filtered.results
            }

            // Handle LIMIT and OFFSET for pagination
            let offset = 0
            let limit = tableData.length

            const limitMatch = sql.match(/LIMIT\s+(\?|\d+)(?:\s+OFFSET\s+(\?|\d+))?/i)
            if (limitMatch) {
              let bindingIndex = 0

              // Count ? placeholders before LIMIT in WHERE clause to know binding offset
              const beforeLimit = sql.substring(0, sql.toLowerCase().indexOf('limit'))
              const questionMarksBeforeLimit = (beforeLimit.match(/\?/g) || []).length
              bindingIndex = questionMarksBeforeLimit

              limit =
                limitMatch[1] === '?'
                  ? (bindings?.[bindingIndex] as number) || limit
                  : parseInt(limitMatch[1])
              if (limitMatch[2]) {
                offset =
                  limitMatch[2] === '?'
                    ? (bindings?.[bindingIndex + 1] as number) || 0
                    : parseInt(limitMatch[2])
              }
            }

            // Apply pagination
            const paginatedData = tableData.slice(offset, offset + limit)

            return {
              results: paginatedData as T[],
              success: true,
              meta: {
                changes: 0,
                last_row_id: 0,
                duration: 1,
                size_after: 100,
                rows_read: paginatedData.length,
                rows_written: 0,
                changed_db: false,
              },
            }
          }
        }

        // Handle generic SELECT queries
        if (normalizedSql.startsWith('SELECT')) {
          const tableName = getTableNameFromSql(sql)
          if (tableName) {
            const normalizedName = normalizeTableName(tableName)
            const actualTableName = findTable(normalizedName)
            if (actualTableName && tables.has(actualTableName)) {
              const tableData = tables.get(actualTableName)
              if (!tableData) {
                return {
                  results: [],
                  success: true,
                  meta: {
                    changes: 0,
                    last_row_id: 0,
                    duration: 1,
                    size_after: 100,
                    rows_read: 0,
                    rows_written: 0,
                    changed_db: false,
                  },
                }
              }
              const result = handleSelectWithWhere(sql, tableData, bindings)

              return {
                results: result.results as T[],
                success: true,
                meta: {
                  changes: 0,
                  last_row_id: 0,
                  duration: 1,
                  size_after: 100,
                  rows_read: result.results.length,
                  rows_written: 0,
                  changed_db: false,
                },
              }
            }
          }
        }

        if (normalizedSql.includes('FROM SQLITE_MASTER')) {
          if (normalizedSql.includes("TYPE='TABLE'")) {
            return {
              results: Array.from(schemas.entries()).map(([name, sql]) => ({
                name,
                sql,
                type: 'table',
              })) as T[],
              success: true,
              meta: {
                changes: 0,
                last_row_id: 0,
                duration: 1,
                size_after: 100,
                rows_read: Array.from(schemas.entries()).length,
                rows_written: 0,
                changed_db: false,
              },
            }
          } else if (normalizedSql.includes("TYPE = 'INDEX'")) {
            const allIndexes: unknown[] = []
            for (const [tableName, indexes] of tableIndexes.entries()) {
              for (const index of indexes) {
                const indexObj = index as { name: string; sql: string }
                allIndexes.push({
                  name: indexObj.name,
                  tbl_name: tableName,
                  sql: indexObj.sql,
                })
              }
            }
            return {
              results: allIndexes as T[],
              success: true,
              meta: {
                changes: 0,
                last_row_id: 0,
                duration: 1,
                size_after: 100,
                rows_read: allIndexes.length,
                rows_written: 0,
                changed_db: false,
              },
            }
          }
        }

        return {
          results: [] as T[],
          success: true,
          meta: {
            changes: 0,
            last_row_id: 0,
            duration: 1,
            size_after: 100,
            rows_read: 0,
            rows_written: 0,
            changed_db: false,
          },
        }
      },

      first: async <T = unknown>(_colName?: string) => {
        const normalizedSql = sql.trim().toUpperCase()

        // Handle specific first() queries
        if (normalizedSql.includes('SCHEMA_SNAPSHOT_COUNTER')) {
          return { current_version: snapshotCounter } as T
        } else if (
          normalizedSql.includes('FROM SCHEMA_SNAPSHOTS') &&
          normalizedSql.includes('WHERE ID =')
        ) {
          const snapshotId = bindings[0] as string
          return (snapshots.get(snapshotId) || null) as T
        } else if (
          normalizedSql.includes('FROM SQLITE_MASTER') &&
          normalizedSql.includes('WHERE TYPE') &&
          normalizedSql.includes('AND NAME')
        ) {
          // Check if this is a table lookup
          let targetName = bindings[0] as string

          if (!targetName) {
            const match = sql.match(/name\s*=\s*['"]([^'"]+)['"]/i)

            if (match) {
              targetName = match[1]
            }
          }

          const normalizedName = normalizeTableName(targetName || '')

          if (targetName) {
            if (normalizedSql.includes("TYPE='TABLE'")) {
              const actualTableName = findTable(normalizedName)
              return (
                actualTableName && schemas.has(actualTableName)
                  ? { sql: schemas.get(actualTableName) }
                  : null
              ) as T
            } else if (normalizedSql.includes("TYPE = 'INDEX'")) {
              // Find index across all tables
              for (const indexes of tableIndexes.values()) {
                const index = indexes.find(
                  (idx: unknown) => (idx as { name: string }).name === targetName
                )
                if (index) {
                  return { sql: (index as { sql: string }).sql } as T
                }
              }
              return null
            }
          }

          return (schemas.has(targetName) ? { sql: schemas.get(targetName) } : null) as T
        }

        const result = await createMockStatement(sql, bindings).all()
        return (result.results[0] || null) as T
      },
      raw: async () => {
        const result = await createMockStatement(sql, bindings).all()
        // Return format: [column_names, ...rows]
        if (result.results.length === 0) {
          return [[], []]
        }
        const firstRow = result.results[0] as Record<string, unknown>
        const columnNames = Object.keys(firstRow)
        return [columnNames, ...result.results]
      },
    }
  }

  return {
    prepare: (sql: string) => createMockStatement(sql),
    batch: async <T = unknown>(statements: MockD1PreparedStatement[]) => {
      const results: D1Result<T>[] = []
      for (const stmt of statements) {
        const result = await stmt.run<T>()
        results.push(result)
      }
      return results
    },
    exec: async (sql: string): Promise<D1ExecResult> => {
      // Split SQL by semicolons and execute each statement
      const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

      for (const statement of statements) {
        const preparedStatement = createMockStatement(statement)
        await preparedStatement.run()
      }

      return {
        count: statements.length,
        duration: 1,
      }
    },
    withSession: (_constraintOrBookmark?: string): D1DatabaseSession => {
      // Return a mock session that behaves like the database itself for now
      // In a real implementation, this would handle transactions/consistency
      return {
        prepare: (sql: string) => createMockStatement(sql),
        batch: async <T = unknown>(statements: MockD1PreparedStatement[]) => {
          const results: D1Result<T>[] = []
          for (const stmt of statements) {
            const result = await stmt.run<T>()
            results.push(result)
          }
          return results
        },
        exec: async (sql: string): Promise<D1ExecResult> => {
          const statements = sql
            .split(';')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
          for (const statement of statements) {
            const preparedStatement = createMockStatement(statement)
            await preparedStatement.run()
          }
          return { count: statements.length, duration: 1 }
        },
        dump: async () => new ArrayBuffer(0),
      } as unknown as D1DatabaseSession
    },
    dump: async () => {
      return new ArrayBuffer(0)
    },
  }
}

// Create mock R2 bucket
export function createMockR2Bucket(): MockR2Bucket {
  const storage = new Map<string, string>()

  return {
    get: async (key: string) => {
      const data = storage.get(key)
      return data
        ? {
            key,
            version: '1',
            size: data.length,
            etag: 'mock-etag',
            httpEtag: '"mock-etag"',
            uploaded: new Date(),
            checksums: {} as Record<string, string>,
            text: async () => data,
            json: async () => JSON.parse(data),
            arrayBuffer: async () => new TextEncoder().encode(data).buffer as ArrayBuffer,
            blob: async () => new Blob([data]),
          }
        : null
    },
    put: async (key: string, data: string) => {
      storage.set(key, data)
      return {
        key,
        version: '1',
        size: data.length,
        etag: 'mock-etag',
        httpEtag: '"mock-etag"',
        uploaded: new Date(),
        checksums: {} as Record<string, string>,
        text: async () => data,
        json: async () => JSON.parse(data),
        arrayBuffer: async () => new TextEncoder().encode(data).buffer as ArrayBuffer,
        blob: async () => new Blob([data]),
      }
    },
    delete: async (key: string) => {
      storage.delete(key)
    },
    list: async (_options?: Record<string, unknown>) => {
      return { objects: [], truncated: false, delimitedPrefixes: [] }
    },
    head: async (_key: string) => {
      return null
    },
  }
}

// Create mock execution context
export function createMockExecutionContext(): MockExecutionContext {
  const promises: Promise<unknown>[] = []

  return {
    waitUntil: (promise: Promise<unknown>) => {
      promises.push(promise)
      // Execute the promise immediately in tests to ensure it completes
      promise.catch((error) => {
        console.warn('waitUntil promise failed:', error)
      })
    },
    passThroughOnException: () => {
      // In tests, this is a no-op
    },
  }
}
