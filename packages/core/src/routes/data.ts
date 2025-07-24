import { Hono } from 'hono'
import { TableManager } from '../lib/table-manager'
import { getAuthContext, getCurrentEndUser } from '../middleware/auth'
import type { Env, Variables } from '../types'
import type { CustomDurableObjectNamespace, TableDataResult } from '../types/cloudflare'
import type { WhereClause } from '../types/database'

export const data = new Hono<{ Bindings: Env; Variables: Variables }>()

// Middleware to add table manager instance
data.use('*', async (c, next) => {
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

// Middleware to validate table exists and check access policies
data.use('/:tableName/*', async (c, next) => {
  const tm = c.get('tableManager') as TableManager
  const tableName = c.req.param('tableName')

  try {
    const tables = await tm.getTables()
    const table = tables.find((t) => t.name === tableName)

    if (!table) {
      return c.json({ error: `Table '${tableName}' not found` }, 404)
    }

    // Allow read access to system tables for display purposes
    // (Write operations are still protected in individual endpoints)

    // Get authentication context to determine access control
    const authContext = getAuthContext(c)
    const currentUser = getCurrentEndUser(c)

    // Set table info and user context for later use
    c.set('tableInfo', table)
    c.set('currentEndUser', currentUser)
    c.set('authContext', authContext)

    await next()
  } catch (error) {
    console.error('Error validating table:', error)
    return c.json({ error: 'Failed to validate table' }, 500)
  }
})

// GET /api/data/:tableName - Get all records with pagination
data.get('/:tableName', async (c) => {
  const tm = c.get('tableManager') as TableManager
  const tableName = c.req.param('tableName')
  const tableInfo = c.get('tableInfo')
  const authContext = c.get('authContext')
  const currentUser = c.get('currentEndUser')

  try {
    // Support both offset-based and page-based pagination
    const offsetParam = c.req.query('offset')
    const pageParam = c.req.query('page')
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || '20')))

    let offset: number
    let page: number

    if (offsetParam !== undefined) {
      // Offset-based pagination (preferred)
      offset = Math.max(0, Number(offsetParam || '0'))
      page = Math.floor(offset / limit) + 1
    } else {
      // Page-based pagination (backward compatibility)
      page = Math.max(1, Number(pageParam || '1'))
      offset = (page - 1) * limit
    }

    // Get table columns to determine default sort field
    const columns = await tm.getTableColumns(tableName)
    const validColumns = columns.map((col) => col.name)
    const hasCreatedAt = columns.some((col) => col.name === 'created_at')

    const sortBy =
      c.req.query('sortBy') || (hasCreatedAt ? 'created_at' : validColumns[0] || 'ROWID')
    const sortOrder = c.req.query('sortOrder') === 'asc' ? 'ASC' : 'DESC'

    if (sortBy !== 'ROWID' && !validColumns.includes(sortBy)) {
      return c.json(
        {
          error: `Invalid sort field '${sortBy}'. Valid fields: ${validColumns.join(', ')}`,
        },
        400
      )
    }

    // Parse WHERE clause from query parameter
    let whereClause: WhereClause | undefined
    const whereParam = c.req.query('where')
    if (whereParam) {
      try {
        whereClause = JSON.parse(whereParam)
      } catch (_error) {
        return c.json(
          {
            error: 'Invalid WHERE clause format. Must be valid JSON.',
          },
          400
        )
      }
    }

    let result: TableDataResult

    // Apply access control based on authentication type and table policy
    if (authContext?.type === 'admin') {
      // Admins can access all data
      result = await tm.getTableDataWithSortAndFilter(
        tableName,
        limit,
        offset,
        sortBy,
        sortOrder,
        whereClause
      )
    } else if (authContext?.type === 'user' && currentUser) {
      // Users get access control applied
      result = await tm.getTableDataWithAccessControlAndFilter(
        tableName,
        currentUser.id,
        limit,
        offset,
        sortBy,
        sortOrder,
        whereClause
      )
    } else if (authContext?.type === 'api_key') {
      // API keys can access data based on scopes and table policy
      // For now, treat API keys as admin-level access
      // TODO: Implement proper API key scoping
      result = await tm.getTableDataWithSortAndFilter(
        tableName,
        limit,
        offset,
        sortBy,
        sortOrder,
        whereClause
      )
    } else {
      return c.json({ error: 'Authentication required' }, 401)
    }

    const baseUrl = new URL(c.req.url).origin

    return c.json({
      data: result.data,
      pagination: {
        page,
        limit,
        offset,
        total: result.total,
        totalPages: Math.ceil(result.total / limit),
        hasNext: offset + limit < result.total,
        hasPrev: offset > 0,
      },
      sort: { by: sortBy, order: sortOrder },
      access_info: {
        table_policy: tableInfo?.access_policy || 'public',
        auth_type: authContext?.type || 'none',
      },
      _links: {
        documentation: {
          swagger: `${baseUrl}/api/docs/swagger`,
          table_spec: `${baseUrl}/api/docs/tables/${tableName}`,
          description: `API documentation for ${tableName} table`,
        },
      },
    })
  } catch (error) {
    console.error('Error fetching table data:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to fetch data',
      },
      500
    )
  }
})

