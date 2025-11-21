import { describe, expect, it } from 'vitest'
import { QueryBuilder, type QueryOperator, type QueryOptions } from '../../lib/query-builder'

describe('QueryBuilder', () => {
  const allowedColumns = ['id', 'title', 'status', 'created_at', 'views']
  const qb = new QueryBuilder('posts', allowedColumns)

  describe('buildSelect', () => {
    it('should build a basic SELECT * query', () => {
      const { sql, bindings } = qb.buildSelect({})
      expect(sql).toBe('SELECT * FROM "posts"')
      expect(bindings).toEqual([])
    })

    it('should handle WHERE clauses with different operators', () => {
      const options: QueryOptions = {
        where: [
          { column: 'status', operator: '=', value: 'published' },
          { column: 'views', operator: '>', value: 100 },
          { column: 'title', operator: 'LIKE', value: '%test%' },
        ],
      }
      const { sql, bindings } = qb.buildSelect(options)

      expect(sql).toContain('WHERE "status" = ? AND "views" > ? AND "title" LIKE ?')
      expect(bindings).toEqual(['published', 100, '%test%'])
    })

    it('should handle IS NULL and IS NOT NULL', () => {
      const options: QueryOptions = {
        where: [
          { column: 'title', operator: 'IS NOT NULL' },
          { column: 'status', operator: 'IS NULL' },
        ],
      }
      const { sql, bindings } = qb.buildSelect(options)

      expect(sql).toContain('WHERE "title" IS NOT NULL AND "status" IS NULL')
      expect(bindings).toEqual([])
    })

    it('should handle IN operator', () => {
      const options: QueryOptions = {
        where: [{ column: 'status', operator: 'IN', value: ['draft', 'published'] }],
      }
      const { sql, bindings } = qb.buildSelect(options)

      expect(sql).toContain('WHERE "status" IN (?, ?)')
      expect(bindings).toEqual(['draft', 'published'])
    })

    it('should handle ORDER BY', () => {
      const options: QueryOptions = {
        orderBy: [
          { column: 'created_at', direction: 'DESC' },
          { column: 'title', direction: 'ASC' },
        ],
      }
      const { sql, bindings } = qb.buildSelect(options)

      expect(sql).toContain('ORDER BY "created_at" DESC, "title" ASC')
      expect(bindings).toEqual([])
    })

    it('should handle LIMIT and OFFSET', () => {
      const options: QueryOptions = {
        limit: 10,
        offset: 20,
      }
      const { sql, bindings } = qb.buildSelect(options)

      expect(sql).toContain('LIMIT ? OFFSET ?')
      expect(bindings).toEqual([10, 20])
    })

    it('should combine all clauses correctly', () => {
      const options: QueryOptions = {
        where: [{ column: 'status', operator: '=', value: 'active' }],
        orderBy: [{ column: 'created_at', direction: 'DESC' }],
        limit: 5,
      }
      const { sql, bindings } = qb.buildSelect(options)

      expect(sql).toBe(
        'SELECT * FROM "posts" WHERE "status" = ? ORDER BY "created_at" DESC LIMIT ?'
      )
      expect(bindings).toEqual(['active', 5])
    })
  })

  describe('Security', () => {
    it('should throw error for invalid column names', () => {
      const options: QueryOptions = {
        where: [{ column: 'hacked_column', operator: '=', value: 1 }],
      }
      expect(() => qb.buildSelect(options)).toThrow(/Invalid column/)
    })

    it('should throw error for invalid operators', () => {
      const options: QueryOptions = {
        where: [{ column: 'status', operator: 'DROP TABLE' as unknown as QueryOperator, value: 1 }],
      }
      expect(() => qb.buildSelect(options)).toThrow(/Invalid operator/)
    })

    it('should throw error for invalid sort direction', () => {
      const options: QueryOptions = {
        orderBy: [{ column: 'created_at', direction: 'SIDEWAYS' as unknown as 'ASC' | 'DESC' }],
      }
      expect(() => qb.buildSelect(options)).toThrow(/Invalid sort direction/)
    })
  })
})
