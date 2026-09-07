/** Filter operator types for sidebar table search */

// ---------------------------------------------------------------------------
// Basic operators
// ---------------------------------------------------------------------------
export type BasicOperator =
  | "equals"           // =
  | "not_equals"        // != <>
  | "contains"          // ILIKE %value%
  | "not_contains"      // NOT ILIKE %value%
  | "starts_with"       // ILIKE value%
  | "ends_with"         // ILIKE %value
  | "is_empty"          // IS NULL or = ''
  | "is_not_empty";     // IS NOT NULL and != ''

// ---------------------------------------------------------------------------
// Advanced operators
// ---------------------------------------------------------------------------
export type AdvancedOperator =
  | "like"              // LIKE (case-sensitive)
  | "not_like"          // NOT LIKE
  | "regex_match"       // ~* regex
  | "in_list"           // IN (a, b, c)
  | "not_in_list"        // NOT IN (a, b, c)
  | "greater_than"      // >
  | "less_than"          // <
  | "greater_or_equal"  // >=
  | "less_or_equal";    // <=

// ---------------------------------------------------------------------------
// SQL mode: raw WHERE clause
// ---------------------------------------------------------------------------
export type SqlModeOperator = "raw_sql";

// ---------------------------------------------------------------------------
// Combined filter operator
// ---------------------------------------------------------------------------
export type FilterOperator = BasicOperator | AdvancedOperator | SqlModeOperator;

export const FILTER_OPERATOR_LABELS: Record<FilterOperator, { label: string; hint: string }> = {
  // Basic
  equals:        { label: "Equals",           hint: "Exact match" },
  not_equals:    { label: "Not equals",       hint: "Value must not match" },
  contains:      { label: "Contains",         hint: "Value appears anywhere" },
  not_contains:  { label: "Not contains",     hint: "Value must not appear" },
  starts_with:   { label: "Starts with",      hint: "Value at start" },
  ends_with:     { label: "Ends with",        hint: "Value at end" },
  is_empty:      { label: "Is empty",         hint: "NULL or blank" },
  is_not_empty:  { label: "Is not empty",     hint: "Has a value" },
  // Advanced
  like:          { label: "Like",             hint: "SQL LIKE (case-sensitive)" },
  not_like:      { label: "Not like",          hint: "SQL NOT LIKE" },
  regex_match:   { label: "Regex",            hint: "Regular expression pattern" },
  in_list:       { label: "In list",          hint: "Comma-separated values" },
  not_in_list:    { label: "Not in list",      hint: "Not in comma-separated values" },
  greater_than:  { label: "Greater than",     hint: "Numeric comparison" },
  less_than:      { label: "Less than",        hint: "Numeric comparison" },
  greater_or_equal: { label: ">=",            hint: "Greater than or equal" },
  less_or_equal: { label: "<=",               hint: "Less than or equal" },
  // SQL mode
  raw_sql:       { label: "SQL WHERE",        hint: "Raw SQL WHERE clause" },
};

export const FILTER_OPERATOR_CATEGORIES: {
  category: string;
  operators: FilterOperator[];
}[] = [
  { category: "Basic",    operators: ["equals","not_equals","contains","not_contains","starts_with","ends_with","is_empty","is_not_empty"] },
  { category: "Advanced", operators: ["like","not_like","regex_match","in_list","not_in_list","greater_than","less_than","greater_or_equal","less_or_equal"] },
  { category: "SQL Mode",  operators: ["raw_sql"] },
];

// ---------------------------------------------------------------------------
// Filter condition — single condition
// ---------------------------------------------------------------------------
export interface FilterCondition {
  /** Unique ID for this condition */
  id: string;
  /** Column name to filter on (empty = apply to table name) */
  column?: string;
  /** The operator to apply */
  operator: FilterOperator;
  /** The value — format depends on operator:
   *  in_list / not_in_list: comma-separated string "a,b,c"
   *  raw_sql: free-text SQL WHERE clause (without WHERE keyword)
   *  is_empty / is_not_empty: ignored
   *  all others: plain text
   */
  value: string;
}

// ---------------------------------------------------------------------------
// Column-mode filter (filter by column name pattern)
// ---------------------------------------------------------------------------
export interface ColumnFilter {
  pattern: string;
  operator: "name_contains" | "name_equals" | "name_matches_regex";
}

// ---------------------------------------------------------------------------
// Filter preset
// ---------------------------------------------------------------------------
export interface FilterPreset {
  id: string;
  name: string;
  /** Table name filter string */
  tableFilter: string;
  /** Schema filter string */
  schemaFilter: string;
  /** Object type filter — e.g. ["TABLE","VIEW"] */
  objectTypes: string[];
  /** Tags filter */
  tags: string[];
  /** Column filter (column name pattern) */
  columnFilter?: ColumnFilter;
  /** All filter conditions with AND/OR logic */
  conditions: FilterCondition[];
  /** Combine conditions with AND or OR */
  conditionLogic: "AND" | "OR";
  /** Whether column mode is active */
  columnMode: boolean;
  /** Filter operator (for table name filter) */
  tableOperator: FilterOperator;
  /** Filter operator (for schema filter) */
  schemaOperator: FilterOperator;
}

export const DEFAULT_FILTER_OPERATOR: FilterOperator = "contains";