// GET /api/data/:tableName/:id - Get single record
data.get('/:tableName/:id', async (c) => {
  const tm = c.get('tableManager') as TableManager
  const tableName = c.req.param('tableName')
  const id = c.req.param('id')
  const authContext = c.get('authContext')
  const currentUser = c.get('currentEndUser')

  try {
    let record: Record<string, unknown> | null

    // Apply access control based on authentication type
    if (authContext?.type === 'admin') {
      // Admins can access all records
      record = await tm.getRecordById(tableName, id)
    } else if (authContext?.type === 'user' && currentUser) {
      // Users get access control applied
      record = await tm.getRecordByIdWithAccessControl(tableName, id, currentUser.id)
    } else if (authContext?.type === 'api_key') {
      // API keys can access records based on scopes and table policy
      // For now, treat API keys as admin-level access
      record = await tm.getRecordById(tableName, id)
    } else {
      return c.json({ error: 'Authentication required' }, 401)
    }

    if (!record) {
      return c.json({ error: `Record with id '${id}' not found` }, 404)
    }

    return c.json({ data: record })
  } catch (error) {
    console.error('Error fetching record:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to fetch record',
      },
      500
    )
  }
})

// POST /api/data/:tableName - Create new record
data.post('/:tableName', async (c) => {
  const tm = c.get('tableManager') as TableManager
  const tableName = c.req.param('tableName')
  const authContext = c.get('authContext')
  const currentUser = c.get('currentEndUser')
  const tableInfo = c.get('tableInfo')

  try {
    const body = await c.req.json()

    // Validate request body is an object
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Request body must be a valid JSON object' }, 400)
    }

    // Get table schema for validation
    const columns = await tm.getTableColumns(tableName)
    const errors = await validateRecordData(body, columns, 'create')

    if (errors.length > 0) {
      return c.json({ error: 'Validation failed', details: errors }, 400)
    }

    let id: string

    // Apply access control based on authentication type
    console.log(
      `[DATA-ROUTE] Creating record in ${tableName}, authContext:`,
      authContext?.type,
      'currentUser:',
      currentUser?.id
    )

    if (authContext?.type === 'admin') {
      // Admins can create records normally
      console.log(`[DATA-ROUTE] Using admin flow for ${tableName}`)
      id = await tm.createRecordWithId(tableName, body)
    } else if (authContext?.type === 'user' && currentUser) {
      // Users get owner_id automatically set for private tables
      console.log(
        `[DATA-ROUTE] Using user access control flow for ${tableName}, userId: ${currentUser.id}`
      )
      id = await tm.createRecordWithAccessControl(tableName, body, currentUser.id)
    } else if (authContext?.type === 'api_key') {
      // API keys can create records (for now, treat as admin-level)
      console.log(`[DATA-ROUTE] Using API key flow for ${tableName}`)
      id = await tm.createRecordWithId(tableName, body)
    } else {
      console.log(`[DATA-ROUTE] No valid authentication for ${tableName}`)
      return c.json({ error: 'Authentication required' }, 401)
    }

    // Get the created record to return (with access control)
    let createdRecord: Record<string, unknown> | null
    if (authContext?.type === 'user' && currentUser) {
      createdRecord = await tm.getRecordByIdWithAccessControl(tableName, id, currentUser.id)
    } else {
      createdRecord = await tm.getRecordById(tableName, id)
    }

    return c.json(
      {
        success: true,
        data: createdRecord || { id, ...body },
        message: 'Record created successfully',
        access_info: {
          table_policy: tableInfo?.access_policy || 'public',
          auth_type: authContext?.type || 'none',
        },
        debug_info: {
          auth_context_type: authContext?.type,
          current_user_id: currentUser?.id,
          method_used:
            authContext?.type === 'user' && currentUser
              ? 'createRecordWithAccessControl'
              : 'createRecordWithId',
        },
      },
      201
    )
  } catch (error) {
    console.error('Error creating record:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to create record',
      },
      400
    )
  }
})

