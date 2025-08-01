import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { generateId } from '../lib/utils'
import type { Env, Variables } from '../types'

export const customQueries = new Hono<{ Bindings: Env; Variables: Variables }>()

// Simple in-memory cache for query results
const queryCache = new Map<string, { data: unknown[]; execution_time: number; timestamp: number }>()

function getCachedResult(cacheKey: string, cacheTtl: number) {
  const cached = queryCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < cacheTtl * 1000) {
    return cached
  }
  return null
}

function setCachedResult(cacheKey: string, data: unknown[], executionTime: number) {
  queryCache.set(cacheKey, { data, execution_time: executionTime, timestamp: Date.now() })
}

// Type definitions
interface Parameter {
  name: string
  type: 'string' | 'number' | 'boolean' | 'date'
  required: boolean
  description?: string
  default?: string | number | boolean
}

interface CustomQuery {
  id: string
  slug: string
  name: string
  description?: string
  sql_query: string
  parameters: Parameter[]
  method: string
  is_readonly: boolean
  cache_ttl: number
  is_enabled: boolean
  created_at: string
  updated_at: string
}

// Parameter definition schema
const parameterSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Invalid parameter name'),
  type: z.enum(['string', 'number', 'boolean', 'date']),
  required: z.boolean().default(false),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
})

// Helper function to determine HTTP method based on SQL
function determineHttpMethod(sql: string): 'GET' | 'POST' {
  const trimmedSql = sql.trim().toLowerCase()
  return trimmedSql.startsWith('select') ? 'GET' : 'POST'
}

// Helper function to determine if query is readonly
function isReadonlyQuery(sql: string): boolean {
  const trimmedSql = sql.trim().toLowerCase()
  return trimmedSql.startsWith('select') || trimmedSql.includes('pragma')
}

// Create/Update custom query schema
const customQuerySchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9_-]+$/, 'Slug must be lowercase alphanumeric with hyphens and underscores'),
  name: z.string().min(1),
  description: z
    .string()
    .optional()
    .transform((val) => val || undefined),
  sql_query: z.string().min(1),
  parameters: z.array(parameterSchema).default([]),
  cache_ttl: z.number().min(0).default(0),
  is_enabled: z.boolean().default(false),
})

// Test query schema
const testQuerySchema = z.object({
  parameters: z.record(z.unknown()).default({}),
})

// Get all custom queries
customQueries.get('/', async (c) => {
  try {
    if (!c.env.DB) {
      console.error('Custom queries GET: Database not configured')
      return c.json({ error: 'Database not configured' }, 500)
    }

    const result = await c.env.DB.prepare(`
      SELECT id, slug, name, description, sql_query, parameters, method, is_readonly, cache_ttl, is_enabled, created_at, updated_at
      FROM custom_queries
      ORDER BY name ASC
    `).all()

    // Parse parameters JSON for each query
    const queries = (result.results || []).map((query) => ({
      ...query,
      parameters: JSON.parse((query.parameters as string) || '[]'),
    }))

    return c.json(queries)
  } catch (error) {
    console.error('Error fetching custom queries:', error)

    // Check if it's a table not found error (database not initialized)
    if (error instanceof Error && error.message.includes('no such table')) {
      return c.json({ queries: [] }) // Return empty array instead of error
    }

    return c.json(
      {
        error: 'Failed to fetch custom queries',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    )
  }
})

// Get single custom query
customQueries.get('/:id', async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not configured' }, 500)
    }

    const id = c.req.param('id')
    const result = await c.env.DB.prepare(`
      SELECT id, slug, name, description, sql_query, parameters, method, is_readonly, cache_ttl, is_enabled, created_at, updated_at
      FROM custom_queries WHERE id = ?
    `)
      .bind(id)
      .first()

    if (!result) {
      return c.json({ error: 'Custom query not found' }, 404)
    }

    // Parse parameters JSON
    const query = {
      ...result,
      parameters: JSON.parse((result.parameters as string) || '[]'),
    }

    return c.json(query)
  } catch (error) {
    console.error('Error fetching custom query:', error)
    return c.json({ error: 'Failed to fetch custom query' }, 500)
  }
})

