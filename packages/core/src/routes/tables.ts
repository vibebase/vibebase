import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { SYSTEM_TABLES, TableManager } from '../lib/table-manager'
import type { Env, Variables } from '../types'
import type { CustomDurableObjectNamespace } from '../types/cloudflare'

export const tables = new Hono<{ Bindings: Env; Variables: Variables }>()

// Middleware to add table manager instance
tables.use('*', async (c, next) => {
  if (!c.env.DB) {
    console.error('Database not available in environment')
    return c.json({ error: 'Database not configured' }, 500)
  }
  c.set(
    'tableManager',
    new TableManager(c.env.DB, c.env.SYSTEM_STORAGE, c.executionCtx, {
      REALTIME: c.env.REALTIME as CustomDurableObjectNamespace,
      WORKER_DOMAIN: c.env.WORKER_DOMAIN,
    })
  )
  await next()
})

// Get all tables
tables.get('/', async (c) => {
  try {
    const tm = c.get('tableManager')
    if (!tm) {
      return c.json({ error: 'TableManager not available' }, 500)
    }
    const tables = await tm.getTables()
    const baseUrl = new URL(c.req.url).origin

    return c.json({
      tables,
      documentation: {
        swagger: `${baseUrl}/api/docs/swagger`,
        openapi: `${baseUrl}/api/docs/openapi.json`,
        description: 'Interactive API documentation for all your tables',
      },
    })
  } catch (error) {
    console.error('Error fetching tables:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to fetch tables',
        details: error instanceof Error ? error.stack : undefined,
      },
      500
    )
  }
})

// Get table schema
tables.get('/:tableName/schema', async (c) => {
  const tm = c.get('tableManager')
  if (!tm) {
    return c.json({ error: 'Database not available' }, 500)
  }

  try {
    const tableName = c.req.param('tableName')
    const columns = await tm.getTableColumns(tableName)
    const foreignKeys = await tm.getForeignKeys(tableName)
    return c.json({ tableName, columns, foreignKeys })
  } catch (error) {
    console.error('Error fetching table schema:', error)
    return c.json({ error: 'Failed to fetch table schema' }, 500)
  }
})

// Get table data

// Create new table
const createTableSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Invalid table name'),
  columns: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Invalid column name'),
        type: z.enum(['TEXT', 'INTEGER', 'REAL', 'BLOB', 'BOOLEAN']),
        constraints: z.string().optional(),
        foreignKey: z
          .object({
            table: z.string(),
            column: z.string(),
          })
          .optional(),
      })
    )
    .min(1),
})

tables.post('/', zValidator('json', createTableSchema), async (c) => {
  const tm = c.get('tableManager')
  if (!tm) {
    return c.json({ error: 'Database not available' }, 500)
  }

  try {
    const data = c.req.valid('json')
    await tm.createTable(data.name, data.columns)
    return c.json({ success: true, table: data.name }, 201)
  } catch (error) {
    console.error('Error creating table:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to create table',
      },
      400
    )
  }
})

// Drop table
tables.delete('/:tableName', async (c) => {
  const tm = c.get('tableManager')
  if (!tm) {
    return c.json({ error: 'Database not available' }, 500)
  }

  try {
    const tableName = c.req.param('tableName')
    await tm.dropTable(tableName)
    return c.json({ success: true, table: tableName })
  } catch (error) {
    console.error('Error dropping table:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to drop table',
      },
      400
    )
  }
})

// Add column to table
const addColumnSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Invalid column name'),
  type: z.enum(['TEXT', 'INTEGER', 'REAL', 'BLOB', 'BOOLEAN']),
  constraints: z.string().optional(),
  foreignKey: z
    .object({
      table: z.string(),
      column: z.string(),
    })
    .optional(),
})

tables.post('/:tableName/columns', zValidator('json', addColumnSchema), async (c) => {
  const tm = c.get('tableManager')
  if (!tm) {
    return c.json({ error: 'Database not available' }, 500)
  }

  try {
    const tableName = c.req.param('tableName')
    const column = c.req.valid('json')

    await tm.addColumn(tableName, column)
    return c.json({ success: true, column: column.name }, 201)
  } catch (error) {
    console.error('Error adding column:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to add column',
      },
      400
    )
  }
})

