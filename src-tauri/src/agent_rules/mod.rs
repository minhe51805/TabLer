mod commands;
mod eval;
mod parse;
mod roots;
mod seed;
mod types;

// Glob re-exports so the `__cmd__*` symbols `#[tauri::command]` generates stay
// reachable through `agent_rules::<command>` for `generate_handler!`.
pub use commands::*;
pub use seed::*;

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::eval::*;
    use super::parse::*;
    use super::roots::*;
    use super::types::*;
    use super::*;

    /// Ephemeral rules root; the seeder is never pointed at the real data dir in
    /// tests so a test run cannot disturb the developer's own guardrails.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "tabler-rule-seed-{}-{}-{}",
                label,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&dir).expect("temp root");
            TempRoot(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The embedded pack, compiled exactly the way the loader compiles it - no
    /// filesystem involved, so a pattern regression fails here and not in prod.
    fn builtin_rules() -> Vec<CompiledRule> {
        BUILTIN_RULES
            .iter()
            .map(|(file_name, contents)| {
                let rule = parse_rule(file_name, contents, RuleOrigin::Builtin)
                    .unwrap_or_else(|error| panic!("{file_name}: {error}"));
                compile_rule(rule).unwrap_or_else(|error| panic!("{file_name}: {error}"))
            })
            .collect()
    }

    fn fired(verdict: &RuleVerdict) -> Vec<String> {
        verdict
            .matched_rules
            .iter()
            .map(|matched| matched.name.clone())
            .collect()
    }

    fn write_rule(root: &Path, file_name: &str, body: &str) {
        std::fs::create_dir_all(root).expect("rules root");
        std::fs::write(root.join(file_name), body).expect("rule file");
    }

    /// A minimal valid rule body, so shadowing/disabled/error tests stay readable.
    fn rule_body(name: &str, pattern: &str, action: &str, extra: &str) -> String {
        format!(
            "---\nname: {name}\ndescription: test rule {name}\nevent: pre_write\npattern: {pattern}\n{extra}action: {action}\n---\n"
        )
    }

    #[test]
    fn every_builtin_rule_parses_and_compiles() {
        let rules = builtin_rules();
        assert_eq!(
            rules.len(),
            BUILTIN_RULES.len(),
            "every embedded rule must survive parse + compile"
        );
        assert_eq!(builtin_rule_manifest().len(), BUILTIN_RULES.len());
        for rule in &rules {
            assert!(
                !rule.rule.name.is_empty(),
                "built-in rule must declare its own name"
            );
            assert!(
                !rule.rule.description.is_empty(),
                "{}: description is what the agent shows the user",
                rule.rule.name
            );
        }
    }

    /// The regression that matters most: an inert guardrail is worse than no
    /// guardrail, so every shipped rule is proven to fire on the statement it
    /// exists to catch. A typo in a pattern (the `(?i)`-mid-pattern bug class)
    /// fails here instead of silently disarming the pack.
    #[test]
    fn every_builtin_rule_fires_on_the_statement_it_must_catch() {
        let rules = builtin_rules();
        let cases: &[(&str, &str)] = &[
            ("no-delete-without-where", "DELETE FROM users"),
            ("no-update-without-where", "UPDATE users SET name = 'x'"),
            ("no-drop-truncate-without-explicit-ask", "DROP TABLE users"),
            (
                "no-drop-truncate-without-explicit-ask",
                "TRUNCATE TABLE users",
            ),
            ("no-select-star-on-large-table", "SELECT * FROM users"),
            (
                "require-parameterized-literals",
                "EXEC('select id from t where id = ' + @id)",
            ),
            (
                "require-transaction-for-multi-statement-write",
                "UPDATE a SET x = 1; DELETE FROM b",
            ),
            (
                "no-cross-database-write",
                "UPDATE sales.dbo.orders SET total = 1",
            ),
            (
                "no-lock-hints-on-write",
                "UPDATE users SET name = 1 WITH (UPDLOCK)",
            ),
        ];

        for (expected, statement) in cases {
            let verdict = evaluate_rules(&rules, statement);
            assert!(
                fired(&verdict).iter().any(|name| name == expected),
                "`{statement}` must fire {expected}; fired={:?}",
                fired(&verdict)
            );
        }
    }

    #[test]
    fn delete_and_update_with_a_where_clause_are_allowed() {
        let rules = builtin_rules();

        for statement in [
            "DELETE FROM users WHERE id = 1",
            "UPDATE users SET name = 'x' WHERE id = 1",
        ] {
            let verdict = evaluate_rules(&rules, statement);
            assert!(
                fired(&verdict).is_empty(),
                "`{statement}` must be allowed; fired={:?}",
                fired(&verdict)
            );
            assert_eq!(verdict.decision, "allow");
        }
    }

    /// `pattern-not` is the escape hatch, and the skeleton is what keeps a
    /// keyword inside a comment from disarming it: a commented-out `WHERE` must
    /// not talk the guardrail out of blocking an unfiltered `DELETE`.
    #[test]
    fn a_commented_out_where_cannot_satisfy_the_guardrail() {
        let rules = builtin_rules();
        let verdict = evaluate_rules(&rules, "DELETE FROM users -- WHERE id = 1");
        assert_eq!(verdict.decision, "block", "fired={:?}", fired(&verdict));
    }

    #[test]
    fn skeleton_erases_a_destructive_keyword_hidden_in_a_literal_or_comment() {
        let rules = builtin_rules();

        for statement in [
            "UPDATE users SET note = 'DROP TABLE users' WHERE id = 1",
            "UPDATE users SET note = 'TRUNCATE TABLE users' WHERE id = 1",
            "UPDATE users SET note = 1 WHERE id = 1 -- DROP TABLE users",
            "UPDATE users SET note = 1 /* DROP TABLE users */ WHERE id = 1",
        ] {
            let verdict = evaluate_rules(&rules, statement);
            let names = fired(&verdict);
            assert!(
                !names
                    .iter()
                    .any(|name| name == "no-drop-truncate-without-explicit-ask"),
                "`{statement}` must not fire the DDL guardrail; fired={names:?}"
            );
        }
    }

    /// A rule that deliberately inspects literal text (`scan: raw`) must still
    /// see the string it looks for, otherwise the parameterization guardrail
    /// would be inert by construction.
    #[test]
    fn raw_scan_rules_see_string_literals() {
        let rules = builtin_rules();
        let verdict = evaluate_rules(&rules, "EXEC('select id from t where id = ' + @id)");
        assert!(
            fired(&verdict)
                .iter()
                .any(|name| name == "require-parameterized-literals"),
            "raw-scan rule must observe the concatenation; fired={:?}",
            fired(&verdict)
        );
    }

    #[test]
    fn classify_sql_event_separates_reads_writes_and_unknown() {
        for statement in [
            "SELECT id FROM users",
            "SHOW TABLES",
            "EXPLAIN ANALYZE SELECT 1",
            "WITH cte AS (SELECT 1) SELECT * FROM cte",
        ] {
            assert_eq!(
                classify_sql_event(statement),
                SqlEvent::Read,
                "`{statement}` should classify as a read"
            );
        }

        for statement in [
            "DELETE FROM users",
            "UPDATE users SET a = 1",
            "DROP TABLE users",
            "GRANT SELECT TO someone",
            "BEGIN TRAN",
        ] {
            assert_eq!(
                classify_sql_event(statement),
                SqlEvent::Write,
                "`{statement}` should classify as a write"
            );
        }

        for statement in ["", "   ", ";;"] {
            assert_eq!(
                classify_sql_event(statement),
                SqlEvent::Unknown,
                "`{statement}` should classify as unknown"
            );
        }
    }

    /// A script is only as safe as its most dangerous statement, and a `;` inside
    /// a literal must not split one statement into two.
    #[test]
    fn a_read_prefixed_script_that_writes_is_a_write() {
        assert_eq!(
            classify_sql_event("SELECT 1; DELETE FROM users"),
            SqlEvent::Write
        );
        assert_eq!(
            classify_sql_event("SELECT 'a;b' FROM users"),
            SqlEvent::Read,
            "a `;` inside a literal must not split the statement"
        );
    }

    /// Unknown statements are treated as writes, so nothing with write-sized
    /// blast radius slips past the write pack.
    #[test]
    fn an_unknown_statement_is_guarded_as_a_write() {
        assert_eq!(SqlEvent::Unknown.guardrail_event(), RuleEvent::PreWrite);
        assert_eq!(SqlEvent::Read.guardrail_event(), RuleEvent::PreRead);
    }

    /// Several rules may fire at once; the verdict must be the strictest action,
    /// never the first or the last one seen.
    #[test]
    fn a_verdict_folds_every_match_into_the_strictest_action() {
        let rules = builtin_rules();
        let verdict = evaluate_rules(&rules, "DELETE FROM a; DELETE FROM b");

        let names = fired(&verdict);
        assert!(
            names.iter().any(|name| name == "no-delete-without-where")
                && names
                    .iter()
                    .any(|name| name == "require-transaction-for-multi-statement-write"),
            "both the block and the warn rule should fire; fired={names:?}"
        );
        assert_eq!(verdict.decision, "block");
        assert_eq!(verdict.action, RuleAction::Block);
        assert!(!verdict.message.is_empty(), "the user must get a reason");
    }

    /// The guardrail refuses to judge an oversized statement instead of getting
    /// slow or blowing the stack: refusing is the fail-closed answer.
    #[test]
    fn an_oversized_statement_is_denied_rather_than_unjudged() {
        let rules = builtin_rules();
        let huge = "a".repeat(MAX_STATEMENT_LEN + 1);
        let verdict = evaluate_rules(&rules, &huge);

        assert_eq!(verdict.decision, "block");
        assert_eq!(verdict.action, RuleAction::Block);
        assert!(
            fired(&verdict)
                .iter()
                .any(|name| name == "statement-too-large"),
            "the reason must name the limit; fired={:?}",
            fired(&verdict)
        );
    }

    /// An invalid pattern must surface as an error, never as a silent skip - the
    /// `(?i)`-mid-pattern bug shipped an inert guardrail precisely because a
    /// broken rule compiled to nothing and nothing said so.
    #[test]
    fn an_invalid_pattern_is_reported_instead_of_silently_skipped() {
        let broken = rule_body("broken-rule", "(unclosed[", "block", "");
        let parsed = parse_rule("broken-rule", &broken, RuleOrigin::Workspace)
            .expect("frontmatter is valid");
        let error = compile_rule(parsed).expect_err("an invalid regex must fail");
        assert!(
            error.contains("broken-rule") && error.contains("invalid pattern"),
            "error should name the rule and the cause: {error}"
        );

        let root = TempRoot::new("broken");
        write_rule(root.path(), "broken-rule.md", &broken);
        let (rules, report) = load_rules_from_roots(&[root.path().to_path_buf()]);

        assert!(rules.is_empty(), "a broken rule must not be armed");
        assert_eq!(report.loaded, 0);
        assert_eq!(
            report.errors.len(),
            1,
            "the failure must be reported: {:?}",
            report.errors
        );
        assert!(report.errors[0].reason.contains("invalid pattern"));
    }

    #[test]
    fn a_rule_without_a_description_is_an_error() {
        let body = "---\nname: nameless\nevent: pre_write\npattern: delete\n---\n";
        let error = parse_rule("nameless", body, RuleOrigin::Workspace)
            .expect_err("a rule must explain itself");
        assert!(error.contains("description"), "unexpected error: {error}");
    }

    #[test]
    fn a_disabled_rule_never_fires() {
        let root = TempRoot::new("disabled");
        let body = rule_body(
            "disabled-block",
            "\\bdelete\\b",
            "block",
            "enabled: false\n",
        );
        write_rule(root.path(), "disabled-block.md", &body);

        let (rules, report) = load_rules_from_roots(&[root.path().to_path_buf()]);
        assert_eq!(report.loaded, 1, "a disabled rule still loads");
        assert!(
            fired(&evaluate_rules(&rules, "DELETE FROM users")).is_empty(),
            "a disabled rule must not arm itself"
        );
    }

    /// A repo-local rule must shadow the built-in of the same name, not double it.
    #[test]
    fn a_workspace_rule_shadows_the_builtin_of_the_same_name() {
        let workspace = TempRoot::new("workspace");
        let data_dir = TempRoot::new("data");

        let seeded = seed_rules_into_root(data_dir.path(), false).expect("seed built-in pack");
        assert_eq!(seeded.installed, BUILTIN_RULES.len());

        let override_body = rule_body(
            "no-delete-without-where",
            "(?is)\\bdelete\\s+from\\b",
            "warn",
            "",
        );
        write_rule(
            workspace.path(),
            "no-delete-without-where.md",
            &override_body,
        );

        let (rules, report) = load_rules_from_roots(&[
            workspace.path().to_path_buf(),
            data_dir.path().to_path_buf(),
        ]);

        let names = fired(&evaluate_rules(&rules, "DELETE FROM users"));
        assert_eq!(
            names,
            vec!["no-delete-without-where".to_string()],
            "the rule must be armed exactly once"
        );
        assert!(
            report.skipped >= 1,
            "the shadowed built-in must be counted as skipped, not silently dropped"
        );

        let verdict = evaluate_rules(&rules, "DELETE FROM users");
        assert_eq!(
            verdict.action,
            RuleAction::Warn,
            "the workspace override must win, not the built-in block"
        );
    }

    #[test]
    fn seeded_builtin_rules_are_labelled_builtin_and_reload_untouched() {
        let root = TempRoot::new("origin");
        seed_rules_into_root(root.path(), false).expect("seed built-in pack");

        let (rules, report) = load_rules_from_roots(&[root.path().to_path_buf()]);
        assert_eq!(report.errors, Vec::new());
        assert_eq!(report.loaded, BUILTIN_RULES.len());
        assert!(rules
            .iter()
            .all(|rule| rule.rule.origin == RuleOrigin::Builtin));

        let verdict = evaluate_rules(&rules, "DELETE FROM users");
        assert_eq!(verdict.decision, "block");
    }

    /// Seeding runs on every startup, so it must be a no-op the second time - and
    /// it must never overwrite a rule the user edited (the whole point of the
    /// manifest is that a rule marked `userModified` is left alone).
    #[test]
    fn seeding_is_idempotent_and_never_clobbers_a_user_edit() {
        let root = TempRoot::new("lifecycle");
        let file_name = BUILTIN_RULES[0].0;
        let rule_path = root.path().join(file_name);

        let first = seed_rules_into_root(root.path(), false).expect("first seed");
        assert_eq!(first.installed, BUILTIN_RULES.len());
        assert_eq!(first.refreshed, 0);
        assert_eq!(first.user_modified, 0);
        assert!(rule_path.exists());

        let second = seed_rules_into_root(root.path(), false).expect("second seed");
        assert_eq!(second.installed, 0, "a re-seed must install nothing new");
        assert_eq!(second.unchanged, BUILTIN_RULES.len());
        assert_eq!(second.refreshed, 0);

        let customised = "---\nname: no-delete-without-where\ndescription: mine\npattern: (?is)\\bdelete\\b\naction: warn\n---\n";
        std::fs::write(&rule_path, customised).expect("user edit");

        let third = seed_rules_into_root(root.path(), false).expect("seed after user edit");
        assert_eq!(third.user_modified, 1);
        assert_eq!(
            std::fs::read_to_string(&rule_path).expect("rule still readable"),
            customised,
            "an upgrade must never overwrite a rule the user edited"
        );

        let forced = seed_rules_into_root(root.path(), true).expect("force seed");
        assert_eq!(forced.refreshed, 1);
        assert_eq!(
            std::fs::read_to_string(&rule_path).expect("rule restored"),
            BUILTIN_RULES[0].1,
            "the explicit reset is the only path that discards a user edit"
        );
    }

    /// A file the user deleted holds no intent, so the seeder restores it.
    #[test]
    fn a_deleted_builtin_rule_is_restored_on_the_next_seed() {
        let root = TempRoot::new("restore");
        seed_rules_into_root(root.path(), false).expect("first seed");

        let file_name = BUILTIN_RULES[1].0;
        let rule_path = root.path().join(file_name);
        std::fs::remove_file(&rule_path).expect("delete the rule");

        let report = seed_rules_into_root(root.path(), false).expect("re-seed");
        assert_eq!(report.installed, 1);
        assert!(
            rule_path.exists(),
            "a missing built-in must come back without a force flag"
        );
    }

    /// Regression: the rules manager lists what is *armed*, so opening the panel
    /// must not read as "this statement was blocked" just because a `block` rule
    /// is installed.
    #[test]
    fn the_armed_rules_inventory_never_reports_a_block() {
        let rules = builtin_rules();
        let inventory = RuleVerdict::inventory(
            rules
                .iter()
                .map(|candidate| RuleMatch {
                    name: candidate.rule.name.clone(),
                    description: candidate.rule.description.clone(),
                    action: candidate.rule.action,
                    origin: candidate.rule.origin,
                })
                .collect(),
        );

        assert!(inventory
            .matched_rules
            .iter()
            .any(|m| m.action == RuleAction::Block));
        assert_eq!(
            inventory.decision, "allow",
            "listing the pack is not an evaluation and must not inherit the strictest action"
        );
        assert!(inventory.message.is_empty());
    }

    #[test]
    fn the_seeder_writes_a_manifest_recording_every_builtin() {
        let root = TempRoot::new("manifest");
        seed_rules_into_root(root.path(), false).expect("seed built-in pack");

        let manifest_path = root.path().join(SEED_MANIFEST_NAME);
        assert!(
            manifest_path.exists(),
            "the manifest is what protects edits"
        );

        let manifest = load_rule_manifest(root.path());
        assert_eq!(manifest.rules.len(), BUILTIN_RULES.len());
        for (file_name, _) in BUILTIN_RULES {
            assert!(
                manifest.rules.contains_key(*file_name),
                "{file_name} must be recorded in the manifest"
            );
        }
    }
    #[test]
    fn saved_rule_round_trips_through_the_loader() {
        let root = std::env::temp_dir().join(format!("tabler-rule-save-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let spec = NewRuleSpec {
            name: "dead-column-users-deleted-at".to_string(),
            description: "users.deleted_at is never populated: review SQL that filters on it."
                .to_string(),
            enabled: true,
            event: RuleEvent::PreRead,
            action: RuleAction::Warn,
            pattern: r"(?i)\bdeleted_at\b".to_string(),
            pattern_not: None,
            scan: RuleScan::Skeleton,
        };

        let path = save_rule_into_root(&root, &spec).expect("rule saved");
        let contents = std::fs::read_to_string(&path).expect("rule file readable");
        let parsed = parse_rule(&spec.name, &contents, RuleOrigin::Global).expect("rule parses");
        assert_eq!(parsed.event, RuleEvent::PreRead);
        assert_eq!(parsed.action, RuleAction::Warn);
        assert_eq!(parsed.scan, RuleScan::Skeleton);
        assert_eq!(parsed.pattern, spec.pattern);
        assert!(parsed.enabled);
        compile_rule(parsed).expect("rule compiles");

        // A second save must not clobber a file the user may have edited.
        let again = save_rule_into_root(&root, &spec).expect_err("must refuse to overwrite");
        assert!(again.contains("already exists"), "got: {again}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_rule_that_cannot_compile_never_reaches_the_disk() {
        let root = std::env::temp_dir().join(format!("tabler-rule-broken-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let spec = NewRuleSpec {
            name: "broken-pattern".to_string(),
            description: "An invalid regex must be refused before anything is written.".to_string(),
            enabled: true,
            event: RuleEvent::Any,
            action: RuleAction::Warn,
            pattern: "(unclosed".to_string(),
            pattern_not: None,
            scan: RuleScan::Skeleton,
        };

        let error = save_rule_into_root(&root, &spec).expect_err("invalid regex is rejected");
        assert!(error.contains("cannot compile"), "got: {error}");
        assert!(
            !root.exists(),
            "a refused rule must not leave a directory behind"
        );
    }

    #[test]
    fn rule_names_are_slugs_so_a_name_cannot_escape_the_rules_dir() {
        assert!(validate_rule_name("../escape").is_err());
        assert!(validate_rule_name("Upper").is_err());
        assert!(validate_rule_name("a/b").is_err());
        assert!(validate_rule_name("").is_err());
        assert_eq!(
            validate_rule_name(" ok-name_1 ").expect("slug"),
            "ok-name_1"
        );
    }

    #[test]
    fn workspace_rule_written_by_the_command_is_picked_up_by_evaluation() {
        let temp = TempRoot::new("workspace-write");
        let workspace = temp.path().join("project");
        let content = rule_body("no-drop-table", "(?is)\\bdrop\\s+table\\b", "block", "");
        let rules_root = workspace.join(RULES_DIR_NAME);
        let path = write_rule_into_root(&rules_root, "no-drop-table", &content)
            .expect("valid rule is written");
        assert_eq!(path, rules_root.join("no-drop-table.md"));

        // The same load path `evaluate_agent_rules` uses must arm the new file.
        let (rules, report) = load_rules_from_roots(std::slice::from_ref(&rules_root));
        assert_eq!(report.errors, vec![], "written rule must load cleanly");
        let verdict = evaluate_rules(&rules, "DROP TABLE users");
        assert_eq!(verdict.decision, "block");
        assert_eq!(fired(&verdict), vec!["no-drop-table".to_string()]);

        // A second write must not clobber a file the user may have edited.
        let again = write_rule_into_root(&rules_root, "no-drop-table", &content)
            .expect_err("must refuse to overwrite");
        assert!(again.contains("already exists"), "got: {again}");

        // A rule that cannot compile never reaches the disk.
        let broken = rule_body("broken", "(unclosed", "warn", "");
        let error = write_rule_into_root(&rules_root, "broken", &broken)
            .expect_err("invalid regex is rejected");
        assert!(error.contains("cannot compile"), "got: {error}");
        assert!(!rules_root.join("broken.md").exists());
    }
}