// Create custom query
customQueries.post(
  '/',
  zValidator('json', customQuerySchema, (result, c) => {
    if (!result.success) {
      console.error('Validation error:', result.error.flatten())
      return c.json(
        {
          error: 'Validation failed',
          details: result.error.flatten(),
        },
        400
      )
    }
  }),
  async (c) => {
    try {
      if (!c.env.DB) {
        return c.json({ error: 'Database not configured' }, 500)
      }

      const data = c.req.valid('json')
      const id = generateId()

      // Automatically determine method and readonly status based on SQL
      const method = determineHttpMethod(data.sql_query)
      const is_readonly = isReadonlyQuery(data.sql_query)

      // Reject non-SELECT queries for security
      if (!is_readonly) {
        return c.json({ error: 'Only SELECT queries are allowed' }, 400)
      }

      // Check if slug already exists
      const existing = await c.env.DB.prepare('SELECT id FROM custom_queries WHERE slug = ?')
        .bind(data.slug)
        .first()

      if (existing) {
        return c.json({ error: 'A query with this slug already exists' }, 409)
      }

      // Extract parameter names from SQL
      const paramRegex = /:(\w+)/g
      const sqlParams = new Set<string>()
      let match: RegExpExecArray | null
      match = paramRegex.exec(data.sql_query)
      while (match !== null) {
        sqlParams.add(match[1])
        match = paramRegex.exec(data.sql_query)
      }

      // Validate that all SQL parameters are defined
      const definedParams = new Set(data.parameters.map((p) => p.name))
      const undefinedParams = Array.from(sqlParams).filter((p) => !definedParams.has(p))
      if (undefinedParams.length > 0) {
        return c.json(
          {
            error: `SQL query contains undefined parameters: ${undefinedParams.join(', ')}`,
          },
          400
        )
      }

      // Insert the custom query
      await c.env.DB.prepare(`
      INSERT INTO custom_queries (
        id, slug, name, description, sql_query, parameters, 
        method, is_readonly, cache_ttl, is_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
        .bind(
          id,
          data.slug,
          data.name,
          data.description || null,
          data.sql_query,
          JSON.stringify(data.parameters),
          method,
          is_readonly ? 1 : 0,
          data.cache_ttl,
          data.is_enabled ? 1 : 0
        )
        .run()

      // Return the created query object
      const createdQuery = {
        id,
        slug: data.slug,
        name: data.name,
        description: data.description || null,
        sql_query: data.sql_query,
        parameters: data.parameters,
        method,
        is_readonly,
        cache_ttl: data.cache_ttl,
        is_enabled: data.is_enabled,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      return c.json(createdQuery, 201)
    } catch (error) {
      console.error('Error creating custom query:', error)
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Failed to create custom query',
        },
        500
      )
    }
  }
)

// Update custom query
customQueries.put(
  '/:id',
  zValidator('json', customQuerySchema.partial(), (result, c) => {
    if (!result.success) {
      console.error('Update validation error:', result.error.flatten())
      return c.json(
        {
          error: 'Validation failed',
          details: result.error.flatten(),
        },
        400
      )
    }
  }),
  async (c) => {
    try {
      if (!c.env.DB) {
        return c.json({ error: 'Database not configured' }, 500)
      }

      const id = c.req.param('id')
      const data = c.req.valid('json')

      // Check if query exists
      const existing = await c.env.DB.prepare('SELECT * FROM custom_queries WHERE id = ?')
        .bind(id)
        .first()

      if (!existing) {
        return c.json({ error: 'Custom query not found' }, 404)
      }

      // If slug is being changed, check for conflicts
      if (data.slug && data.slug !== existing.slug) {
        const slugExists = await c.env.DB.prepare(
          'SELECT id FROM custom_queries WHERE slug = ? AND id != ?'
        )
          .bind(data.slug, id)
          .first()

        if (slugExists) {
          return c.json({ error: 'A query with this slug already exists' }, 409)
        }
      }

      // If SQL query is being updated, validate parameters
      if (data.sql_query && data.parameters) {
        // Extract parameter names from SQL
        const paramRegex = /:(\w+)/g
        const sqlParams = new Set<string>()
        let match: RegExpExecArray | null
        match = paramRegex.exec(data.sql_query)
        while (match !== null) {
          sqlParams.add(match[1])
          match = paramRegex.exec(data.sql_query)
        }

        // Validate that all SQL parameters are defined
        const definedParams = new Set(data.parameters.map((p) => p.name))
        const undefinedParams = Array.from(sqlParams).filter((p) => !definedParams.has(p))
        if (undefinedParams.length > 0) {
          return c.json(
            {
              error: `SQL query contains undefined parameters: ${undefinedParams.join(', ')}`,
            },
            400
          )
        }
      }

      // Build update query dynamically
      const updates: string[] = []
      const values: (string | number | boolean | null)[] = []

      if (data.slug !== undefined) {
        updates.push('slug = ?')
        values.push(data.slug)
      }
      if (data.name !== undefined) {
        updates.push('name = ?')
        values.push(data.name)
      }
      if (data.description !== undefined) {
        updates.push('description = ?')
        values.push(data.description || null)
      }
      if (data.sql_query !== undefined) {
        updates.push('sql_query = ?')
        values.push(data.sql_query)

        // Auto-determine method and readonly status when SQL changes
        updates.push('method = ?')
        values.push(determineHttpMethod(data.sql_query))

        updates.push('is_readonly = ?')
        values.push(isReadonlyQuery(data.sql_query) ? 1 : 0)
      }
      if (data.parameters !== undefined) {
        updates.push('parameters = ?')
        values.push(JSON.stringify(data.parameters))
      }
      if (data.cache_ttl !== undefined) {
        updates.push('cache_ttl = ?')
        values.push(data.cache_ttl)
      }
      if (data.is_enabled !== undefined) {
        updates.push('is_enabled = ?')
        values.push(data.is_enabled ? 1 : 0)
      }

      updates.push('updated_at = datetime("now")')

      await c.env.DB.prepare(`
      UPDATE custom_queries 
      SET ${updates.join(', ')}
      WHERE id = ?
    `)
        .bind(...values, id)
        .run()

      // Fetch and return the updated query
      const updatedQuery = await c.env.DB.prepare(`
        SELECT id, slug, name, description, sql_query, parameters, method, is_readonly, cache_ttl, is_enabled, created_at, updated_at
        FROM custom_queries WHERE id = ?
      `)
        .bind(id)
        .first()

      if (!updatedQuery) {
        return c.json({ error: 'Failed to fetch updated query' }, 500)
      }

      // Parse parameters JSON
      const query = {
        ...updatedQuery,
        parameters: JSON.parse((updatedQuery.parameters as string) || '[]'),
      }

      return c.json(query)
    } catch (error) {
      console.error('Error updating custom query:', error)
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Failed to update custom query',
        },
        500
      )
    }
  }
)

// Also support PATCH method for updates (same logic as PUT)
customQueries.patch(
  '/:id',
  zValidator('json', customQuerySchema.partial(), (result, c) => {
    if (!result.success) {
      console.error('Update validation error:', result.error.flatten())
      return c.json(
        {
          error: 'Validation failed',
          details: result.error.flatten(),
        },
        400
      )
    }
  }),
  async (c) => {
    try {
      if (!c.env.DB) {
        return c.json({ error: 'Database not configured' }, 500)
      }

      const id = c.req.param('id')
      const data = c.req.valid('json')

      // Check if query exists
      const existing = await c.env.DB.prepare('SELECT * FROM custom_queries WHERE id = ?')
        .bind(id)
        .first()

      if (!existing) {
        return c.json({ error: 'Custom query not found' }, 404)
      }

      // If slug is being changed, check for conflicts
      if (data.slug && data.slug !== existing.slug) {
        const slugExists = await c.env.DB.prepare(
          'SELECT id FROM custom_queries WHERE slug = ? AND id != ?'
        )
          .bind(data.slug, id)
          .first()

        if (slugExists) {
          return c.json({ error: 'A query with this slug already exists' }, 409)
        }
      }

      // If SQL query is being updated, validate parameters
      if (data.sql_query && data.parameters) {
        // Extract parameter names from SQL
        const paramRegex = /:(\w+)/g
        const sqlParams = new Set<string>()
        let match: RegExpExecArray | null
        match = paramRegex.exec(data.sql_query)
        while (match !== null) {
          sqlParams.add(match[1])
          match = paramRegex.exec(data.sql_query)
        }

        // Validate that all SQL parameters are defined
        const definedParams = new Set(data.parameters.map((p) => p.name))
        const undefinedParams = Array.from(sqlParams).filter((p) => !definedParams.has(p))
        if (undefinedParams.length > 0) {
          return c.json(
            {
              error: `SQL query contains undefined parameters: ${undefinedParams.join(', ')}`,
            },
            400
          )
        }
      }

      // Build update query dynamically
      const updates: string[] = []
      const values: (string | number | boolean | null)[] = []

      if (data.slug !== undefined) {
        updates.push('slug = ?')
        values.push(data.slug)
      }
      if (data.name !== undefined) {
        updates.push('name = ?')
        values.push(data.name)
      }
      if (data.description !== undefined) {
        updates.push('description = ?')
        values.push(data.description || null)
      }
      if (data.sql_query !== undefined) {
        updates.push('sql_query = ?')
        values.push(data.sql_query)

        // Auto-determine method and readonly status when SQL changes
        updates.push('method = ?')
        values.push(determineHttpMethod(data.sql_query))

        updates.push('is_readonly = ?')
        values.push(isReadonlyQuery(data.sql_query) ? 1 : 0)
      }
      if (data.parameters !== undefined) {
        updates.push('parameters = ?')
        values.push(JSON.stringify(data.parameters))
      }
      if (data.cache_ttl !== undefined) {
        updates.push('cache_ttl = ?')
        values.push(data.cache_ttl)
      }
      if (data.is_enabled !== undefined) {
        updates.push('is_enabled = ?')
        values.push(data.is_enabled ? 1 : 0)
      }

      updates.push('updated_at = datetime("now")')

      await c.env.DB.prepare(`
      UPDATE custom_queries 
      SET ${updates.join(', ')}
      WHERE id = ?
    `)
        .bind(...values, id)
        .run()

      // Fetch and return the updated query
      const updatedQuery = await c.env.DB.prepare(`
        SELECT id, slug, name, description, sql_query, parameters, method, is_readonly, cache_ttl, is_enabled, created_at, updated_at
        FROM custom_queries WHERE id = ?
      `)
        .bind(id)
        .first()

      if (!updatedQuery) {
        return c.json({ error: 'Failed to fetch updated query' }, 500)
      }

      // Parse parameters JSON
      const query = {
        ...updatedQuery,
        parameters: JSON.parse((updatedQuery.parameters as string) || '[]'),
      }

      return c.json(query)
    } catch (error) {
      console.error('Error updating custom query:', error)
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Failed to update custom query',
        },
        500
      )
    }
  }
)

// Delete custom query
customQueries.delete('/:id', async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not configured' }, 500)
    }

    const id = c.req.param('id')

    const result = await c.env.DB.prepare('DELETE FROM custom_queries WHERE id = ?').bind(id).run()

    if (result.meta.changes === 0) {
      return c.json({ error: 'Custom query not found' }, 404)
    }

    return c.json({
      success: true,
      message: 'Custom query deleted successfully',
    })
  } catch (error) {
    console.error('Error deleting custom query:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to delete custom query',
      },
      500
    )
  }
})

// Test custom query
customQueries.post('/:id/test', zValidator('json', testQuerySchema), async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not configured' }, 500)
    }

    const id = c.req.param('id')
    const { parameters } = c.req.valid('json')

    // Fetch the query
    const query = await c.env.DB.prepare('SELECT * FROM custom_queries WHERE id = ?')
      .bind(id)
      .first()

    if (!query) {
      return c.json({ error: 'Custom query not found' }, 404)
    }

    const queryDef = {
      ...query,
      parameters: JSON.parse((query.parameters as string) || '[]'),
    } as CustomQuery

    // Validate and prepare parameters
    const preparedParams = prepareQueryParameters(queryDef.parameters, parameters)

    const startTime = Date.now()
    let result: { results: unknown[]; success: boolean; meta: unknown } | null = null
    let error = null

    try {
      // Execute the query
      if (queryDef.is_readonly) {
        result = await c.env.DB.prepare(queryDef.sql_query as string)
          .bind(...Object.values(preparedParams))
          .all()
      } else {
        result = await c.env.DB.prepare(queryDef.sql_query as string)
          .bind(...Object.values(preparedParams))
          .run()
      }
    } catch (queryError) {
      error = queryError instanceof Error ? queryError.message : 'Query execution failed'
    }

    const executionTime = Date.now() - startTime

    // Log the execution
    await c.env.DB.prepare(`
      INSERT INTO custom_query_logs (id, query_id, execution_time, row_count, parameters)
      VALUES (?, ?, ?, ?, ?)
    `)
      .bind(
        generateId(),
        id,
        executionTime,
        result?.results?.length || 0,
        JSON.stringify(parameters),
        error
      )
      .run()

    if (error) {
      return c.json({ error }, 400)
    }

    return c.json({
      success: true,
      data: result?.results || [],
      execution_time: executionTime,
      row_count: result?.results?.length || 0,
    })
  } catch (error) {
    console.error('Error testing custom query:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to test custom query',
      },
      500
    )
  }
})

// Execute custom query
customQueries.post('/:id/execute', zValidator('json', testQuerySchema), async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not configured' }, 500)
    }

    const id = c.req.param('id')
    const { parameters } = c.req.valid('json')

    // Fetch the query
    const query = await c.env.DB.prepare(
      'SELECT * FROM custom_queries WHERE id = ? AND is_enabled = 1'
    )
      .bind(id)
      .first()

    if (!query) {
      return c.json({ error: 'Custom query not found or disabled' }, 404)
    }

    const queryDef = {
      ...query,
      parameters: JSON.parse((query.parameters as string) || '[]'),
    } as CustomQuery

    // Check if query is read-only for non-GET methods
    if (!query.is_readonly) {
      return c.json(
        { error: 'This query is not read-only and cannot be executed via this endpoint' },
        403
      )
    }

    // Validate and prepare parameters
    const preparedParams = prepareQueryParameters(queryDef.parameters, parameters)

    // Check cache if enabled
    const cacheKey = `${queryDef.id}:${JSON.stringify(preparedParams)}`
    const cachedResult =
      queryDef.cache_ttl > 0 ? getCachedResult(cacheKey, queryDef.cache_ttl) : null

    if (cachedResult) {
      return c.json({
        data: cachedResult.data,
        parameters: preparedParams,
        execution_time: cachedResult.execution_time,
        cached: true,
      })
    }

    const startTime = Date.now()

    // Build parameterized query
    let sqlQuery = queryDef.sql_query
    const sqlParams: unknown[] = []

    // Replace named parameters with ?
    const paramRegex = /:(\w+)/g
    sqlQuery = sqlQuery.replace(paramRegex, (_match, paramName) => {
      if (!(paramName in preparedParams)) {
        throw new Error(`Parameter '${paramName}' not found in prepared parameters`)
      }
      sqlParams.push(preparedParams[paramName])
      return '?'
    })

    // Execute the query
    const stmt = c.env.DB.prepare(sqlQuery)
    const results = await stmt.bind(...sqlParams).all()

    const executionTime = Date.now() - startTime

    // Cache the result if cache_ttl > 0
    if (queryDef.cache_ttl > 0) {
      setCachedResult(cacheKey, results.results || [], executionTime)
    }

    // Log execution
    const logId = generateId()
    await c.env.DB.prepare(`
      INSERT INTO custom_query_logs (id, query_id, execution_time, row_count, parameters)
      VALUES (?, ?, ?, ?, ?)
    `)
      .bind(
        logId,
        queryDef.id,
        executionTime,
        results.results?.length || 0,
        JSON.stringify(preparedParams)
      )
      .run()

    return c.json({
      data: results.results || [],
      parameters: preparedParams,
      execution_time: executionTime,
      cached: false,
    })
  } catch (error) {
    console.error('Error executing custom query:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to execute query',
      },
      500
    )
  }
})

// Execute custom query by slug
customQueries.post('/slug/:slug/execute', zValidator('json', testQuerySchema), async (c) => {
  try {
    if (!c.env.DB) {
      return c.json({ error: 'Database not configured' }, 500)
    }

    const slug = c.req.param('slug')
    const { parameters } = c.req.valid('json')

    // Fetch the query by slug
    const query = await c.env.DB.prepare(
      'SELECT * FROM custom_queries WHERE slug = ? AND is_enabled = 1'
    )
      .bind(slug)
      .first()

    if (!query) {
      return c.json({ error: 'Custom query not found or disabled' }, 404)
    }

    const queryDef = {
      ...query,
      parameters: JSON.parse((query.parameters as string) || '[]'),
    } as CustomQuery

    // Check if query is read-only for non-GET methods
    if (!query.is_readonly) {
      return c.json(
        { error: 'This query is not read-only and cannot be executed via this endpoint' },
        403
      )
    }

    // Validate and prepare parameters
    const preparedParams = prepareQueryParameters(queryDef.parameters, parameters)

    const startTime = Date.now()

    // Build parameterized query
    let sqlQuery = queryDef.sql_query
    const sqlParams: unknown[] = []

    // Replace named parameters with ?
    const paramRegex = /:(\w+)/g
    sqlQuery = sqlQuery.replace(paramRegex, (_match, paramName) => {
      if (!(paramName in preparedParams)) {
        throw new Error(`Parameter '${paramName}' not found in prepared parameters`)
      }
      sqlParams.push(preparedParams[paramName])
      return '?'
    })

    // Execute the query
    const stmt = c.env.DB.prepare(sqlQuery)
    const results = await stmt.bind(...sqlParams).all()

    const executionTime = Date.now() - startTime

    // Log execution
    const logId = generateId()
    await c.env.DB.prepare(`
      INSERT INTO custom_query_logs (id, query_id, execution_time, row_count, parameters)
      VALUES (?, ?, ?, ?, ?)
    `)
      .bind(
        logId,
        queryDef.id,
        executionTime,
        results.results?.length || 0,
        JSON.stringify(preparedParams)
      )
      .run()

    return c.json({
      data: results.results || [],
      parameters: preparedParams,
      execution_time: executionTime,
      cached: false,
    })
  } catch (error) {
    console.error('Error executing custom query by slug:', error)
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Failed to execute query',
      },
      500
    )
  }
})

// Helper function to prepare query parameters
function prepareQueryParameters(
  paramDefs: Parameter[],
  providedParams: Record<string, unknown>
): Record<string, unknown> {
  const prepared: Record<string, unknown> = {}

  for (const paramDef of paramDefs) {
    let value = providedParams[paramDef.name]

    // Use default if not provided
    if (value === undefined && paramDef.default !== undefined) {
      value = paramDef.default
    }

    // Check required parameters
    if (value === undefined && paramDef.required) {
      throw new Error(`Required parameter '${paramDef.name}' is missing`)
    }

    // Type conversion and validation
    if (value !== undefined) {
      switch (paramDef.type) {
        case 'number':
          value = Number(value)
          if (Number.isNaN(value as number)) {
            throw new Error(`Parameter '${paramDef.name}' must be a number`)
          }
          break
        case 'boolean':
          value = Boolean(value)
          break
        case 'date': {
          // Convert to ISO string if it's a valid date
          const date = new Date(value as string)
          if (Number.isNaN(date.getTime())) {
            throw new Error(`Parameter '${paramDef.name}' must be a valid date`)
          }
          value = date.toISOString()
          break
        }
        default:
          value = String(value)
      }
    }

    prepared[paramDef.name] = value ?? null
  }

  return prepared
}