// Rename column
const renameColumnSchema = z.object({
  oldName: z.string(),
  newName: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Invalid column name'),
})

tables.put('/:tableName/columns/:columnName', zValidator('json', renameColumnSchema), async (c) => {
  const tm = c.get('tableManager')
  if (!tm) {
    return c.json({ error: 'Database not available' }, 500)
  }

  try {
    const tableName = c.req.param('tableName')
    const { oldName, newName } = c.req.valid('json')

    await tm.renameColumn(tableName, oldName, newName)
    return c.json({ success: true, oldName, newName })
  } catch (error) {
    console.error('Error renaming column:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to rename column',
      },
      400
    )
  }
})

// Drop column
tables.delete('/:tableName/columns/:columnName', async (c) => {
  const tm = c.get('tableManager')
  if (!tm) {
    return c.json({ error: 'Database not available' }, 500)
  }

  try {
    const tableName = c.req.param('tableName')
    const columnName = c.req.param('columnName')

    // Prevent dropping system columns
    if (['id', 'created_at', 'updated_at'].includes(columnName)) {
      return c.json({ error: 'Cannot drop system column' }, 403)
    }

    await tm.dropColumn(tableName, columnName)
    return c.json({ success: true, column: columnName })
  } catch (error) {
    console.error('Error dropping column:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to drop column',
      },
      400
    )
  }
})

// Modify column constraints/type
const modifyColumnSchema = z.object({
  type: z.enum(['TEXT', 'INTEGER', 'REAL', 'BLOB', 'BOOLEAN']).optional(),
  notNull: z.boolean().optional(),
  foreignKey: z
    .object({
      table: z.string(),
      column: z.string(),
    })
    .nullable()
    .optional(),
})

tables.patch(
  '/:tableName/columns/:columnName',
  zValidator('json', modifyColumnSchema),
  async (c) => {
    const tm = c.get('tableManager')
    if (!tm) {
      return c.json({ error: 'Database not available' }, 500)
    }

    try {
      const tableName = c.req.param('tableName')
      const columnName = c.req.param('columnName')
      const changes = c.req.valid('json')

      // Prevent modifying system columns
      if (['id', 'created_at', 'updated_at'].includes(columnName)) {
        return c.json({ error: 'Cannot modify system column' }, 403)
      }

      // Transform the changes to match the expected format
      const transformedChanges = {
        type: changes.type || 'TEXT',
        constraints: changes.notNull ? 'NOT NULL' : undefined,
      }

      await tm.modifyColumn(tableName, columnName, transformedChanges)
      return c.json({ success: true, column: columnName, changes })
    } catch (error) {
      console.error('Error modifying column:', error)
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Failed to modify column',
        },
        400
      )
    }
  }
)

// Validate column changes before applying
tables.post(
  '/:tableName/columns/:columnName/validate',
  zValidator('json', modifyColumnSchema),
  async (c) => {
    const tm = c.get('tableManager')
    if (!tm) {
      return c.json({ error: 'Database not available' }, 500)
    }

    try {
      const tableName = c.req.param('tableName')
      const columnName = c.req.param('columnName')
      const changes = c.req.valid('json')

      const validation = await tm.validateColumnChanges(tableName, columnName, changes)
      return c.json(validation)
    } catch (error) {
      console.error('Error validating column changes:', error)
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Failed to validate column changes',
        },
        400
      )
    }
  }
)

// Execute SQL query
const executeSQLSchema = z.object({
  sql: z.string().min(1),
  params: z.array(z.unknown()).optional(),
})

tables.post('/query', zValidator('json', executeSQLSchema), async (c) => {
  const tm = c.get('tableManager')
  if (!tm) {
    return c.json({ error: 'Database not available' }, 500)
  }

  try {
    const { sql } = c.req.valid('json')
    const result = await tm.executeSQL(sql)
    return c.json({ result })
  } catch (error) {
    console.error('Error executing SQL:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to execute SQL',
      },
      400
    )
  }
})

// Index management endpoints

// Get all indexes across all tables
tables.get('/indexes', async (c) => {
  try {
    const tableManager = c.get('tableManager')
    if (!tableManager) {
      return c.json({ error: 'TableManager not available' }, 500)
    }
    const indexes = await tableManager.getAllUserIndexes()
    return c.json({ indexes })
  } catch (error) {
    console.error('Error getting all indexes:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to get indexes',
      },
      500
    )
  }
})

