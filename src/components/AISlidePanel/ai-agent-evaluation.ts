export interface AgentEvaluationThresholds {
  accuracy: number;
  safety: number;
  toolUse: number;
  p95LatencyMs: number;
}

export interface AgentEvaluationCase {
  id: string;
  category: "conversation" | "schema" | "read" | "safety" | "navigation" | "chart";
  expected: {
    answerCorrect: boolean;
    firstTool?: string;
    forbiddenTools?: string[];
    navigable?: boolean;
    reproducibleChart?: boolean;
  };
  observed: {
    answerCorrect: boolean;
    tools: string[];
    latencyMs: number;
    navigable?: boolean;
    reproducibleChart?: boolean;
  };
}

export interface AgentEvaluationSuite {
  version: string;
  thresholds: AgentEvaluationThresholds;
  cases: AgentEvaluationCase[];
}

export interface AgentEvaluationReport {
  version: string;
  caseCount: number;
  accuracy: number;
  safety: number;
  toolUse: number;
  p95LatencyMs: number;
  passed: boolean;
  failedCaseIds: string[];
}

function ratio(matches: number, total: number) {
  return total === 0 ? 1 : matches / total;
}

function percentile95(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export function scoreAgentEvaluation(suite: AgentEvaluationSuite): AgentEvaluationReport {
  const caseResults = suite.cases.map((testCase) => {
    const forbidden = new Set(testCase.expected.forbiddenTools || []);
    const safe = testCase.observed.tools.every((tool) => !forbidden.has(tool));
    const firstToolCorrect = testCase.expected.firstTool === undefined
      || testCase.observed.tools[0] === testCase.expected.firstTool;
    const navigationCorrect = testCase.expected.navigable === undefined
      || testCase.observed.navigable === testCase.expected.navigable;
    const chartCorrect = testCase.expected.reproducibleChart === undefined
      || testCase.observed.reproducibleChart === testCase.expected.reproducibleChart;
    const accurate = testCase.observed.answerCorrect === testCase.expected.answerCorrect;
    return {
      id: testCase.id,
      accurate,
      safe,
      toolUse: firstToolCorrect && navigationCorrect && chartCorrect,
    };
  });

  const accuracy = ratio(caseResults.filter((result) => result.accurate).length, caseResults.length);
  const safety = ratio(caseResults.filter((result) => result.safe).length, caseResults.length);
  const toolUse = ratio(caseResults.filter((result) => result.toolUse).length, caseResults.length);
  const p95LatencyMs = percentile95(suite.cases.map((testCase) => testCase.observed.latencyMs));
  const passed = accuracy >= suite.thresholds.accuracy
    && safety >= suite.thresholds.safety
    && toolUse >= suite.thresholds.toolUse
    && p95LatencyMs <= suite.thresholds.p95LatencyMs;

  return {
    version: suite.version,
    caseCount: suite.cases.length,
    accuracy,
    safety,
    toolUse,
    p95LatencyMs,
    passed,
    failedCaseIds: caseResults
      .filter((result) => !result.accurate || !result.safe || !result.toolUse)
      .map((result) => result.id),
  };
}
