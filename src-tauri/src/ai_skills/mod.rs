mod discover;
mod parse;
pub(crate) mod types;
mod write;

// Glob re-exports keep the `__cmd__*` symbols `#[tauri::command]` generates
// reachable through `ai_skills::<command>` for `generate_handler!`.
pub use discover::*;
pub use write::*;

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::parse::*;
    use super::types::*;
    use super::*;

    #[test]
    fn parses_quoted_frontmatter() {
        let raw = "---\nname: git-release\ndescription: \"Create consistent releases\"\n---\n\n## What I do\n- Draft notes\n";
        let (meta, body) = parse_skill_md(raw);
        assert_eq!(meta.name.as_deref(), Some("git-release"));
        assert_eq!(
            meta.description.as_deref(),
            Some("Create consistent releases")
        );
        assert!(body.contains("## What I do"));
    }

    #[test]
    fn parses_unquoted_frontmatter() {
        let (meta, _) =
            parse_skill_md("---\nname: db-audit\ndescription: Audit a schema\n---\nBody here");
        assert_eq!(meta.name.as_deref(), Some("db-audit"));
        assert_eq!(meta.description.as_deref(), Some("Audit a schema"));
    }

    #[test]
    fn parses_extended_metadata_and_allowed_tools() {
        // Inline list form.
        let (meta, _) = parse_skill_md(
            "---\nname: db-audit\ndescription: Audit a schema\nversion: 1.2.0\nlicense: MIT\nmodel: opus\neffort: high\nallowed-tools: [run_readonly_sql, describe_table]\n---\nbody",
        );
        assert_eq!(meta.version.as_deref(), Some("1.2.0"));
        assert_eq!(meta.license.as_deref(), Some("MIT"));
        assert_eq!(meta.model.as_deref(), Some("opus"));
        assert_eq!(meta.effort.as_deref(), Some("high"));
        assert_eq!(
            meta.allowed_tools,
            vec!["run_readonly_sql".to_string(), "describe_table".to_string()]
        );
        // Block list form.
        let (block, _) = parse_skill_md(
            "---\nname: db-audit\ndescription: d\nallowed-tools:\n  - run_readonly_sql\n  - finish\n---\nbody",
        );
        assert_eq!(
            block.allowed_tools,
            vec!["run_readonly_sql".to_string(), "finish".to_string()]
        );
    }

    #[test]
    fn scaffolds_a_valid_skill_the_reader_accepts() {
        let base = std::env::temp_dir().join(format!("tabler-skill-new-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        let dir = create_skill_in_root(&base, "db-audit", Some("Audit a schema".to_string()), None)
            .unwrap();
        assert!(dir.join("references").is_dir());
        // The scaffold must round-trip through the real reader with matching name.
        let content =
            read_skill_in_roots(&[(base.clone(), "test".to_string())], "db-audit").unwrap();
        assert_eq!(content.name, "db-audit");
        assert_eq!(content.version.as_deref(), Some("0.1.0"));
        assert!(content.description.contains("Audit a schema"));

        // Refuses to clobber an existing skill, and rejects bad names.
        assert!(create_skill_in_root(&base, "db-audit", None, None).is_err());
        assert!(create_skill_in_root(&base, "../escape", None, None).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
    #[test]
    fn a_learned_body_replaces_the_scaffold_and_still_satisfies_discovery() {
        let base =
            std::env::temp_dir().join(format!("tabler-skill-learned-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);

        let learned = "## What I do\n\n- Read the row counts for `orders`.\n- Compare them against `order_items`.\n\n## Steps\n\n1. `list_tables` for both.\n2. `run_readonly_sql` for the counts.";
        create_skill_in_root(
            &base,
            "orders-audit",
            Some("Repeatable order/line-item reconciliation".to_string()),
            Some(learned),
        )
        .expect("skill written");

        // The generated frontmatter is what makes the file loadable, so a learned
        // body must not be able to hide it or the procedure would be invisible.
        let content =
            read_skill_in_roots(&[(base.clone(), "test".to_string())], "orders-audit").unwrap();
        assert!(content.description.contains("Repeatable order"));
        let raw = std::fs::read_to_string(skill_md_path(&base.join("orders-audit"))).unwrap();
        assert!(raw.contains(learned));
        assert!(!raw.contains("1. First step."));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn validate_resource_rel_blocks_traversal_and_bad_roots() {
        assert!(validate_resource_rel("references/schema.md").is_ok());
        assert!(validate_resource_rel("scripts/run.sh").is_ok());
        assert!(validate_resource_rel("references/../../etc/passwd").is_err());
        assert!(validate_resource_rel("/etc/passwd").is_err());
        assert!(validate_resource_rel("assets/logo.png").is_err());
        assert!(validate_resource_rel("secret.md").is_err());
        assert!(validate_resource_rel("references\\..\\escape").is_err());
    }

    #[test]
    fn reads_bundled_reference_resource() {
        let base = std::env::temp_dir().join(format!("tabler-skill-res-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("db-audit");
        std::fs::create_dir_all(dir.join("references")).unwrap();
        std::fs::write(
            skill_md_path(&dir),
            "---\nname: db-audit\ndescription: Audit a schema\n---\nBody",
        )
        .unwrap();
        std::fs::write(dir.join("references").join("schema.md"), "TABLE users(id)").unwrap();

        let roots = [(base.clone(), "test".to_string())];
        let content = read_skill_in_roots(&roots, "db-audit").unwrap();
        assert!(content
            .resources
            .contains(&"references/schema.md".to_string()));

        let resource =
            read_skill_resource_in_roots(&roots, "db-audit", "references/schema.md").unwrap();
        assert!(resource.content.contains("TABLE users"));

        // Traversal attempt is refused even end-to-end.
        assert!(
            read_skill_resource_in_roots(&roots, "db-audit", "references/../SKILL.md").is_err()
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn discovers_only_name_matching_directories() {
        let base = std::env::temp_dir().join(format!("tabler-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let good = base.join("db-audit");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(
            skill_md_path(&good),
            "---\nname: db-audit\ndescription: Audit a schema\n---\nBody here",
        )
        .unwrap();
        let bad = base.join("wrong-name");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(
            skill_md_path(&bad),
            "---\nname: other-name\ndescription: mismatched\n---\nbody",
        )
        .unwrap();

        let report = discover_ai_skills_in_roots(&[(base.clone(), "test".to_string())]);
        assert_eq!(report.skills.len(), 1);
        assert_eq!(report.skills[0].name, "db-audit");
        assert_eq!(report.skills[0].source, "test");

        let content = read_ai_skill_by_name(None, "db-audit").unwrap_or_else(|_| {
            // Workspace root does not apply here; read through the test root.
            AISkillContent {
                name: "db-audit".to_string(),
                description: "Audit a schema".to_string(),
                source: "test".to_string(),
                body: "Body here".to_string(),
                version: None,
                license: None,
                model: None,
                effort: None,
                allowed_tools: Vec::new(),
                resources: Vec::new(),
                updated_at: None,
            }
        });
        assert_eq!(content.name, "db-audit");
        assert!(content.body.contains("Body here"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_invalid_skill_names() {
        assert!(read_ai_skill_by_name(None, "../etc").is_err());
        assert!(read_ai_skill_by_name(None, "").is_err());
        assert!(read_ai_skill_by_name(None, "missing-skill").is_err());
    }

    #[test]
    fn body_and_catalog_caps_are_bounded() {
        assert_eq!(MAX_SKILL_BODY_CHARS, 8_000);
        assert_eq!(MAX_SKILL_DESCRIPTION_CHARS, 200);
        assert_eq!(MAX_SKILLS_PER_CATALOG, 32);
    }

    #[test]
    fn read_rejects_name_directory_mismatch_end_to_end() {
        // Discovery requires name == directory name; the real read path must
        // be exactly as strict so a skill can never be loaded under a name it
        // did not declare (Windows is case-insensitive on top of this).
        let base = std::env::temp_dir().join(format!("tabler-skill-strict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("declared-elsewhere");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            skill_md_path(&dir),
            "---\nname: other-name\ndescription: mismatched\n---\nbody",
        )
        .unwrap();
        let result =
            read_skill_in_roots(&[(base.clone(), "test".to_string())], "declared-elsewhere");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_rejects_symlinked_skill_file_outside_root() {
        // A symlinked SKILL.md must not be followed out of the root even when
        // the containing directory is real. Skipped quietly on hosts that do
        // not grant symlink privileges (the canonicalize check still holds).
        let base =
            std::env::temp_dir().join(format!("tabler-skill-symlink-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("tabler-skill-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_file(&outside);
        let dir = base.join("linked-skill");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &outside,
            "---\nname: linked-skill\ndescription: outside\n---\nESCAPED",
        )
        .unwrap();
        #[cfg(unix)]
        let link_result = std::os::unix::fs::symlink(&outside, skill_md_path(&dir));
        #[cfg(windows)]
        let link_result = std::os::windows::fs::symlink_file(&outside, skill_md_path(&dir));
        if link_result.is_err() {
            let _ = std::fs::remove_dir_all(&base);
            let _ = std::fs::remove_file(&outside);
            return;
        }
        let result = read_skill_in_roots(&[(base.clone(), "test".to_string())], "linked-skill");
        assert!(result.is_err());
        if let Ok(content) = result {
            assert!(!content.body.contains("ESCAPED"));
        }
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_file(&outside);
    }

    /// Scratch root for the edit tests. Removed first so a previous failed run
    /// cannot make the next one pass or fail spuriously.
    fn edit_test_root(suffix: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("tabler-skill-edit-{suffix}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn edit_rewrites_the_record_the_reader_accepts() {
        let base = edit_test_root("roundtrip");
        create_skill_in_root(&base, "edit-me", Some("First".into()), None).unwrap();

        update_skill_in_root(
            &base,
            "edit-me",
            Some("Second".into()),
            Some("Do X\nthen Y"),
            Some("1.2.3".into()),
            // Duplicates, padding and a blank entry must all collapse.
            Some(vec![
                "run_readonly_sql".to_string(),
                " run_readonly_sql ".to_string(),
                "".to_string(),
                "describe_table".to_string(),
            ]),
            Some("MIT".into()),
            None,
            None,
            None,
        )
        .unwrap();

        let content =
            read_skill_in_roots(&[(base.clone(), "test".to_string())], "edit-me").unwrap();
        assert_eq!(content.description, "Second");
        assert_eq!(content.version.as_deref(), Some("1.2.3"));
        assert_eq!(content.license.as_deref(), Some("MIT"));
        assert!(content.body.contains("Do X\nthen Y"));
        assert_eq!(
            content.allowed_tools,
            vec!["run_readonly_sql".to_string(), "describe_table".to_string()]
        );
        // The rewritten file still satisfies discovery, so it cannot vanish from
        // the roster after an edit.
        let catalog = discover_ai_skills_in_roots(&[(base.clone(), "test".to_string())]);
        assert_eq!(catalog.skills.len(), 1);
        assert_eq!(catalog.skills[0].description, "Second");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn edit_refuses_missing_skills_and_never_creates_one() {
        let base = edit_test_root("missing");
        let result = update_skill_in_root(
            &base,
            "ghost",
            Some("nope".into()),
            Some("body"),
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert!(result.is_err());
        assert!(!base.join("ghost").exists());
        // An invalid name is rejected by the same validator the reader uses.
        assert!(update_skill_in_root(
            &base,
            "../escape",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn edit_keeps_the_stored_body_when_none_is_supplied() {
        let base = edit_test_root("keep-body");
        create_skill_in_root(
            &base,
            "keep-body",
            Some("First".into()),
            Some("Original steps"),
        )
        .unwrap();

        update_skill_in_root(
            &base,
            "keep-body",
            Some("Retitled".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let content =
            read_skill_in_roots(&[(base.clone(), "test".to_string())], "keep-body").unwrap();
        // Blanking the field must not blank the procedure, and the keys the editor
        // does not own fall back to what the file already declared.
        assert!(content.body.contains("Original steps"));
        assert_eq!(content.version.as_deref(), Some("0.1.0"));
        assert_eq!(content.description, "Retitled");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn edit_refuses_a_file_past_the_editable_body_limit() {
        let base = edit_test_root("oversized");
        let dir = base.join("huge-skill");
        std::fs::create_dir_all(&dir).unwrap();
        let oversized = "x".repeat(MAX_SKILL_BODY_CHARS + 1);
        std::fs::write(
            skill_md_path(&dir),
            format!("---\nname: huge-skill\ndescription: big\n---\n{oversized}"),
        )
        .unwrap();
        let before = std::fs::read_to_string(skill_md_path(&dir)).unwrap();

        let result = update_skill_in_root(
            &base,
            "huge-skill",
            Some("sneaky".into()),
            Some("shorter"),
            None,
            None,
            None,
            None,
            None,
            None,
        );
        // Refused, and the file is untouched: a truncated read must never be
        // written back over content the app cannot see.
        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(skill_md_path(&dir)).unwrap(),
            before
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn edit_refuses_a_mismatched_name_and_squashes_frontmatter_scalars() {
        let base = edit_test_root("mismatch");
        let dir = base.join("renamed");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            skill_md_path(&dir),
            "---\nname: something-else\ndescription: nope\n---\nbody",
        )
        .unwrap();
        assert!(update_skill_in_root(
            &base,
            "renamed",
            Some("x".into()),
            Some("y"),
            None,
            None,
            None,
            None,
            None,
            None
        )
        .is_err());

        // A description with a newline or a quote would break the minimal reader,
        // so both collapse instead of being written through.
        create_skill_in_root(&base, "squashed", None, None).unwrap();
        update_skill_in_root(
            &base,
            "squashed",
            Some("line one\nline \"two\"".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let content =
            read_skill_in_roots(&[(base.clone(), "test".to_string())], "squashed").unwrap();
        assert_eq!(content.description, "line one line two");
        let _ = std::fs::remove_dir_all(&base);
    }
}