// Get indexes for a specific table
tables.get('/:tableName/indexes', async (c) => {
  try {
    const tableName = c.req.param('tableName')
    const tableManager = c.get('tableManager')
    if (!tableManager) {
      return c.json({ error: 'TableManager not available' }, 500)
    }

    const indexes = await tableManager.getTableIndexes(tableName)
    return c.json({ indexes })
  } catch (error) {
    console.error('Error getting table indexes:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to get table indexes',
      },
      500
    )
  }
})

// Create index
const createIndexSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Invalid index name'),
  columns: z.array(z.string()).min(1, 'At least one column is required'),
  unique: z.boolean().optional().default(false),
})

tables.post('/:tableName/indexes', zValidator('json', createIndexSchema), async (c) => {
  try {
    const tableName = c.req.param('tableName')
    const { name, columns, unique } = c.req.valid('json')
    const tableManager = c.get('tableManager')
    if (!tableManager) {
      return c.json({ error: 'TableManager not available' }, 500)
    }

    await tableManager.createIndex(name, tableName, columns, { unique })

    // Get the created index info
    const indexes = await tableManager.getTableIndexes(tableName)
    const createdIndex = indexes.find((idx) => idx.name === name)

    return c.json({
      success: true,
      index: createdIndex,
      message: `Index "${name}" created successfully`,
    })
  } catch (error) {
    console.error('Error creating index:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to create index',
      },
      400
    )
  }
})

// Drop index
tables.delete('/:tableName/indexes/:indexName', async (c) => {
  try {
    const indexName = c.req.param('indexName')
    const tableManager = c.get('tableManager')
    if (!tableManager) {
      return c.json({ error: 'TableManager not available' }, 500)
    }

    await tableManager.dropIndex(indexName)

    return c.json({
      success: true,
      message: `Index "${indexName}" dropped successfully`,
    })
  } catch (error) {
    console.error('Error dropping index:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to drop index',
      },
      400
    )
  }
})

// Search records in table
const searchQuerySchema = z.object({
  column: z.string().min(1, 'Column name is required'),
  operator: z.enum(['eq', 'lt', 'le', 'gt', 'ge', 'ne', 'is_null', 'is_not_null'], {
    errorMap: () => ({
      message: 'Invalid operator. Supported: eq, lt, le, gt, ge, ne, is_null, is_not_null',
    }),
  }),
  value: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : undefined)),
  offset: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : 0)),
})

tables.get('/:tableName/search', zValidator('query', searchQuerySchema), async (c) => {
  try {
    const tableName = c.req.param('tableName')
    const { column, operator, value, limit, offset } = c.req.valid('query')
    const tableManager = c.get('tableManager')
    if (!tableManager) {
      return c.json({ error: 'TableManager not available' }, 500)
    }

    // Check if table is a system table
    if (SYSTEM_TABLES.includes(tableName as (typeof SYSTEM_TABLES)[number])) {
      return c.json(
        {
          error: {
            code: 'SYSTEM_TABLE_ACCESS_DENIED',
            message: `Search is not allowed on system table '${tableName}'`,
          },
        },
        403
      )
    }

    // Validate value requirement for non-null operators
    if (!['is_null', 'is_not_null'].includes(operator) && !value) {
      return c.json(
        {
          error: {
            code: 'MISSING_VALUE',
            message: `Value is required for operator '${operator}'`,
          },
        },
        400
      )
    }

    // Get searchable columns for the table
    const searchableColumns = await tableManager.getSearchableColumns(tableName)

    if (!searchableColumns.find((col) => col.name === column)) {
      return c.json(
        {
          error: {
            code: 'COLUMN_NOT_SEARCHABLE',
            message: `Column '${column}' is not searchable (no index found)`,
            details: {
              table: tableName,
              column: column,
              searchableColumns: searchableColumns.map((col) => col.name),
            },
          },
        },
        400
      )
    }

    // Get column info to validate operator
    const columnInfo = searchableColumns.find((col) => col.name === column)
    if (!columnInfo) {
      return c.json(
        {
          error: {
            code: 'COLUMN_NOT_FOUND',
            message: `Column '${column}' not found in searchable columns`,
          },
        },
        400
      )
    }
    const supportedOperators =
      columnInfo.type === 'TEXT'
        ? ['eq', 'is_null', 'is_not_null']
        : ['eq', 'lt', 'le', 'gt', 'ge', 'ne', 'is_null', 'is_not_null']

    if (!supportedOperators.includes(operator)) {
      return c.json(
        {
          error: {
            code: 'INVALID_OPERATOR',
            message: `Operator '${operator}' is not supported for ${columnInfo.type} columns`,
            details: {
              column: column,
              columnType: columnInfo.type,
              supportedOperators: supportedOperators,
            },
          },
        },
        400
      )
    }

    // Validate value type for INTEGER columns
    if (columnInfo.type === 'INTEGER' && value && !['is_null', 'is_not_null'].includes(operator)) {
      const numValue = Number(value)
      if (Number.isNaN(numValue) || !Number.isInteger(numValue)) {
        return c.json(
          {
            error: {
              code: 'TYPE_MISMATCH',
              message: 'Invalid value type for INTEGER column',
              details: {
                column: column,
                expectedType: 'INTEGER',
                receivedValue: value,
              },
            },
          },
          400
        )
      }
    }

    // Perform search
    const result = await tableManager.searchRecords(
      tableName,
      [
        {
          column,
          operator,
          value: value || '',
        },
      ],
      limit,
      offset || 0
    )

    return c.json({
      data: result.data,
      pagination: {
        total: result.total,
        limit: limit || result.total,
        offset: offset || 0,
        hasMore: result.hasMore,
      },
      query: {
        table: tableName,
        column,
        operator,
        value,
      },
    })
  } catch (error) {
    console.error('Error searching records:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to search records',
      },
      500
    )
  }
})

