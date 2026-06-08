import type {
  DatabaseType,
  MetricsBoardDefinition,
  MetricsWidgetDefinition,
  MetricsWidgetType,
} from "../types";

export type AIMetricsBoardTemplate = "database-overview";
export type AIMetricsBoardMode = "create" | "augment" | "rebuild" | "edit";

export interface OpenAIMetricsBoardDetail {
  requestId?: string;
  connectionId?: string;
  database?: string;
  title?: string;
  template?: AIMetricsBoardTemplate;
  mode?: AIMetricsBoardMode;
  boardId?: string;
  focusWorkspace?: boolean;
  editTargetTitle?: string;
  editTargetType?: MetricsWidgetType;
  editQuery?: string;
  editTitle?: string;
}

export interface OpenAIMetricsBoardCompletionDetail {
  requestId?: string;
  success?: boolean;
  error?: string;
  boardId?: string;
  didChange?: boolean;
  addedCount?: number;
  addedTitles?: string[];
  addedWidgetIds?: string[];
  created?: boolean;
}

interface MetricsWidgetSeed {
  type: MetricsWidgetType;
  title: string;
  query: string;
  refreshSeconds?: number;
  colSpan: number;
  rowSpan: number;
  gridX: number;
  gridY: number;
}

export interface AIMetricsSchemaTableHint {
  name: string;
  schema?: string;
  rowCount?: number | null;
  columns?: string[];
}

interface MetricsTemplateDefinition {
  title: string;
  widgets: MetricsWidgetSeed[];
}

interface MetricsWidgetSeedDraft {
  type: MetricsWidgetType;
  title: string;
  query: string;
  refreshSeconds?: number;
}

const RECRUITMENT_LAYOUT_SLOTS = [
  { colSpan: 3, rowSpan: 3, gridX: 0, gridY: 0 },
  { colSpan: 3, rowSpan: 3, gridX: 3, gridY: 0 },
  { colSpan: 3, rowSpan: 3, gridX: 6, gridY: 0 },
  { colSpan: 3, rowSpan: 3, gridX: 9, gridY: 0 },
  { colSpan: 4, rowSpan: 4, gridX: 0, gridY: 4 },
  { colSpan: 6, rowSpan: 4, gridX: 4, gridY: 4 },
  { colSpan: 4, rowSpan: 4, gridX: 10, gridY: 4 },
  { colSpan: 6, rowSpan: 4, gridX: 0, gridY: 8 },
  { colSpan: 4, rowSpan: 4, gridX: 6, gridY: 8 },
  { colSpan: 4, rowSpan: 4, gridX: 10, gridY: 8 },
  { colSpan: 7, rowSpan: 4, gridX: 0, gridY: 12 },
  { colSpan: 7, rowSpan: 4, gridX: 7, gridY: 12 },
];