// PUT /api/data/:tableName/:id - Update record
data.put('/:tableName/:id', async (c) => {
  const tm = c.get('tableManager') as TableManager
  const tableName = c.req.param('tableName')
  const id = c.req.param('id')

  try {
    const body = await c.req.json()

    // Validate request body is an object
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Request body must be a valid JSON object' }, 400)
    }

    // Get authentication context
    const authContext = c.get('authContext')
    const currentUser = c.get('currentEndUser')

    // Determine authentication type
    const isAdminOrApiKey = authContext?.type === 'admin' || authContext?.type === 'api_key'
    const isUser = authContext?.type === 'user' && currentUser

    if (!isAdminOrApiKey && !isUser) {
      return c.json({ error: 'Authentication required' }, 401)
    }

    // Check if record exists with proper access control
    const existingRecord = isAdminOrApiKey
      ? await tm.getRecordById(tableName, id)
      : await tm.getRecordByIdWithAccessControl(tableName, id, currentUser?.id)

    if (!existingRecord) {
      return c.json({ error: `Record with id '${id}' not found` }, 404)
    }

    // Get table schema for validation
    const columns = await tm.getTableColumns(tableName)
    const errors = await validateRecordData(body, columns, 'update')

    if (errors.length > 0) {
      return c.json({ error: 'Validation failed', details: errors }, 400)
    }

    // Update record with proper access control
    if (isAdminOrApiKey) {
      await tm.updateRecord(tableName, id, body)
    } else {
      console.log(
        `[DATA-ROUTE] Update record: tableName=${tableName}, id=${id}, currentUser?.id=${currentUser?.id}`
      )
      await tm.updateRecordWithAccessControl(tableName, id, body, currentUser?.id)
    }

    // Get updated record
    const updatedRecord = isAdminOrApiKey
      ? await tm.getRecordById(tableName, id)
      : await tm.getRecordByIdWithAccessControl(tableName, id, currentUser?.id)

    return c.json({
      success: true,
      data: updatedRecord,
      message: 'Record updated successfully',
    })
  } catch (error) {
    console.error('Error updating record:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to update record',
      },
      400
    )
  }
})

// DELETE /api/data/:tableName/:id - Delete record
data.delete('/:tableName/:id', async (c) => {
  const tm = c.get('tableManager') as TableManager
  const tableName = c.req.param('tableName')
  const id = c.req.param('id')

  try {
    // Get authentication context
    const authContext = c.get('authContext')
    const currentUser = c.get('currentEndUser')

    // Determine authentication type
    const isAdminOrApiKey = authContext?.type === 'admin' || authContext?.type === 'api_key'
    const isUser = authContext?.type === 'user' && currentUser

    if (!isAdminOrApiKey && !isUser) {
      return c.json({ error: 'Authentication required' }, 401)
    }

    // Check if record exists with proper access control
    const existingRecord = isAdminOrApiKey
      ? await tm.getRecordById(tableName, id)
      : await tm.getRecordByIdWithAccessControl(tableName, id, currentUser?.id)

    if (!existingRecord) {
      return c.json({ error: `Record with id '${id}' not found` }, 404)
    }

    // Delete record with proper access control
    if (isAdminOrApiKey) {
      await tm.deleteRecord(tableName, id)
    } else {
      await tm.deleteRecordWithAccessControl(tableName, id, currentUser?.id)
    }

    return c.json({
      success: true,
      message: 'Record deleted successfully',
    })
  } catch (error) {
    console.error('Error deleting record:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to delete record',
      },
      400
    )
  }
})

// Helper function to validate record data against table schema
async function validateRecordData(
  data: Record<string, unknown>,
  columns: Array<{ name: string; type: string; notnull: number }>,
  operation: 'create' | 'update'
): Promise<string[]> {
  const errors: string[] = []

  // Skip validation for system columns
  const systemColumns = ['id', 'created_at', 'updated_at']
  const userColumns = columns.filter((col) => !systemColumns.includes(col.name))

  for (const column of userColumns) {
    const value = data[column.name]
    const hasValue = value !== undefined && value !== null && value !== ''

    // Check required fields (NOT NULL constraint)
    if (operation === 'create' && column.notnull && !hasValue) {
      errors.push(`Field '${column.name}' is required`)
      continue
    }

    // Skip validation if no value provided for update
    if (operation === 'update' && !hasValue) {
      continue
    }

    // Type validation
    if (hasValue) {
      const typeError = validateFieldType(column.name, value, column.type)
      if (typeError) {
        errors.push(typeError)
      }
    }
  }

  return errors
}

function validateFieldType(fieldName: string, value: unknown, sqlType: string): string | null {
  const type = sqlType.toUpperCase()

  switch (type) {
    case 'INTEGER':
      if (!Number.isInteger(Number(value))) {
        return `Field '${fieldName}' must be an integer`
      }
      break
    case 'REAL':
      if (Number.isNaN(Number(value))) {
        return `Field '${fieldName}' must be a number`
      }
      break
    case 'TEXT':
      if (typeof value !== 'string') {
        return `Field '${fieldName}' must be a string`
      }
      break
    case 'BOOLEAN':
      if (typeof value !== 'boolean' && value !== 0 && value !== 1) {
        return `Field '${fieldName}' must be a boolean`
      }
      break
    case 'BLOB':
      // Accept any value for BLOB
      break
    default:
      // For custom types, accept any value
      break
  }

  return null
}
