use super::parse::{classify_sql_event, skeleton};
use super::types::{
    CompiledRule, RuleAction, RuleMatch, RuleOrigin, RuleScan, RuleVerdict, SqlEvent,
    MAX_STATEMENT_LEN,
};
pub fn evaluate_rules_for_event(
    rules: &[CompiledRule],
    statement: &str,
    event: SqlEvent,
) -> RuleVerdict {
    if statement.len() > MAX_STATEMENT_LEN {
        let shortfall = statement.len() - MAX_STATEMENT_LEN;
        let mut verdict = RuleVerdict::from_matches(
            event,
            vec![RuleMatch {
                name: "statement-too-large".to_string(),
                description: format!(
                    "statement is {shortfall} bytes past the {MAX_STATEMENT_LEN}-byte guardrail limit; refusing to judge it"
                ),
                action: RuleAction::Block,
                origin: RuleOrigin::Builtin,
            }],
        );
        verdict.event = event;
        return verdict;
    }

    let requested = event.guardrail_event();

    // The skeleton is the safe default, but a rule that deliberately inspects
    // literal text (`'..' + @id` concatenation) must see the statement as it was
    // written - the skeleton would erase the very characters it looks for.
    let mut skeleton_body: Option<String> = None;
    let mut raw_body: Option<String> = None;

    let mut matched: Vec<RuleMatch> = Vec::new();

    for candidate in rules {
        if !candidate.rule.enabled || !candidate.rule.event.covers(requested) {
            continue;
        }

        let body: &str = match candidate.rule.scan {
            RuleScan::Skeleton => skeleton_body.get_or_insert_with(|| skeleton(statement)),
            RuleScan::Raw => raw_body.get_or_insert_with(|| statement.to_string()),
        };

        if !candidate.matcher.is_match(body) {
            continue;
        }

        // `pattern-not` is an escape hatch: `DELETE ... WHERE` satisfies both
        // patterns, and the exception is what makes it allowed.
        if let Some(exception) = &candidate.exception {
            if exception.is_match(body) {
                continue;
            }
        }

        matched.push(RuleMatch {
            name: candidate.rule.name.clone(),
            description: candidate.rule.description.clone(),
            action: candidate.rule.action,
            origin: candidate.rule.origin,
        });
    }

    RuleVerdict::from_matches(event, matched)
}

/// Classify the statement, then evaluate it. The convenience entry point every
/// caller should use: it cannot forget to derive the event.
pub fn evaluate_rules(rules: &[CompiledRule], statement: &str) -> RuleVerdict {
    let event = classify_sql_event(statement);
    evaluate_rules_for_event(rules, statement, event)
}
