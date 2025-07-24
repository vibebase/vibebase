/**
 * Vibebase SDK Types
 */

// Core configuration
export interface VibebaseConfig {
  apiUrl: string
  apiKey?: string
  userToken?: string
  timeout?: number
  retries?: number
}

// Authentication types
export interface AuthConfig {
  userToken?: string
  apiKey?: string
}

// API Response types
export interface ApiResponse<T = unknown> {
  data?: T
  error?: string
  success: boolean
  status: number
}

// List response type - for list operations with pagination info
export interface ListResponse<T = unknown> {
  data: T[]
  total: number
  error?: string
  success: boolean
  status: number
}

export interface ApiError {
  message: string
  status?: number
  code?: string
  details?: unknown
}

// Data types
export interface TableRow {
  id: string
  created_at: string
  updated_at: string
  [key: string]: unknown
}

export interface TableSchema {
  name: string
  columns: ColumnDefinition[]
  foreignKeys: ForeignKeyDefinition[]
}

export interface ColumnDefinition {
  name: string
  type: string
  nullable: boolean
  defaultValue?: string
  primaryKey: boolean
}

export interface ForeignKeyDefinition {
  from: string
  table: string
  to: string
}

// Query options
export interface QueryOptions {
  limit?: number
  offset?: number
  orderBy?: string
  orderDirection?: 'asc' | 'desc'
  where?: Record<string, unknown>
}

export interface CreateOptions {
  select?: string[]
}

export interface UpdateOptions {
  select?: string[]
}

// Realtime types
export interface RealtimeSubscription {
  id: string
  tableName: string
  eventType: 'insert' | 'update' | 'delete' | '*'
  callback: (data: RealtimeEvent) => void
  unsubscribe: () => void
}

export interface RealtimeEvent {
  type: 'event' | 'error' | 'ping'
  table: string
  eventType: 'insert' | 'update' | 'delete'
  recordId: string
  data?: TableRow
  record?: TableRow
  old_record?: TableRow
  timestamp?: string
}

// Storage types
export interface FileUploadOptions {
  contentType?: string
  metadata?: Record<string, string>
}

export interface FileInfo {
  name: string
  size: number
  contentType: string
  url: string
  metadata?: Record<string, string>
  uploaded_at: string
}

// User authentication types
export interface User {
  id: string
  email: string
  name?: string
  avatar_url?: string
  provider: string
  role: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface UserSession {
  access_token: string
  refresh_token?: string
  expires_at: string
  user: User
}

// Custom SQL types
export interface CustomQuery {
  id: string
  slug: string
  name: string
  description?: string
  sql_query: string
  parameters: CustomQueryParameter[]
  method: string
  is_readonly: boolean
  cache_ttl: number
  is_enabled: boolean
  created_at: string
  updated_at: string
}

export interface CustomQueryParameter {
  name: string
  type: 'string' | 'number' | 'boolean' | 'date'
  required: boolean
  description?: string
  default?: string | number | boolean
}

export interface CustomQueryResult<T = unknown> {
  data: T[]
  parameters: Record<string, unknown>
  execution_time: number
  cached: boolean
}
