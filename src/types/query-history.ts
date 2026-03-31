export interface QueryHistoryEntry {
  id?: number;
  connection_id: string;
  query_text: string;
  executed_at: string;
  duration_ms: number;
  row_count?: number;
  error?: string;
  database?: string;
}

export interface SqlFavorite {
  id: string;
  name: string;
  description?: string;
  sql: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}
