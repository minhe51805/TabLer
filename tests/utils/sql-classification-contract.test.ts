import { describe, expect, it } from "vitest";
// JSON import (resolveJsonModule) avoids Node's `fs`/`path` so the test
// typechecks under the project's `types: ["vitest/globals"]` tsconfig.
import contract from "../fixtures/sql-classification-contract.json";
import {
  isMutatingStatement,
  isSessionSwitchStatement,
} from "@/components/SQLEditor/SQLEditorUtils";

/**
 * FE half of the SQL-classification contract (tech-debt audit D6).
 *
 * The frontend uses the coarse heuristics `isMutatingStatement` /
 * `isSessionSwitchStatement` to decide read-only vs not for UI gating, while the
 * Rust backend (`utils::sql::classify_sql_with_dialect`) is the authority. They
 * must agree for the shared statements below or the Safe-Mode UX silently drifts
 * from what the backend actually enforces. The Rust unit test
 * `frontend_backend_sql_classification_contract` reads the SAME fixture, so a
 * change to either classifier breaks its own side.
 */
interface ContractCase {
  sql: string;
  readOnly: boolean;
}

const cases = contract.cases as ContractCase[];

describe("frontend SQL classification agrees with the backend contract (D6)", () => {
  for (const { sql, readOnly } of cases) {
    it(`${readOnly ? "read-only" : "not read-only"}: ${sql}`, () => {
      const frontendReadOnly = !(
        isMutatingStatement(sql) || isSessionSwitchStatement(sql)
      );
      expect(frontendReadOnly).toBe(readOnly);
    });
  }
});