function normalizeIdentifier(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function escapeSqlLiteral(value: string) {
  return value.replace(/'/g, "''");
}

function quotePgIdentifier(value: string) {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function qualifyPgTable(table: AIMetricsSchemaTableHint) {
  return table.schema
    ? `${quotePgIdentifier(table.schema)}.${quotePgIdentifier(table.name)}`
    : quotePgIdentifier(table.name);
}

function findSchemaTable(
  schemaHints: AIMetricsSchemaTableHint[] | undefined,
  candidates: string[],
) {
  if (!schemaHints?.length) return null;
  const normalizedCandidates = new Set(candidates.map(normalizeIdentifier));
  return (
    schemaHints.find((table) => normalizedCandidates.has(normalizeIdentifier(table.name))) ?? null
  );
}

function findTableColumn(
  table: AIMetricsSchemaTableHint | null | undefined,
  candidates: string[],
) {
  if (!table?.columns?.length) return null;
  const normalizedColumns = new Map(
    table.columns.map((column) => [normalizeIdentifier(column), column]),
  );
  for (const candidate of candidates) {
    const match = normalizedColumns.get(normalizeIdentifier(candidate));
    if (match) return match;
  }
  return null;
}

function buildPgTextExpr(alias: string, column: string, fallback: string) {
  return `COALESCE(NULLIF(TRIM(${alias}.${quotePgIdentifier(column)}::text), ''), '${escapeSqlLiteral(fallback)}')`;
}

function buildPgLooseEquality(leftAlias: string, leftColumn: string, rightAlias: string, rightColumn: string) {
  return `${leftAlias}.${quotePgIdentifier(leftColumn)}::text = ${rightAlias}.${quotePgIdentifier(rightColumn)}::text`;
}

function buildPgEntityLabelExpr(args: {
  alias: string;
  titleColumn?: string | null;
  idColumn?: string | null;
  fallbackPrefix: string;
}) {
  const { alias, titleColumn, idColumn, fallbackPrefix } = args;
  if (titleColumn) {
    if (idColumn) {
      return `COALESCE(NULLIF(TRIM(${alias}.${quotePgIdentifier(titleColumn)}::text), ''), '${escapeSqlLiteral(fallbackPrefix)} #' || COALESCE(${alias}.${quotePgIdentifier(idColumn)}::text, 'n/a'))`;
    }
    return `COALESCE(NULLIF(TRIM(${alias}.${quotePgIdentifier(titleColumn)}::text), ''), '${escapeSqlLiteral(fallbackPrefix)} unknown')`;
  }
  if (idColumn) {
    return `'${escapeSqlLiteral(fallbackPrefix)} #' || COALESCE(${alias}.${quotePgIdentifier(idColumn)}::text, 'n/a')`;
  }
  return `'${escapeSqlLiteral(fallbackPrefix)}'`;
}

function withRecruitmentLayout(
  index: number,
  seed: MetricsWidgetSeedDraft,
): MetricsWidgetSeed {
  const slot =
    RECRUITMENT_LAYOUT_SLOTS[index] ?? {
      colSpan: 7,
      rowSpan: 4,
      gridX: index % 2 === 0 ? 0 : 7,
      gridY: 12 + Math.floor(Math.max(0, index - RECRUITMENT_LAYOUT_SLOTS.length) / 2) * 4,
    };

  return {
    ...seed,
    refreshSeconds: seed.refreshSeconds ?? 30,
    ...slot,
  };
}

function buildPostgresRecruitmentOverviewTemplate(
  schemaHints: AIMetricsSchemaTableHint[] | undefined,
): MetricsTemplateDefinition | null {
  if (!schemaHints?.length) return null;

  const jobPosts = findSchemaTable(schemaHints, ["job_posts", "job_post"]);
  const jobApplications = findSchemaTable(schemaHints, ["job_applications", "job_application", "applications"]);
  const organizations = findSchemaTable(schemaHints, ["organization", "organizations", "company", "companies"]);
  const organizationTypes = findSchemaTable(schemaHints, ["organization_type", "organization_types", "company_type"]);
  const industries = findSchemaTable(schemaHints, ["industry", "industries"]);
  const provinces = findSchemaTable(schemaHints, ["province", "provinces", "state", "states"]);
  const countries = findSchemaTable(schemaHints, ["country", "countries"]);
  const interviewSchedules = findSchemaTable(schemaHints, ["interview_schedules", "interview_schedule", "interviews"]);
  const interviewFeedbacks = findSchemaTable(schemaHints, ["interview_feedbacks", "interview_feedback", "feedbacks"]);

  const domainTableCount = [
    jobPosts,
    jobApplications,
    organizations,
    organizationTypes,
    industries,
    provinces,
    countries,
    interviewSchedules,
    interviewFeedbacks,
  ].filter(Boolean).length;

  if (domainTableCount < 3 || (!jobPosts && !jobApplications)) {
    return null;
  }

  const jobPostsTable = jobPosts ? qualifyPgTable(jobPosts) : null;
  const applicationsTable = jobApplications ? qualifyPgTable(jobApplications) : null;
  const organizationsTable = organizations ? qualifyPgTable(organizations) : null;
  const organizationTypesTable = organizationTypes ? qualifyPgTable(organizationTypes) : null;
  const industriesTable = industries ? qualifyPgTable(industries) : null;
  const provincesTable = provinces ? qualifyPgTable(provinces) : null;
  const countriesTable = countries ? qualifyPgTable(countries) : null;
  const interviewsTable = interviewSchedules ? qualifyPgTable(interviewSchedules) : null;
  const feedbackTable = interviewFeedbacks ? qualifyPgTable(interviewFeedbacks) : null;

  const jobPostIdColumn = findTableColumn(jobPosts, ["id"]);
  const jobPostTitleColumn = findTableColumn(jobPosts, ["title", "name", "job_title", "position_title"]);
  const jobPostCreatedAtColumn = findTableColumn(jobPosts, ["created_at", "posted_at", "published_at", "created_on"]);
  const jobPostOrganizationIdColumn = findTableColumn(jobPosts, ["organization_id", "org_id", "company_id"]);
  const jobPostIndustryIdColumn = findTableColumn(jobPosts, ["industry_id"]);
  const jobPostProvinceIdColumn = findTableColumn(jobPosts, ["province_id", "state_id"]);
  const jobPostCountryIdColumn = findTableColumn(jobPosts, ["country_id"]);

  const applicationIdColumn = findTableColumn(jobApplications, ["id"]);
  const applicationJobPostIdColumn = findTableColumn(jobApplications, ["job_post_id", "post_id"]);
  const applicationCreatedAtColumn = findTableColumn(jobApplications, ["created_at", "submitted_at", "applied_at", "created_on"]);
  const applicationStatusColumn = findTableColumn(jobApplications, ["status", "application_status"]);

  const organizationIdColumn = findTableColumn(organizations, ["id"]);
  const organizationNameColumn = findTableColumn(organizations, ["name", "title", "organization_name", "company_name"]);
  const organizationTypeIdColumn = findTableColumn(organizations, ["organization_type_id", "company_type_id", "type_id"]);
  const organizationIndustryIdColumn = findTableColumn(organizations, ["industry_id"]);
  const organizationProvinceIdColumn = findTableColumn(organizations, ["province_id", "state_id"]);
  const organizationCountryIdColumn = findTableColumn(organizations, ["country_id"]);

  const organizationTypeIdRefColumn = findTableColumn(organizationTypes, ["id"]);
  const organizationTypeNameColumn = findTableColumn(organizationTypes, ["name", "title", "label", "type_name"]);

  const industryIdColumn = findTableColumn(industries, ["id"]);
  const industryNameColumn = findTableColumn(industries, ["name", "title", "industry_name"]);

  const provinceIdColumn = findTableColumn(provinces, ["id"]);
  const provinceNameColumn = findTableColumn(provinces, ["name", "title", "province_name"]);

  const countryIdColumn = findTableColumn(countries, ["id"]);
  const countryNameColumn = findTableColumn(countries, ["name", "title", "country_name"]);

  const interviewIdColumn = findTableColumn(interviewSchedules, ["id"]);
  const interviewJobPostIdColumn = findTableColumn(interviewSchedules, ["job_post_id", "post_id"]);
  const interviewStatusColumn = findTableColumn(interviewSchedules, ["status", "interview_status"]);

  const feedbackInterviewIdColumn = findTableColumn(interviewFeedbacks, ["interview_schedule_id", "schedule_id", "interview_id"]);
  const feedbackJobPostIdColumn = findTableColumn(interviewFeedbacks, ["job_post_id", "post_id"]);
  const feedbackScoreColumn = findTableColumn(interviewFeedbacks, ["score", "rating", "rating_score", "value"]);

  const jobLabelExpr = buildPgEntityLabelExpr({
    alias: "jp",
    titleColumn: jobPostTitleColumn,
    idColumn: jobPostIdColumn,
    fallbackPrefix: "Job",
  });
  const organizationLabelExpr = buildPgEntityLabelExpr({
    alias: "org",
    titleColumn: organizationNameColumn,
    idColumn: organizationIdColumn,
    fallbackPrefix: "Organization",
  });
  const applicationCountValueExpr =
    applicationIdColumn
      ? `COUNT(DISTINCT ja.${quotePgIdentifier(applicationIdColumn)})::bigint`
      : "COUNT(*)::bigint";

  const seeds: MetricsWidgetSeed[] = [];
  const pushSeed = (seed: MetricsWidgetSeedDraft | null) => {
    if (!seed) return;
    seeds.push(withRecruitmentLayout(seeds.length, seed));
  };

  if (jobPostsTable) {
    pushSeed({
      type: "scoreboard",
      title: "Total Job Posts",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_job_posts,",
        "  'job posts' AS label",
        `FROM ${jobPostsTable} jp;`,
      ].join("\n"),
    });
  }

  if (applicationsTable) {
    pushSeed({
      type: "scoreboard",
      title: "Total Applications",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_applications,",
        "  'applications' AS label",
        `FROM ${applicationsTable} ja;`,
      ].join("\n"),
    });
  }

  if (organizationsTable) {
    pushSeed({
      type: "scoreboard",
      title: "Total Organizations",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_organizations,",
        "  'organizations' AS label",
        `FROM ${organizationsTable} org;`,
      ].join("\n"),
    });
  }

  if (feedbackTable && feedbackScoreColumn) {
    pushSeed({
      type: "scoreboard",
      title: "Average Interview Score",
      query: [
        "SELECT",
        `  COALESCE(ROUND(AVG(${`f.${quotePgIdentifier(feedbackScoreColumn)}`}::numeric), 2), 0) AS average_score,`,
        "  'avg score' AS label",
        `FROM ${feedbackTable} f`,
        `WHERE ${`f.${quotePgIdentifier(feedbackScoreColumn)}`} IS NOT NULL;`,
      ].join("\n"),
    });
  } else if (interviewsTable) {
    pushSeed({
      type: "scoreboard",
      title: "Scheduled Interviews",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_interviews,",
        "  'interviews' AS label",
        `FROM ${interviewsTable} iv;`,
      ].join("\n"),
    });
  }

  if (applicationsTable && applicationStatusColumn) {
    pushSeed({
      type: "bar",
      title: "Applications by Status",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("ja", applicationStatusColumn, "Unknown status")} AS label,`,
        `  ${applicationCountValueExpr} AS value`,
        `FROM ${applicationsTable} ja`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (applicationsTable && applicationCreatedAtColumn) {
    pushSeed({
      type: "line",
      title: "Applications by Month",
      query: [
        "SELECT",
        `  TO_CHAR(DATE_TRUNC('month', ja.${quotePgIdentifier(applicationCreatedAtColumn)}), 'YYYY-MM') AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${applicationsTable} ja`,
        `WHERE ja.${quotePgIdentifier(applicationCreatedAtColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY 1;",
      ].join("\n"),
    });
  } else if (jobPostsTable && jobPostCreatedAtColumn) {
    pushSeed({
      type: "line",
      title: "Job Posts by Month",
      query: [
        "SELECT",
        `  TO_CHAR(DATE_TRUNC('month', jp.${quotePgIdentifier(jobPostCreatedAtColumn)}), 'YYYY-MM') AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${jobPostsTable} jp`,
        `WHERE jp.${quotePgIdentifier(jobPostCreatedAtColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY 1;",
      ].join("\n"),
    });
  }

  if (
    jobPostsTable &&
    applicationsTable &&
    jobPostIdColumn &&
    applicationJobPostIdColumn
  ) {
    const applicationAggregateExpr = applicationIdColumn
      ? `COUNT(DISTINCT ja.${quotePgIdentifier(applicationIdColumn)})::bigint AS applications`
      : `COUNT(ja.${quotePgIdentifier(applicationJobPostIdColumn)})::bigint AS applications`;

    pushSeed({
      type: "table",
      title: "Top Job Posts by Applications",
      query: [
        "SELECT",
        `  ${jobLabelExpr} AS job_post,`,
        `  ${applicationAggregateExpr}`,
        `FROM ${jobPostsTable} jp`,
        `LEFT JOIN ${applicationsTable} ja ON ja.${quotePgIdentifier(applicationJobPostIdColumn)} = jp.${quotePgIdentifier(jobPostIdColumn)}`,
        "GROUP BY 1",
        "ORDER BY applications DESC, job_post ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (
    jobPostsTable &&
    organizationsTable &&
    jobPostOrganizationIdColumn &&
    organizationIdColumn
  ) {
    pushSeed({
      type: "bar",
      title: "Job Posts by Organization",
      query: [
        "SELECT",
        `  ${organizationLabelExpr} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${jobPostsTable} jp`,
        `LEFT JOIN ${organizationsTable} org ON org.${quotePgIdentifier(organizationIdColumn)} = jp.${quotePgIdentifier(jobPostOrganizationIdColumn)}`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  const canJoinIndustryFromPosts = Boolean(jobPostIndustryIdColumn);
  const canJoinIndustryFromOrganizations = Boolean(
    organizationsTable &&
    organizationIdColumn &&
    organizationIndustryIdColumn &&
    jobPostOrganizationIdColumn,
  );

  if (
    jobPostsTable &&
    industriesTable &&
    industryIdColumn &&
    industryNameColumn &&
    (canJoinIndustryFromPosts || canJoinIndustryFromOrganizations)
  ) {
    const joinIndustryFromPosts =
      jobPostIndustryIdColumn
        ? [
            `LEFT JOIN ${industriesTable} ind ON ind.${quotePgIdentifier(industryIdColumn)} = jp.${quotePgIdentifier(jobPostIndustryIdColumn)}`,
          ]
        : [
            `LEFT JOIN ${organizationsTable!} org ON org.${quotePgIdentifier(organizationIdColumn!)} = jp.${quotePgIdentifier(jobPostOrganizationIdColumn!)}`,
            `LEFT JOIN ${industriesTable} ind ON ind.${quotePgIdentifier(industryIdColumn)} = org.${quotePgIdentifier(organizationIndustryIdColumn!)}`,
          ];

    pushSeed({
      type: "pie",
      title: "Job Posts by Industry",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("ind", industryNameColumn, "Unknown industry")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${jobPostsTable} jp`,
        ...joinIndustryFromPosts,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 8;",
      ].join("\n"),
    });
  }

  if (
    organizationsTable &&
    organizationTypesTable &&
    organizationTypeIdColumn &&
    organizationTypeIdRefColumn &&
    organizationTypeNameColumn
  ) {
    pushSeed({
      type: "pie",
      title: "Organizations by Type",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("ot", organizationTypeNameColumn, "Unknown type")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${organizationsTable} org`,
        `LEFT JOIN ${organizationTypesTable} ot ON ot.${quotePgIdentifier(organizationTypeIdRefColumn)} = org.${quotePgIdentifier(organizationTypeIdColumn)}`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 8;",
      ].join("\n"),
    });
  }

  const canUseProvinceFromJobPosts = Boolean(
    provincesTable &&
    provinceIdColumn &&
    provinceNameColumn &&
    jobPostProvinceIdColumn,
  );
  const canUseProvinceFromOrganizations = Boolean(
    provincesTable &&
    provinceIdColumn &&
    provinceNameColumn &&
    organizationsTable &&
    organizationIdColumn &&
    organizationProvinceIdColumn &&
    jobPostOrganizationIdColumn,
  );
  const canUseCountryFromJobPosts = Boolean(
    countriesTable &&
    countryIdColumn &&
    countryNameColumn &&
    jobPostCountryIdColumn,
  );
  const canUseCountryFromOrganizations = Boolean(
    countriesTable &&
    countryIdColumn &&
    countryNameColumn &&
    organizationsTable &&
    organizationIdColumn &&
    organizationCountryIdColumn &&
    jobPostOrganizationIdColumn,
  );

  if (
    jobPostsTable &&
    (
      canUseProvinceFromJobPosts ||
      canUseProvinceFromOrganizations ||
      canUseCountryFromJobPosts ||
      canUseCountryFromOrganizations
    )
  ) {
    const useProvince = canUseProvinceFromJobPosts || canUseProvinceFromOrganizations;
    const useOrganizationFallback = useProvince
      ? !canUseProvinceFromJobPosts
      : !canUseCountryFromJobPosts;
    const dimensionAlias = useProvince ? "pv" : "ct";
    const dimensionTable = useProvince ? provincesTable! : countriesTable!;
    const dimensionIdColumn = useProvince ? provinceIdColumn! : countryIdColumn!;
    const dimensionNameColumn = useProvince ? provinceNameColumn! : countryNameColumn!;
    const foreignKeyColumn = useProvince
      ? (useOrganizationFallback ? organizationProvinceIdColumn! : jobPostProvinceIdColumn!)
      : (useOrganizationFallback ? organizationCountryIdColumn! : jobPostCountryIdColumn!);
    const geographicJoinLines = useOrganizationFallback
      ? [
          `LEFT JOIN ${organizationsTable!} org ON org.${quotePgIdentifier(organizationIdColumn!)} = jp.${quotePgIdentifier(jobPostOrganizationIdColumn!)}`,
          `LEFT JOIN ${dimensionTable} ${dimensionAlias} ON ${dimensionAlias}.${quotePgIdentifier(dimensionIdColumn)} = org.${quotePgIdentifier(foreignKeyColumn)}`,
        ]
      : [
          `LEFT JOIN ${dimensionTable} ${dimensionAlias} ON ${dimensionAlias}.${quotePgIdentifier(dimensionIdColumn)} = jp.${quotePgIdentifier(foreignKeyColumn)}`,
        ];

    pushSeed({
      type: "bar",
      title: useProvince ? "Job Posts by Province" : "Job Posts by Country",
      query: [
        "SELECT",
        `  ${buildPgTextExpr(dimensionAlias, dimensionNameColumn, useProvince ? "Unknown province" : "Unknown country")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${jobPostsTable} jp`,
        ...geographicJoinLines,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (interviewsTable && interviewStatusColumn) {
    pushSeed({
      type: "bar",
      title: "Interviews by Status",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("iv", interviewStatusColumn, "Unknown status")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${interviewsTable} iv`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (
    feedbackTable &&
    feedbackScoreColumn &&
    jobPostsTable &&
    jobPostIdColumn &&
    (
      feedbackJobPostIdColumn ||
      (interviewsTable && interviewIdColumn && interviewJobPostIdColumn && feedbackInterviewIdColumn)
    )
  ) {
    const feedbackJoinLines = feedbackJobPostIdColumn
      ? [
          `LEFT JOIN ${jobPostsTable} jp ON jp.${quotePgIdentifier(jobPostIdColumn)} = f.${quotePgIdentifier(feedbackJobPostIdColumn)}`,
        ]
      : [
          `LEFT JOIN ${interviewsTable} iv ON iv.${quotePgIdentifier(interviewIdColumn!)} = f.${quotePgIdentifier(feedbackInterviewIdColumn!)}`,
          `LEFT JOIN ${jobPostsTable} jp ON jp.${quotePgIdentifier(jobPostIdColumn)} = iv.${quotePgIdentifier(interviewJobPostIdColumn!)}`,
        ];

    pushSeed({
      type: "bar",
      title: "Average Feedback by Job Post",
      query: [
        "SELECT",
        `  ${jobLabelExpr} AS label,`,
        `  COALESCE(ROUND(AVG(f.${quotePgIdentifier(feedbackScoreColumn)}::numeric), 2), 0) AS value`,
        `FROM ${feedbackTable} f`,
        ...feedbackJoinLines,
        `WHERE f.${quotePgIdentifier(feedbackScoreColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (seeds.length < 6) {
    return null;
  }

  return {
    title: "Recruitment Analytics Dashboard",
    widgets: seeds,
  };
}

function buildPostgresCommerceOperationsTemplate(
  schemaHints: AIMetricsSchemaTableHint[] | undefined,
): MetricsTemplateDefinition | null {
  if (!schemaHints?.length) return null;

  const users = findSchemaTable(schemaHints, ["users", "user", "accounts"]);
  const sessions = findSchemaTable(schemaHints, ["sessions", "user_sessions"]);
  const identities = findSchemaTable(schemaHints, ["identities", "identity"]);
  const oauthClients = findSchemaTable(schemaHints, ["oauth_clients", "oauth_client"]);
  const orders = findSchemaTable(schemaHints, ["orders", "order"]);
  const orderItems = findSchemaTable(schemaHints, ["order_items", "order_item", "line_items"]);
  const products = findSchemaTable(schemaHints, ["products", "product"]);
  const categories = findSchemaTable(schemaHints, ["categories", "category"]);
  const brands = findSchemaTable(schemaHints, ["brands", "brand"]);
  const reviews = findSchemaTable(schemaHints, ["reviews", "review", "product_reviews"]);
  const messages = findSchemaTable(schemaHints, ["messages", "message"]);
  const auditLogs = findSchemaTable(schemaHints, ["audit_log_entries", "audit_logs", "user_logs", "smart_alerts"]);

  const domainTableCount = [
    users,
    sessions,
    identities,
    oauthClients,
    orders,
    orderItems,
    products,
    categories,
    brands,
    reviews,
    messages,
    auditLogs,
  ].filter(Boolean).length;

  if (domainTableCount < 4 || (!users && !orders && !products)) {
    return null;
  }

  const usersTable = users ? qualifyPgTable(users) : null;
  const sessionsTable = sessions ? qualifyPgTable(sessions) : null;
  const identitiesTable = identities ? qualifyPgTable(identities) : null;
  const oauthClientsTable = oauthClients ? qualifyPgTable(oauthClients) : null;
  const ordersTable = orders ? qualifyPgTable(orders) : null;
  const orderItemsTable = orderItems ? qualifyPgTable(orderItems) : null;
  const productsTable = products ? qualifyPgTable(products) : null;
  const categoriesTable = categories ? qualifyPgTable(categories) : null;
  const brandsTable = brands ? qualifyPgTable(brands) : null;
  const reviewsTable = reviews ? qualifyPgTable(reviews) : null;
  const messagesTable = messages ? qualifyPgTable(messages) : null;
  const auditLogsTable = auditLogs ? qualifyPgTable(auditLogs) : null;

  const userIdColumn = findTableColumn(users, ["id"]);
  const userCreatedAtColumn = findTableColumn(users, ["created_at", "created_on", "registered_at"]);
  const userEmailColumn = findTableColumn(users, ["email", "email_address", "username", "name"]);

  const identityIdColumn = findTableColumn(identities, ["id"]);
  const identityProviderColumn = findTableColumn(identities, ["provider", "provider_name", "type"]);

  const orderCreatedAtColumn = findTableColumn(orders, ["created_at", "created_on", "ordered_at", "placed_at"]);
  const orderStatusColumn = findTableColumn(orders, ["status", "order_status", "payment_status"]);
  const orderUserIdColumn = findTableColumn(orders, ["user_id", "customer_id", "account_id"]);

  const orderItemProductIdColumn = findTableColumn(orderItems, ["product_id", "item_id"]);
  const orderItemQuantityColumn = findTableColumn(orderItems, ["quantity", "qty", "count"]);

  const productIdColumn = findTableColumn(products, ["id"]);
  const productTitleColumn = findTableColumn(products, ["name", "title", "product_name", "label"]);
  const productCategoryIdColumn = findTableColumn(products, ["category_id"]);
  const productBrandIdColumn = findTableColumn(products, ["brand_id"]);
  const productCreatedAtColumn = findTableColumn(products, ["created_at", "created_on", "published_at"]);

  const categoryIdColumn = findTableColumn(categories, ["id"]);
  const categoryNameColumn = findTableColumn(categories, ["name", "title", "label", "category_name"]);

  const brandIdColumn = findTableColumn(brands, ["id"]);
  const brandNameColumn = findTableColumn(brands, ["name", "title", "label", "brand_name"]);

  const reviewProductIdColumn = findTableColumn(reviews, ["product_id", "item_id"]);
  const reviewScoreColumn = findTableColumn(reviews, ["rating", "score", "stars"]);

  const messageCreatedAtColumn = findTableColumn(messages, ["created_at", "created_on", "sent_at"]);
  const messageStatusColumn = findTableColumn(messages, ["status", "message_status", "state"]);

  const auditCreatedAtColumn = findTableColumn(auditLogs, ["created_at", "created_on", "logged_at"]);
  const auditActionColumn = findTableColumn(auditLogs, ["action", "event", "event_type", "type"]);

  const userLabelExpr = buildPgEntityLabelExpr({
    alias: "u",
    titleColumn: userEmailColumn,
    idColumn: userIdColumn,
    fallbackPrefix: "User",
  });
  const productLabelExpr = buildPgEntityLabelExpr({
    alias: "p",
    titleColumn: productTitleColumn,
    idColumn: productIdColumn,
    fallbackPrefix: "Product",
  });

  const seeds: MetricsWidgetSeed[] = [];
  const pushSeed = (seed: MetricsWidgetSeedDraft | null) => {
    if (!seed) return;
    seeds.push(withRecruitmentLayout(seeds.length, seed));
  };

  if (usersTable) {
    pushSeed({
      type: "scoreboard",
      title: "Total Users",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_users,",
        "  'users' AS label",
        `FROM ${usersTable} u;`,
      ].join("\n"),
    });
  }

  if (ordersTable) {
    pushSeed({
      type: "scoreboard",
      title: "Total Orders",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_orders,",
        "  'orders' AS label",
        `FROM ${ordersTable} o;`,
      ].join("\n"),
    });
  }

  if (productsTable) {
    pushSeed({
      type: "scoreboard",
      title: "Total Products",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_products,",
        "  'products' AS label",
        `FROM ${productsTable} p;`,
      ].join("\n"),
    });
  }

  if (sessionsTable) {
    pushSeed({
      type: "scoreboard",
      title: "Active Sessions",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_sessions,",
        "  'sessions' AS label",
        `FROM ${sessionsTable} s;`,
      ].join("\n"),
    });
  } else if (oauthClientsTable) {
    pushSeed({
      type: "scoreboard",
      title: "OAuth Clients",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_oauth_clients,",
        "  'oauth clients' AS label",
        `FROM ${oauthClientsTable} oc;`,
      ].join("\n"),
    });
  }

  if (ordersTable && orderStatusColumn) {
    pushSeed({
      type: "bar",
      title: "Orders by Status",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("o", orderStatusColumn, "Unknown status")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${ordersTable} o`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (ordersTable && orderCreatedAtColumn) {
    pushSeed({
      type: "line",
      title: "Orders by Month",
      query: [
        "SELECT",
        `  TO_CHAR(DATE_TRUNC('month', o.${quotePgIdentifier(orderCreatedAtColumn)}), 'YYYY-MM') AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${ordersTable} o`,
        `WHERE o.${quotePgIdentifier(orderCreatedAtColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY 1;",
      ].join("\n"),
    });
  }

  if (
    productsTable &&
    orderItemsTable &&
    productIdColumn &&
    orderItemProductIdColumn
  ) {
    const quantityExpr = orderItemQuantityColumn
      ? `COALESCE(SUM(oi.${quotePgIdentifier(orderItemQuantityColumn)})::bigint, 0)`
      : "COUNT(*)::bigint";

    pushSeed({
      type: "bar",
      title: "Top Products by Ordered Qty",
      query: [
        "SELECT",
        `  ${productLabelExpr} AS label,`,
        `  ${quantityExpr} AS value`,
        `FROM ${orderItemsTable} oi`,
        `LEFT JOIN ${productsTable} p ON ${buildPgLooseEquality("p", productIdColumn, "oi", orderItemProductIdColumn)}`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (
    productsTable &&
    categoriesTable &&
    productCategoryIdColumn &&
    categoryIdColumn &&
    categoryNameColumn
  ) {
    pushSeed({
      type: "pie",
      title: "Products by Category",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("c", categoryNameColumn, "Unknown category")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${productsTable} p`,
        `LEFT JOIN ${categoriesTable} c ON ${buildPgLooseEquality("c", categoryIdColumn, "p", productCategoryIdColumn)}`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 8;",
      ].join("\n"),
    });
  }

  if (
    productsTable &&
    brandsTable &&
    productBrandIdColumn &&
    brandIdColumn &&
    brandNameColumn
  ) {
    pushSeed({
      type: "pie",
      title: "Products by Brand",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("b", brandNameColumn, "Unknown brand")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${productsTable} p`,
        `LEFT JOIN ${brandsTable} b ON ${buildPgLooseEquality("b", brandIdColumn, "p", productBrandIdColumn)}`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 8;",
      ].join("\n"),
    });
  }

  if (usersTable && userCreatedAtColumn) {
    pushSeed({
      type: "line",
      title: "New Users by Month",
      query: [
        "SELECT",
        `  TO_CHAR(DATE_TRUNC('month', u.${quotePgIdentifier(userCreatedAtColumn)}), 'YYYY-MM') AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${usersTable} u`,
        `WHERE u.${quotePgIdentifier(userCreatedAtColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY 1;",
      ].join("\n"),
    });
  }

  if (
    ordersTable &&
    usersTable &&
    orderUserIdColumn &&
    userIdColumn
  ) {
    pushSeed({
      type: "table",
      title: "Top Users by Orders",
      query: [
        "SELECT",
        `  ${userLabelExpr} AS user_account,`,
        "  COUNT(*)::bigint AS orders",
        `FROM ${ordersTable} o`,
        `LEFT JOIN ${usersTable} u ON ${buildPgLooseEquality("u", userIdColumn, "o", orderUserIdColumn)}`,
        "GROUP BY 1",
        "ORDER BY orders DESC, user_account ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (
    reviewsTable &&
    productsTable &&
    reviewProductIdColumn &&
    productIdColumn
  ) {
    const reviewCountExpr = `COUNT(r.${quotePgIdentifier(reviewProductIdColumn)})::bigint`;
    const reviewValueExpr = reviewScoreColumn
      ? `COALESCE(ROUND(AVG(r.${quotePgIdentifier(reviewScoreColumn)}::numeric), 2), 0)`
      : reviewCountExpr;

    pushSeed({
      type: "bar",
      title: reviewScoreColumn ? "Average Rating by Product" : "Reviews by Product",
      query: [
        "SELECT",
        `  ${productLabelExpr} AS label,`,
        `  ${reviewValueExpr} AS value`,
        `FROM ${productsTable} p`,
        `LEFT JOIN ${reviewsTable} r ON ${buildPgLooseEquality("p", productIdColumn, "r", reviewProductIdColumn)}`,
        `WHERE p.${quotePgIdentifier(productIdColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (messagesTable && messageCreatedAtColumn) {
    pushSeed({
      type: "line",
      title: "Messages by Day",
      query: [
        "SELECT",
        `  TO_CHAR(DATE_TRUNC('day', m.${quotePgIdentifier(messageCreatedAtColumn)}), 'YYYY-MM-DD') AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${messagesTable} m`,
        `WHERE m.${quotePgIdentifier(messageCreatedAtColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY 1 DESC",
        "LIMIT 14;",
      ].join("\n"),
    });
  } else if (messagesTable && messageStatusColumn) {
    pushSeed({
      type: "bar",
      title: "Messages by Status",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("m", messageStatusColumn, "Unknown status")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${messagesTable} m`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (auditLogsTable && auditCreatedAtColumn) {
    pushSeed({
      type: "line",
      title: "Audit Events by Day",
      query: [
        "SELECT",
        `  TO_CHAR(DATE_TRUNC('day', a.${quotePgIdentifier(auditCreatedAtColumn)}), 'YYYY-MM-DD') AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${auditLogsTable} a`,
        `WHERE a.${quotePgIdentifier(auditCreatedAtColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY 1 DESC",
        "LIMIT 14;",
      ].join("\n"),
    });
  } else if (auditLogsTable && auditActionColumn) {
    pushSeed({
      type: "bar",
      title: "Audit Events by Type",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("a", auditActionColumn, "Unknown action")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${auditLogsTable} a`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (oauthClientsTable) {
    pushSeed({
      type: "scoreboard",
      title: "OAuth Clients",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_oauth_clients,",
        "  'oauth clients' AS label",
        `FROM ${oauthClientsTable} oc;`,
      ].join("\n"),
    });
  }

  if (identitiesTable) {
    if (identityProviderColumn) {
      pushSeed({
        type: "pie",
        title: "Identities by Provider",
        query: [
          "SELECT",
          `  ${buildPgTextExpr("i", identityProviderColumn, "Unknown provider")} AS label,`,
          "  COUNT(*)::bigint AS value",
          `FROM ${identitiesTable} i`,
          "GROUP BY 1",
          "ORDER BY value DESC, label ASC",
          "LIMIT 8;",
        ].join("\n"),
      });
    } else if (identityIdColumn) {
      pushSeed({
        type: "scoreboard",
        title: "Linked Identities",
        query: [
          "SELECT",
          "  COUNT(*)::bigint AS total_identities,",
          "  'identities' AS label",
          `FROM ${identitiesTable} i;`,
        ].join("\n"),
      });
    }
  }

  if (productCreatedAtColumn && productsTable) {
    pushSeed({
      type: "line",
      title: "Products Added by Month",
      query: [
        "SELECT",
        `  TO_CHAR(DATE_TRUNC('month', p.${quotePgIdentifier(productCreatedAtColumn)}), 'YYYY-MM') AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${productsTable} p`,
        `WHERE p.${quotePgIdentifier(productCreatedAtColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY 1;",
      ].join("\n"),
    });
  }

  if (seeds.length < 6) {
    return null;
  }

  return {
    title: "Commerce & Ops Dashboard",
    widgets: seeds,
  };
}

function getPostgresAdaptiveOverviewTemplate(
  schemaHints: AIMetricsSchemaTableHint[] | undefined,
) {
  const candidates = [
    buildPostgresRecruitmentOverviewTemplate(schemaHints),
    buildPostgresCommerceOperationsTemplate(schemaHints),
  ].filter((value): value is MetricsTemplateDefinition => value !== null);

  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort((left, right) => right.widgets.length - left.widgets.length)[0];
}

function createUniqueBoardName(baseName: string, existingBoards: MetricsBoardDefinition[]) {
  const normalizedBaseName = baseName.trim() || "AI Dashboard";
  const existingNames = new Set(existingBoards.map((board) => board.name.trim().toLowerCase()));
  if (!existingNames.has(normalizedBaseName.toLowerCase())) {
    return normalizedBaseName;
  }

  let suffix = 2;
  while (existingNames.has(`${normalizedBaseName.toLowerCase()} ${suffix}`)) {
    suffix += 1;
  }
  return `${normalizedBaseName} ${suffix}`;
}

function createWidgetFromSeed(seed: MetricsWidgetSeed): MetricsWidgetDefinition {
  return {
    id: `widget-${crypto.randomUUID()}`,
    type: seed.type,
    title: seed.title,
    query: seed.query,
    refresh_seconds: seed.refreshSeconds ?? 30,
    col_span: seed.colSpan,
    row_span: seed.rowSpan,
    grid_x: seed.gridX,
    grid_y: seed.gridY,
  };
}

function widgetsOverlap(a: MetricsWidgetDefinition, b: MetricsWidgetDefinition) {
  return !(
    a.grid_x + a.col_span <= b.grid_x ||
    b.grid_x + b.col_span <= a.grid_x ||
    a.grid_y + a.row_span <= b.grid_y ||
    b.grid_y + b.row_span <= a.grid_y
  );
}

function canPlaceWidget(widgets: MetricsWidgetDefinition[], candidate: MetricsWidgetDefinition) {
  if (candidate.grid_x < 0 || candidate.grid_y < 0) return false;
  if (candidate.grid_x + candidate.col_span > 14) return false;
  return widgets.every((widget) => !widgetsOverlap(widget, candidate));
}

function findFirstAvailablePosition(
  widgets: MetricsWidgetDefinition[],
  candidate: MetricsWidgetDefinition,
) {
  for (let gridY = 0; gridY < 128; gridY += 1) {
    for (let gridX = 0; gridX <= 14 - candidate.col_span; gridX += 1) {
      const nextCandidate = {
        ...candidate,
        grid_x: gridX,
        grid_y: gridY,
      };
      if (canPlaceWidget(widgets, nextCandidate)) {
        return nextCandidate;
      }
    }
  }

  return candidate;
}

function buildPostgresSchemaOverviewSeeds(): MetricsWidgetSeed[] {
  return [
    {
      type: "scoreboard",
      title: "Total Tables",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_tables,",
        "  'tables' AS label",
        "FROM information_schema.tables",
        "WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
        "  AND table_type = 'BASE TABLE';",
      ].join("\n"),
      colSpan: 3,
      rowSpan: 3,
      gridX: 0,
      gridY: 0,
    },
    {
      type: "scoreboard",
      title: "Estimated Rows",
      query: [
        "SELECT",
        "  COALESCE(SUM(n_live_tup), 0)::bigint AS estimated_rows,",
        "  'rows' AS label",
        "FROM pg_stat_user_tables",
        "WHERE schemaname NOT IN ('pg_catalog', 'information_schema');",
      ].join("\n"),
      colSpan: 3,
      rowSpan: 3,
      gridX: 3,
      gridY: 0,
    },
    {
      type: "bar",
      title: "Top Tables by Rows",
      query: [
        "SELECT",
        "  relname AS label,",
        "  COALESCE(n_live_tup, 0)::bigint AS value",
        "FROM pg_stat_user_tables",
        "WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
        "ORDER BY value DESC NULLS LAST, label ASC",
        "LIMIT 12;",
      ].join("\n"),
      colSpan: 4,
      rowSpan: 4,
      gridX: 6,
      gridY: 0,
    },
    {
      type: "pie",
      title: "Row Share by Table",
      query: [
        "SELECT",
        "  relname AS label,",
        "  COALESCE(n_live_tup, 0)::bigint AS value",
        "FROM pg_stat_user_tables",
        "WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
        "ORDER BY value DESC NULLS LAST, label ASC",
        "LIMIT 8;",
      ].join("\n"),
      colSpan: 4,
      rowSpan: 4,
      gridX: 10,
      gridY: 0,
    },
    {
      type: "table",
      title: "Largest Tables",
      query: [
        "SELECT",
        "  relname AS table_name,",
        "  COALESCE(n_live_tup, 0)::bigint AS estimated_rows,",
        "  pg_size_pretty(pg_total_relation_size(relid)) AS total_size",
        "FROM pg_stat_user_tables",
        "WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
        "ORDER BY estimated_rows DESC NULLS LAST, table_name ASC",
        "LIMIT 10;",
      ].join("\n"),
      colSpan: 6,
      rowSpan: 4,
      gridX: 0,
      gridY: 4,
    },
    {
      type: "bar",
      title: "Columns by Table",
      query: [
        "SELECT",
        "  table_name AS label,",
        "  COUNT(*)::bigint AS value",
        "FROM information_schema.columns",
        "WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
        "GROUP BY table_name",
        "ORDER BY value DESC, label ASC",
        "LIMIT 12;",
      ].join("\n"),
      colSpan: 6,
      rowSpan: 4,
      gridX: 6,
      gridY: 4,
    },
    {
      type: "scoreboard",
      title: "Total Columns",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_columns,",
        "  'columns' AS label",
        "FROM information_schema.columns",
        "WHERE table_schema NOT IN ('pg_catalog', 'information_schema');",
      ].join("\n"),
      colSpan: 3,
      rowSpan: 3,
      gridX: 0,
      gridY: 8,
    },
    {
      type: "scoreboard",
      title: "Active Schemas",
      query: [
        "SELECT",
        "  COUNT(DISTINCT table_schema)::bigint AS total_schemas,",
        "  'schemas' AS label",
        "FROM information_schema.tables",
        "WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
        "  AND table_type = 'BASE TABLE';",
      ].join("\n"),
      colSpan: 3,
      rowSpan: 3,
      gridX: 3,
      gridY: 8,
    },
    {
      type: "bar",
      title: "Table Size by Table",
      query: [
        "SELECT",
        "  relname AS label,",
        "  pg_total_relation_size(relid)::bigint AS value",
        "FROM pg_stat_user_tables",
        "WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
        "ORDER BY value DESC NULLS LAST, label ASC",
        "LIMIT 12;",
      ].join("\n"),
      colSpan: 4,
      rowSpan: 4,
      gridX: 6,
      gridY: 8,
    },
    {
      type: "pie",
      title: "Column Share by Table",
      query: [
        "SELECT",
        "  table_name AS label,",
        "  COUNT(*)::bigint AS value",
        "FROM information_schema.columns",
        "WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
        "GROUP BY table_name",
        "ORDER BY value DESC, label ASC",
        "LIMIT 8;",
      ].join("\n"),
      colSpan: 4,
      rowSpan: 4,
      gridX: 10,
      gridY: 8,
    },
  ];
}

function buildPostgresOverviewSeeds(
  schemaHints?: AIMetricsSchemaTableHint[],
): MetricsWidgetSeed[] {
  const adaptiveTemplate = getPostgresAdaptiveOverviewTemplate(schemaHints);
  if (adaptiveTemplate) {
    return adaptiveTemplate.widgets;
  }
  return buildPostgresSchemaOverviewSeeds();
}

function buildMySqlOverviewSeeds(): MetricsWidgetSeed[] {
  return [
    {
      type: "scoreboard",
      title: "Total Tables",
      query: [
        "SELECT",
        "  COUNT(*) AS total_tables,",
        "  'tables' AS label",
        "FROM information_schema.tables",
        "WHERE table_schema = DATABASE()",
        "  AND table_type = 'BASE TABLE';",
      ].join("\n"),
      colSpan: 3,
      rowSpan: 3,
      gridX: 0,
      gridY: 0,
    },
    {
      type: "scoreboard",
      title: "Estimated Rows",
      query: [
        "SELECT",
        "  COALESCE(SUM(table_rows), 0) AS estimated_rows,",
        "  'rows' AS label",
        "FROM information_schema.tables",
        "WHERE table_schema = DATABASE()",
        "  AND table_type = 'BASE TABLE';",
      ].join("\n"),
      colSpan: 3,
      rowSpan: 3,
      gridX: 3,
      gridY: 0,
    },
    {
      type: "bar",
      title: "Top Tables by Rows",
      query: [
        "SELECT",
        "  table_name AS label,",
        "  COALESCE(table_rows, 0) AS value",
        "FROM information_schema.tables",
        "WHERE table_schema = DATABASE()",
        "  AND table_type = 'BASE TABLE'",
        "ORDER BY value DESC, label ASC",
        "LIMIT 12;",
      ].join("\n"),
      colSpan: 4,
      rowSpan: 4,
      gridX: 6,
      gridY: 0,
    },
    {
      type: "pie",
      title: "Row Share by Table",
      query: [
        "SELECT",
        "  table_name AS label,",
        "  COALESCE(table_rows, 0) AS value",
        "FROM information_schema.tables",
        "WHERE table_schema = DATABASE()",
        "  AND table_type = 'BASE TABLE'",
        "ORDER BY value DESC, label ASC",
        "LIMIT 8;",
      ].join("\n"),
      colSpan: 4,
      rowSpan: 4,
      gridX: 10,
      gridY: 0,
    },
    {
      type: "table",
      title: "Largest Tables",
      query: [
        "SELECT",
        "  table_name,",
        "  COALESCE(table_rows, 0) AS estimated_rows,",
        "  ROUND((COALESCE(data_length, 0) + COALESCE(index_length, 0)) / 1024 / 1024, 1) AS total_mb",
        "FROM information_schema.tables",
        "WHERE table_schema = DATABASE()",
        "  AND table_type = 'BASE TABLE'",
        "ORDER BY estimated_rows DESC, table_name ASC",
        "LIMIT 10;",
      ].join("\n"),
      colSpan: 6,
      rowSpan: 4,
      gridX: 0,
      gridY: 4,
    },
    {
      type: "bar",
      title: "Columns by Table",
      query: [
        "SELECT",
        "  table_name AS label,",
        "  COUNT(*) AS value",
        "FROM information_schema.columns",
        "WHERE table_schema = DATABASE()",
        "GROUP BY table_name",
        "ORDER BY value DESC, label ASC",
        "LIMIT 12;",
      ].join("\n"),
      colSpan: 6,
      rowSpan: 4,
      gridX: 6,
      gridY: 4,
    },
  ];
}

function buildMsSqlOverviewSeeds(): MetricsWidgetSeed[] {
  return [
    {
      type: "scoreboard",
      title: "Total Tables",
      query: [
        "SELECT",
        "  COUNT(*) AS total_tables,",
        "  'tables' AS label",
        "FROM sys.tables;",
      ].join("\n"),
      colSpan: 3,
      rowSpan: 3,
      gridX: 0,
      gridY: 0,
    },
    {
      type: "scoreboard",
      title: "Estimated Rows",
      query: [
        "SELECT",
        "  COALESCE(SUM(p.rows), 0) AS estimated_rows,",
        "  'rows' AS label",
        "FROM sys.partitions p",
        "WHERE p.index_id IN (0, 1);",
      ].join("\n"),
      colSpan: 3,
      rowSpan: 3,
      gridX: 3,
      gridY: 0,
    },
    {
      type: "bar",
      title: "Top Tables by Rows",
      query: [
        "SELECT TOP (12)",
        "  CONCAT(s.name, '.', t.name) AS label,",
        "  SUM(p.rows) AS value",
        "FROM sys.tables t",
        "JOIN sys.schemas s ON s.schema_id = t.schema_id",
        "JOIN sys.partitions p ON p.object_id = t.object_id",
        "WHERE p.index_id IN (0, 1)",
        "GROUP BY s.name, t.name",
        "ORDER BY value DESC, label ASC;",
      ].join("\n"),
      colSpan: 4,
      rowSpan: 4,
      gridX: 6,
      gridY: 0,
    },
    {
      type: "pie",
      title: "Row Share by Table",
      query: [
        "SELECT TOP (8)",
        "  CONCAT(s.name, '.', t.name) AS label,",
        "  SUM(p.rows) AS value",
        "FROM sys.tables t",
        "JOIN sys.schemas s ON s.schema_id = t.schema_id",
        "JOIN sys.partitions p ON p.object_id = t.object_id",
        "WHERE p.index_id IN (0, 1)",
        "GROUP BY s.name, t.name",
        "ORDER BY value DESC, label ASC;",
      ].join("\n"),
      colSpan: 4,
      rowSpan: 4,
      gridX: 10,
      gridY: 0,
    },
    {
      type: "table",
      title: "Largest Tables",
      query: [
        "WITH row_counts AS (",
        "  SELECT",
        "    t.object_id,",
        "    SUM(p.rows) AS row_count",
        "  FROM sys.tables t",
        "  JOIN sys.partitions p ON p.object_id = t.object_id",
        "  WHERE p.index_id IN (0, 1)",
        "  GROUP BY t.object_id",
        ")",
        "SELECT TOP (10)",
        "  CONCAT(s.name, '.', t.name) AS table_name,",
        "  COALESCE(rc.row_count, 0) AS row_count,",
        "  COUNT(c.column_id) AS column_count",
        "FROM sys.tables t",
        "JOIN sys.schemas s ON s.schema_id = t.schema_id",
        "LEFT JOIN row_counts rc ON rc.object_id = t.object_id",
        "LEFT JOIN sys.columns c ON c.object_id = t.object_id",
        "GROUP BY s.name, t.name, rc.row_count",
        "ORDER BY row_count DESC, table_name ASC;",
      ].join("\n"),
      colSpan: 6,
      rowSpan: 4,
      gridX: 0,
      gridY: 4,
    },
    {
      type: "bar",
      title: "Columns by Table",
      query: [
        "SELECT TOP (12)",
        "  CONCAT(s.name, '.', t.name) AS label,",
        "  COUNT(c.column_id) AS value",
        "FROM sys.tables t",
        "JOIN sys.schemas s ON s.schema_id = t.schema_id",
        "LEFT JOIN sys.columns c ON c.object_id = t.object_id",
        "GROUP BY s.name, t.name",
        "ORDER BY value DESC, label ASC;",
      ].join("\n"),
      colSpan: 6,
      rowSpan: 4,
      gridX: 6,
      gridY: 4,
    },
  ];
}

function buildDatabaseOverviewBoardTemplate(
  dbType?: DatabaseType,
  schemaHints?: AIMetricsSchemaTableHint[],
): MetricsTemplateDefinition | null {
  switch (dbType) {
    case "postgresql":
    case "cockroachdb":
    case "greenplum":
    case "redshift": {
      const adaptiveTemplate = getPostgresAdaptiveOverviewTemplate(schemaHints);
      return {
        title: adaptiveTemplate?.title ?? "DB Overview Dashboard",
        widgets: buildPostgresOverviewSeeds(schemaHints),
      };
    }
    case "mysql":
    case "mariadb":
      return {
        title: "DB Overview Dashboard",
        widgets: buildMySqlOverviewSeeds(),
      };
    case "mssql":
      return {
        title: "DB Overview Dashboard",
        widgets: buildMsSqlOverviewSeeds(),
      };
    default:
      return null;
  }
}

function getAIMetricsBoardTemplateDefinition(
  template: AIMetricsBoardTemplate,
  dbType?: DatabaseType,
  schemaHints?: AIMetricsSchemaTableHint[],
) {
  if (template === "database-overview") {
    return buildDatabaseOverviewBoardTemplate(dbType, schemaHints);
  }
  return null;
}

export function supportsAIMetricsBoardTemplate(
  template: AIMetricsBoardTemplate,
  dbType?: DatabaseType,
  schemaHints?: AIMetricsSchemaTableHint[],
) {
  return getAIMetricsBoardTemplateDefinition(template, dbType, schemaHints) !== null;
}

function resolveBoardTitle(
  requestedTitle: string | undefined,
  templateTitle: string,
  fallbackTitle?: string,
) {
  const normalizedRequestedTitle = requestedTitle?.trim();
  if (!normalizedRequestedTitle || normalizedRequestedTitle === "DB Overview Dashboard") {
    return fallbackTitle ?? templateTitle;
  }
  return normalizedRequestedTitle;
}

export function createAIMetricsBoardDefinition(args: {
  detail: OpenAIMetricsBoardDetail;
  dbType?: DatabaseType;
  connectionId: string;
  existingBoards: MetricsBoardDefinition[];
  schemaHints?: AIMetricsSchemaTableHint[];
}) {
  const template = args.detail.template ?? "database-overview";
  const builtTemplate = getAIMetricsBoardTemplateDefinition(template, args.dbType, args.schemaHints);
  if (!builtTemplate) {
    return null;
  }

  const now = Date.now();
  const requestedTitle = resolveBoardTitle(args.detail.title, builtTemplate.title);
  return {
    id: `metrics-${crypto.randomUUID()}`,
    name: createUniqueBoardName(requestedTitle, args.existingBoards),
    connection_id: args.connectionId,
    database: args.detail.database,
    widgets: builtTemplate.widgets.map(createWidgetFromSeed),
    created_at: now,
    updated_at: now,
  } satisfies MetricsBoardDefinition;
}

export function augmentAIMetricsBoardDefinition(args: {
  board: MetricsBoardDefinition;
  detail: OpenAIMetricsBoardDetail;
  dbType?: DatabaseType;
  schemaHints?: AIMetricsSchemaTableHint[];
}) {
  const template = args.detail.template ?? "database-overview";
  const builtTemplate = getAIMetricsBoardTemplateDefinition(template, args.dbType, args.schemaHints);
  if (!builtTemplate) {
    return null;
  }

  const normalizedExistingWidgetKeys = new Set(
    args.board.widgets.map((widget) =>
      `${widget.type}::${widget.title.trim().toLowerCase()}::${widget.query.replace(/\s+/g, " ").trim().toLowerCase()}`,
    ),
  );

  const nextWidgets = [...args.board.widgets];
  let addedCount = 0;
  const addedTitles: string[] = [];
  const addedWidgetIds: string[] = [];

  builtTemplate.widgets.forEach((seed) => {
    const widgetKey = `${seed.type}::${seed.title.trim().toLowerCase()}::${seed.query
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()}`;
    if (normalizedExistingWidgetKeys.has(widgetKey)) {
      return;
    }

    const baseWidget = createWidgetFromSeed(seed);
    const placedWidget = canPlaceWidget(nextWidgets, baseWidget)
      ? baseWidget
      : findFirstAvailablePosition(nextWidgets, baseWidget);

    nextWidgets.push(placedWidget);
    normalizedExistingWidgetKeys.add(widgetKey);
    addedCount += 1;
    addedTitles.push(seed.title);
    addedWidgetIds.push(placedWidget.id);
  });

  return {
    board: {
      ...args.board,
      name: resolveBoardTitle(args.detail.title, builtTemplate.title, args.board.name),
      widgets: nextWidgets,
      updated_at: Date.now(),
    } satisfies MetricsBoardDefinition,
    addedCount,
    addedTitles,
    addedWidgetIds,
  };
}

export function rebuildAIMetricsBoardDefinition(args: {
  board: MetricsBoardDefinition;
  detail: OpenAIMetricsBoardDetail;
  dbType?: DatabaseType;
  schemaHints?: AIMetricsSchemaTableHint[];
}) {
  const template = args.detail.template ?? "database-overview";
  const builtTemplate = getAIMetricsBoardTemplateDefinition(template, args.dbType, args.schemaHints);
  if (!builtTemplate) {
    return null;
  }

  const rebuiltWidgets = builtTemplate.widgets.map(createWidgetFromSeed);

  return {
    board: {
      ...args.board,
      name: resolveBoardTitle(args.detail.title, builtTemplate.title, args.board.name),
      database: args.detail.database ?? args.board.database,
      widgets: rebuiltWidgets,
      updated_at: Date.now(),
    } satisfies MetricsBoardDefinition,
    addedCount: rebuiltWidgets.length,
    addedTitles: rebuiltWidgets.map((widget) => widget.title),
    addedWidgetIds: rebuiltWidgets.map((widget) => widget.id),
  };
}
