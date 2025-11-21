export type QueryOperator =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'LIKE'
  | 'IN'
  | 'IS NULL'
  | 'IS NOT NULL'

export interface QueryFilter {
  column: string
  operator: QueryOperator
  value?: unknown
}

export interface QueryOptions {
  where?: QueryFilter[]
  orderBy?: { column: string; direction: 'ASC' | 'DESC' }[]
  limit?: number
  offset?: number
}

export class QueryBuilder {
  private readonly ALLOWED_OPERATORS: Set<string> = new Set([
    '=',
    '!=',
    '>',
    '>=',
    '<',
    '<=',
    'LIKE',
    'IN',
    'IS NULL',
    'IS NOT NULL',
  ])

  constructor(
    private tableName: string,
    private allowedColumns: string[]
  ) {}

  buildSelect(options: QueryOptions): { sql: string; bindings: unknown[] } {
    const bindings: unknown[] = []
    let sql = `SELECT * FROM "${this.validateTableName(this.tableName)}"`

    // WHERE Clause
    if (options.where && options.where.length > 0) {
      const conditions = options.where.map((filter) => {
        this.validateColumn(filter.column)
        this.validateOperator(filter.operator)

        const col = `"${filter.column}"`

        if (filter.operator === 'IS NULL' || filter.operator === 'IS NOT NULL') {
          return `${col} ${filter.operator}`
        }

        if (filter.operator === 'IN') {
          if (!Array.isArray(filter.value) || filter.value.length === 0) {
            throw new Error('Value for IN operator must be a non-empty array')
          }
          const placeholders = filter.value.map(() => '?').join(', ')
          bindings.push(...filter.value)
          return `${col} IN (${placeholders})`
        }

        bindings.push(filter.value)
        return `${col} ${filter.operator} ?`
      })

      sql += ` WHERE ${conditions.join(' AND ')}`
    }

    // ORDER BY Clause
    if (options.orderBy && options.orderBy.length > 0) {
      const orderClauses = options.orderBy.map((sort) => {
        this.validateColumn(sort.column)
        if (sort.direction !== 'ASC' && sort.direction !== 'DESC') {
          throw new Error(`Invalid sort direction: ${sort.direction}`)
        }
        return `"${sort.column}" ${sort.direction}`
      })
      sql += ` ORDER BY ${orderClauses.join(', ')}`
    }

    // LIMIT and OFFSET
    if (options.limit !== undefined) {
      sql += ` LIMIT ?`
      bindings.push(options.limit)
    }

    if (options.offset !== undefined) {
      sql += ` OFFSET ?`
      bindings.push(options.offset)
    }

    return { sql, bindings }
  }

  private validateTableName(name: string): string {
    // Simple validation to prevent obvious injection
    // In a real scenario, this might check against a schema definition
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      throw new Error(`Invalid table name: ${name}`)
    }
    return name
  }

  private validateColumn(name: string): void {
    if (!this.allowedColumns.includes(name)) {
      throw new Error(`Invalid column: ${name}`)
    }
  }

  private validateOperator(operator: string): void {
    if (!this.ALLOWED_OPERATORS.has(operator)) {
      throw new Error(`Invalid operator: ${operator}`)
    }
  }
}
