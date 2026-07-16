export const DEFAULT_DATA_CHUNK_SIZE = 250;

export const DATA_GRID_PERFORMANCE_FIXTURES = {
  tenThousandRows: { rowCount: 10_000, columnCount: 12 },
  oneHundredThousandRows: { rowCount: 100_000, columnCount: 12 },
  wideColumns: { rowCount: 250, columnCount: 160 },
} as const;

export interface DataWindowChunk<Row> {
  offset: number;
  rows: Row[];
}

export interface DataWindow<Row> {
  chunks: Map<number, DataWindowChunk<Row>>;
  chunkSize: number;
  endReached: boolean;
  totalRows: number | null;
}

export function createDataWindow<Row>(chunkSize = DEFAULT_DATA_CHUNK_SIZE): DataWindow<Row> {
  return { chunks: new Map(), chunkSize: Math.max(1, Math.floor(chunkSize)), endReached: false, totalRows: null };
}

export function getChunkOffset(index: number, chunkSize: number) {
  return Math.floor(Math.max(0, index) / Math.max(1, chunkSize)) * Math.max(1, chunkSize);
}

export function getRequiredChunkOffsets(startIndex: number, endIndex: number, chunkSize: number) {
  const start = getChunkOffset(startIndex, chunkSize);
  const end = getChunkOffset(Math.max(startIndex, endIndex), chunkSize);
  const offsets: number[] = [];
  for (let offset = start; offset <= end; offset += chunkSize) offsets.push(offset);
  return offsets;
}

export function mergeDataWindowChunk<Row>(
  window: DataWindow<Row>,
  offset: number,
  rows: Row[],
  totalRows?: number | null,
): DataWindow<Row> {
  const chunks = new Map(window.chunks);
  chunks.set(offset, { offset, rows: [...rows] });
  const knownTotal = typeof totalRows === "number" && totalRows >= 0 ? totalRows : window.totalRows;
  return {
    ...window,
    chunks,
    totalRows: knownTotal,
    endReached: knownTotal !== null ? offset + rows.length >= knownTotal : rows.length < window.chunkSize,
  };
}

export function getDataWindowRows<Row>(window: DataWindow<Row>) {
  const rows: Row[] = [];
  const offsets = [...window.chunks.keys()].sort((left, right) => left - right);
  for (const offset of offsets) {
    const chunk = window.chunks.get(offset);
    if (!chunk) continue;
    rows.push(...chunk.rows);
  }
  return rows;
}

export function isDataWindowRangeLoaded<Row>(window: DataWindow<Row>, startIndex: number, endIndex: number) {
  return getRequiredChunkOffsets(startIndex, endIndex, window.chunkSize)
    .every((offset) => window.chunks.has(offset));
}

export function getDataWindowDisplayCount<Row>(window: DataWindow<Row>) {
  if (window.totalRows !== null) return window.totalRows;
  const rows = getDataWindowRows(window);
  return window.endReached ? rows.length : rows.length + window.chunkSize;
}

/** Keep the first complete schema when later data chunks omit column metadata. */
export function resolveDataWindowColumns<Column>(
  canonicalColumns: Column[],
  existingColumns: Column[],
  incomingColumns: Column[],
) {
  return canonicalColumns.length > 0
    ? canonicalColumns
    : existingColumns.length > 0
      ? existingColumns
      : incomingColumns;
}
