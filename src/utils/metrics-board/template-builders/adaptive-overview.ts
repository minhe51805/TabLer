import {
  type AIMetricsSchemaTableHint,
  type MetricsTemplateDefinition,
} from "../shared";
import { buildPostgresCommerceOperationsTemplate } from "./commerce-operations";
import { buildPostgresRecruitmentOverviewTemplate } from "./recruitment-overview";

export function getPostgresAdaptiveOverviewTemplate(
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