// Get table access policy
tables.get('/:tableName/policy', async (c) => {
  try {
    const tableName = c.req.param('tableName')
    const tableManager = c.get('tableManager')
    if (!tableManager) {
      return c.json({ error: 'TableManager not available' }, 500)
    }

    // Check if table is a system table
    if (SYSTEM_TABLES.includes(tableName as (typeof SYSTEM_TABLES)[number])) {
      return c.json({
        table_name: tableName,
        access_policy: 'system',
        message: 'System tables have fixed access policies',
      })
    }

    const policy = await tableManager.getTableAccessPolicy(tableName)

    return c.json({
      table_name: tableName,
      access_policy: policy,
    })
  } catch (error) {
    console.error('Error getting table policy:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to get table policy',
      },
      500
    )
  }
})

// Update table access policy (admin only)
const policyUpdateSchema = z.object({
  access_policy: z.enum(['public', 'private'], {
    errorMap: () => ({ message: 'Access policy must be either "public" or "private"' }),
  }),
})

tables.put('/:tableName/policy', zValidator('json', policyUpdateSchema), async (c) => {
  try {
    const tableName = c.req.param('tableName')
    const { access_policy } = c.req.valid('json')
    const tableManager = c.get('tableManager')
    if (!tableManager) {
      return c.json({ error: 'TableManager not available' }, 500)
    }

    // Check if table is a system table
    if (SYSTEM_TABLES.includes(tableName as (typeof SYSTEM_TABLES)[number])) {
      return c.json(
        {
          error: 'Cannot modify access policy for system tables',
        },
        403
      )
    }

    // Verify table exists
    const tables = await tableManager.getTables()
    const table = tables.find((t) => t.name === tableName)
    if (!table) {
      return c.json(
        {
          error: `Table '${tableName}' not found`,
        },
        404
      )
    }

    // When changing from public to private, verify owner_id column exists
    if (table.access_policy === 'public' && access_policy === 'private') {
      const columns = await tableManager.getTableColumns(tableName)
      const hasOwnerIdColumn = columns.some((col) => col.name === 'owner_id')

      if (!hasOwnerIdColumn) {
        return c.json(
          {
            error: `Cannot change table '${tableName}' to private: missing owner_id column. Private tables require an owner_id column for access control.`,
          },
          400
        )
      }
    }

    await tableManager.setTableAccessPolicy(tableName, access_policy)

    return c.json({
      success: true,
      table_name: tableName,
      access_policy: access_policy,
      message: `Access policy for table '${tableName}' updated to '${access_policy}'`,
    })
  } catch (error) {
    console.error('Error updating table policy:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to update table policy',
      },
      500
    )
  }
})
