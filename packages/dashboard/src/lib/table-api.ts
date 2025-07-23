/**
 * Table API client functions
 * Handles all table-related operations including schema management, data operations, and indexing
 */

import type { ColumnInfo, ForeignKeyInfo, IndexInfo, SchemaSnapshot, TableInfo } from '../types/api'
import { createApiClient } from './api-client-factory'

// Create API client instance
const client = createApiClient()

export const tableApi = {
  // Table management
  async getTables(): Promise<{ tables: TableInfo[] }> {
    const response = await client.get<{ tables: TableInfo[] }>('/api/tables')
    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch tables')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async getTableSchema(
    tableName: string
  ): Promise<{ tableName: string; columns: ColumnInfo[]; foreignKeys: ForeignKeyInfo[] }> {
    const response = await client.get<{
      tableName: string
      columns: ColumnInfo[]
      foreignKeys: ForeignKeyInfo[]
    }>(`/api/tables/${tableName}/schema`)
    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch table schema')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async getTableData(
    tableName: string,
    limit = 100,
    offset = 0
  ): Promise<{ data: Record<string, unknown>[]; total: number }> {
    const response = await client.get<{
      data: Record<string, unknown>[]
      pagination: { total: number }
    }>(`/api/data/${tableName}?limit=${limit}&offset=${offset}`)
    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch table data')
    }
    // Transform response to match expected format
    const responseData = response.data as NonNullable<typeof response.data>
    return {
      data: responseData.data,
      total: responseData.pagination.total,
    }
  },

  async createTable(
    name: string,
    columns: {
      name: string
      type: string
      constraints?: string
      foreignKey?: { table: string; column: string }
    }[]
  ): Promise<{ success: boolean; table: string }> {
    const response = await client.post<{ success: boolean; table: string }>('/api/tables', {
      name,
      columns,
    })
    if (!response.success) {
      throw new Error(response.error || 'Failed to create table')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async dropTable(tableName: string): Promise<{ success: boolean; table: string }> {
    const response = await client.delete<{ success: boolean; table: string }>(
      `/api/tables/${tableName}`
    )
    if (!response.success) {
      throw new Error(response.error || 'Failed to drop table')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async executeSQL(sql: string, params: unknown[] = []): Promise<{ result: unknown }> {
    const response = await client.post<{ result: unknown }>('/api/tables/query', { sql, params })
    if (!response.success) {
      throw new Error(response.error || 'Failed to execute SQL')
    }
    return response.data as NonNullable<typeof response.data>
  },

  // Column management
  async addColumn(
    tableName: string,
    column: {
      name: string
      type: string
      constraints?: string
      foreignKey?: { table: string; column: string }
    }
  ): Promise<{ success: boolean; column: string }> {
    const response = await client.post<{ success: boolean; column: string }>(
      `/api/tables/${tableName}/columns`,
      column
    )
    if (!response.success) {
      throw new Error(response.error || 'Failed to add column')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async renameColumn(
    tableName: string,
    oldName: string,
    newName: string
  ): Promise<{ success: boolean; oldName: string; newName: string }> {
    const response = await client.put<{ success: boolean; oldName: string; newName: string }>(
      `/api/tables/${tableName}/columns/${oldName}`,
      { oldName, newName }
    )
    if (!response.success) {
      throw new Error(response.error || 'Failed to rename column')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async dropColumn(
    tableName: string,
    columnName: string
  ): Promise<{ success: boolean; column: string }> {
    const response = await client.delete<{ success: boolean; column: string }>(
      `/api/tables/${tableName}/columns/${columnName}`
    )
    if (!response.success) {
      throw new Error(response.error || 'Failed to drop column')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async modifyColumn(
    tableName: string,
    columnName: string,
    changes: {
      type?: string
      notNull?: boolean
      foreignKey?: { table: string; column: string } | null
    }
  ): Promise<{ success: boolean; column: string; changes: Record<string, unknown> }> {
    const response = await client.patch<{
      success: boolean
      column: string
      changes: Record<string, unknown>
    }>(`/api/tables/${tableName}/columns/${columnName}`, changes)
    if (!response.success) {
      throw new Error(response.error || 'Failed to modify column')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async validateColumnChanges(
    tableName: string,
    columnName: string,
    changes: {
      type?: string
      notNull?: boolean
      foreignKey?: { table: string; column: string } | null
    }
  ): Promise<{ valid: boolean; errors: string[]; conflictingRows: number }> {
    const response = await client.post<{
      valid: boolean
      errors: string[]
      conflictingRows: number
    }>(`/api/tables/${tableName}/columns/${columnName}/validate`, changes)
    if (!response.success) {
      throw new Error(response.error || 'Failed to validate column changes')
    }
    return response.data as NonNullable<typeof response.data>
  },

  // Record management
  async insertRecord(
    tableName: string,
    data: Record<string, unknown>
  ): Promise<{ success: boolean; id: string }> {
    const response = await client.post<{ success: boolean; data: { id: string } }>(
      `/api/data/${tableName}`,
      data
    )
    if (!response.success) {
      throw new Error(response.error || 'Failed to create record')
    }
    const responseData = response.data as NonNullable<typeof response.data>
    return {
      success: responseData.success,
      id: responseData.data.id,
    }
  },

  async updateRecord(
    tableName: string,
    id: string,
    data: Record<string, unknown>
  ): Promise<{ success: boolean }> {
    const response = await client.put<{ success: boolean }>(`/api/data/${tableName}/${id}`, data)
    if (!response.success) {
      throw new Error(response.error || 'Failed to update record')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async deleteRecord(tableName: string, data: { id: string }): Promise<{ success: boolean }> {
    const response = await client.delete<{ success: boolean }>(`/api/data/${tableName}/${data.id}`)
    if (!response.success) {
      throw new Error(response.error || 'Failed to delete record')
    }
    return response.data as NonNullable<typeof response.data>
  },

  // Schema snapshots
  async getSnapshots(
    limit = 20,
    offset = 0
  ): Promise<{ snapshots: SchemaSnapshot[]; total: number }> {
    const response = await client.get<{ snapshots: SchemaSnapshot[]; total: number }>(
      `/api/snapshots?limit=${limit}&offset=${offset}`
    )
    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch snapshots')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async getSnapshot(id: string): Promise<SchemaSnapshot> {
    const response = await client.get<SchemaSnapshot>(`/api/snapshots/${id}`)
    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch snapshot')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async createSnapshot(data: {
    name?: string
    description?: string
  }): Promise<{ success: boolean; id: string }> {
    const response = await client.post<{ success: boolean; id: string }>('/api/snapshots', data)
    if (!response.success) {
      throw new Error(response.error || 'Failed to create snapshot')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async restoreSnapshot(id: string): Promise<{ success: boolean; message: string }> {
    const response = await client.post<{ success: boolean; message: string }>(
      `/api/snapshots/${id}/restore`
    )
    if (!response.success) {
      throw new Error(response.error || 'Failed to restore snapshot')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async deleteSnapshot(id: string): Promise<{ success: boolean; message: string }> {
    const response = await client.delete<{ success: boolean; message: string }>(
      `/api/snapshots/${id}`
    )
    if (!response.success) {
      throw new Error(response.error || 'Failed to delete snapshot')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async compareSnapshots(id1: string, id2: string): Promise<Record<string, unknown>> {
    const response = await client.get<Record<string, unknown>>(
      `/api/snapshots/compare/${id1}/${id2}`
    )
    if (!response.success) {
      throw new Error(response.error || 'Failed to compare snapshots')
    }
    return response.data as NonNullable<typeof response.data>
  },

  // Index management
  async getTableIndexes(tableName: string): Promise<{ indexes: IndexInfo[] }> {
    const response = await client.get<{ indexes: IndexInfo[] }>(`/api/tables/${tableName}/indexes`)
    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch table indexes')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async getAllIndexes(): Promise<{ indexes: IndexInfo[] }> {
    const response = await client.get<{ indexes: IndexInfo[] }>('/api/tables/indexes')
    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch all indexes')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async createIndex(
    tableName: string,
    data: { name: string; columns: string[]; unique?: boolean }
  ): Promise<{ success: boolean; index: IndexInfo }> {
    const response = await client.post<{ success: boolean; index: IndexInfo }>(
      `/api/tables/${tableName}/indexes`,
      data
    )
    if (!response.success) {
      throw new Error(response.error || 'Failed to create index')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async dropIndex(
    tableName: string,
    indexName: string
  ): Promise<{ success: boolean; message: string }> {
    const response = await client.delete<{ success: boolean; message: string }>(
      `/api/tables/${tableName}/indexes/${indexName}`
    )
    if (!response.success) {
      throw new Error(response.error || 'Failed to drop index')
    }
    return response.data as NonNullable<typeof response.data>
  },

  // Table access policy management
  async getTablePolicy(
    tableName: string
  ): Promise<{ table_name: string; access_policy: 'public' | 'private' | 'system' }> {
    const response = await client.get<{
      table_name: string
      access_policy: 'public' | 'private' | 'system'
    }>(`/api/tables/${tableName}/policy`)
    if (!response.success) {
      throw new Error(response.error || 'Failed to get table policy')
    }
    return response.data as NonNullable<typeof response.data>
  },

  async updateTablePolicy(
    tableName: string,
    policy: 'public' | 'private'
  ): Promise<{ success: boolean; message: string }> {
    const response = await client.put<{ success: boolean; message: string }>(
      `/api/tables/${tableName}/policy`,
      { access_policy: policy }
    )
    if (!response.success) {
      throw new Error(response.error || 'Failed to update table policy')
    }
    return response.data as NonNullable<typeof response.data>
  },
}
