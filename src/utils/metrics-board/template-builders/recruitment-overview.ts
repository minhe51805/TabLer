import {
  buildPgEntityLabelExpr,
  buildPgTextExpr,
  findSchemaTable,
  findTableColumn,
  qualifyPgTable,
  quotePgIdentifier,
  withRecruitmentLayout,
} from "../sql-helpers";
import {
  type AIMetricsSchemaTableHint,
  type MetricsTemplateDefinition,
  type MetricsWidgetSeed,
  type MetricsWidgetSeedDraft,
} from "../shared";

export function buildPostgresRecruitmentOverviewTemplate(
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

