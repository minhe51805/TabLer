mod commands;
mod parse;
mod roots;
mod seed;
mod types;

// Glob re-exports keep the `__cmd__*` symbols `#[tauri::command]` generates
// reachable through `agent_commands::<command>` for `generate_handler!`.
pub use commands::*;
pub use seed::*;

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::path::{Path, PathBuf};

    use super::parse::*;
    use super::roots::*;
    use super::types::*;
    use super::*;

    /// Ephemeral commands root; the seeder is never pointed at the real data dir
    /// in tests, so a test run cannot disturb the developer's own commands.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "tabler-command-{}-{}-{}",
                label,
                std::process::id(),
                nanos
            ));
            std::fs::create_dir_all(&dir).expect("temp root");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, rel: &str, contents: &str) -> PathBuf {
            let path = self.0.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("temp parent");
            }
            std::fs::write(&path, contents).expect("temp write");
            path
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn context(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn command_file(name: &str, extra: &str, body: &str) -> String {
        format!(
            "---\nname: {name}\ndescription: A test command for {name}.\n{extra}---\n\n{body}\n"
        )
    }

    #[test]
    fn every_builtin_command_parses_and_asks_only_for_injectable_context() {
        for (file_name, contents) in BUILTIN_COMMANDS {
            let command = parse_command(
                "fallback",
                contents,
                Path::new(file_name),
                CommandOrigin::Builtin,
            )
            .unwrap_or_else(|error| panic!("{file_name} failed to parse: {error}"));

            assert!(!command.body.trim().is_empty(), "{file_name} has no body");
            assert!(
                command.description.chars().count() > 10,
                "{file_name} needs a real description - it is what the menu shows"
            );
            assert!(
                command.argument_hint.is_some(),
                "{file_name} needs an argument-hint for the composer affordance"
            );
            assert!(
                command.body.contains("$ARGUMENTS"),
                "{file_name} never uses $ARGUMENTS, so its input would be dropped"
            );
            for key in &command.inject {
                assert!(
                    INJECTABLE_CONTEXT_KEYS.contains(&key.as_str()),
                    "{file_name} asks for `{key}`, which is not injectable"
                );
            }
        }
    }

    #[test]
    fn builtin_command_names_are_unique_and_match_their_file_names() {
        let mut seen: HashSet<String> = HashSet::new();
        for (file_name, contents) in BUILTIN_COMMANDS {
            let command = parse_command(
                "fallback",
                contents,
                Path::new(file_name),
                CommandOrigin::Builtin,
            )
            .unwrap_or_else(|error| panic!("{file_name} failed to parse: {error}"));

            assert!(
                seen.insert(command.name.clone()),
                "`{}` is declared twice in the shipped pack",
                command.name
            );
            assert_eq!(
                format!("{}.md", command.name),
                *file_name,
                "the file name must equal the command name, or menu and file disagree"
            );
        }
        assert_eq!(builtin_command_manifest().len(), BUILTIN_COMMANDS.len());
    }

    #[test]
    fn parse_command_line_splits_the_name_from_the_arguments() {
        assert_eq!(
            parse_command_line("/profile orders"),
            Some(("profile".to_string(), "orders".to_string()))
        );
        // A command the menu offered must not fail once typed with a capital.
        assert_eq!(
            parse_command_line("  /Explain  the last query  "),
            Some(("explain".to_string(), "the last query".to_string()))
        );
        assert_eq!(
            parse_command_line("/backup"),
            Some(("backup".to_string(), String::new()))
        );
    }

    #[test]
    fn parse_command_line_ignores_plain_prompts() {
        assert_eq!(parse_command_line("select * from t"), None);
        assert_eq!(parse_command_line("/"), None);
        assert_eq!(parse_command_line("/   "), None);
        assert_eq!(parse_command_line(""), None);
    }
    #[test]
    fn render_command_substitutes_arguments_and_injects_only_requested_keys() {
        let command = parse_command(
            "demo",
            &command_file(
                "demo",
                "inject: current_database, active_tab_sql\n",
                "Profile $ARGUMENTS now.",
            ),
            Path::new("demo.md"),
            CommandOrigin::Global,
        )
        .expect("parses");

        let resolved = render_command(
            &command,
            "orders",
            &context(&[("current_database", "sales"), ("secret_token", "hunter2")]),
        );

        assert!(resolved.prompt.contains("Profile orders now."));
        assert!(resolved.prompt.contains("- current_database: sales"));
        // The security property: a key the command did not ask for never leaks in,
        // even when the host happily supplies it.
        assert!(!resolved.prompt.contains("hunter2"));
        assert_eq!(resolved.missing_context, vec!["active_tab_sql".to_string()]);
        assert!(resolved
            .prompt
            .contains("Context unavailable right now: active_tab_sql"));
    }

    #[test]
    fn render_command_substitutes_the_input_placeholder_alias() {
        // Simple user templates spell the placeholder `{{input}}`; it must
        // expand exactly like `$ARGUMENTS`, including multiple occurrences.
        let command = parse_command(
            "demo",
            &command_file("demo", "", "Summarize {{input}}.\nThen rate {{input}}."),
            Path::new("demo.md"),
            CommandOrigin::Global,
        )
        .expect("parses");

        let resolved = render_command(&command, "  orders  ", &context(&[]));

        assert!(resolved
            .prompt
            .contains("Summarize orders.\nThen rate orders."));
        assert!(!resolved.prompt.contains("{{input}}"));
    }

    #[test]
    fn a_command_that_asks_for_unknown_context_is_refused_at_load() {
        // The inject allowlist is the feature's security boundary: a hostile
        // command dropped into <workspace>/commands/ must not be able to name an
        // arbitrary value and have the host hand it over.
        let root = TempRoot::new("unknown-inject");
        root.write(
            "leak.md",
            &command_file("leak", "inject: env_secrets\n", "Do $ARGUMENTS."),
        );

        let (commands, report) = load_commands_from_roots(&[root.path().to_path_buf()]);

        assert!(commands.is_empty());
        assert_eq!(report.errors.len(), 1);
        assert!(report.errors[0].reason.contains("cannot be injected"));
    }

    #[test]
    fn a_workspace_command_shadows_the_global_one_of_the_same_name() {
        let workspace = TempRoot::new("shadow-workspace");
        let global = TempRoot::new("shadow-global");
        workspace.write("demo.md", &command_file("demo", "", "Workspace body."));
        global.write("demo.md", &command_file("demo", "", "Global body."));

        let (commands, report) = load_commands_from_roots(&[
            workspace.path().to_path_buf(),
            global.path().to_path_buf(),
        ]);

        assert_eq!(commands.len(), 1, "the shadowed command must not be listed");
        assert_eq!(commands[0].origin, CommandOrigin::Workspace);
        assert!(commands[0].body.contains("Workspace body."));
        assert_eq!(report.skipped, 1, "the shadowed file is still reported");
    }

    #[test]
    fn a_broken_command_file_is_reported_and_does_not_hide_the_good_ones() {
        let root = TempRoot::new("broken");
        root.write("good.md", &command_file("good", "", "Do $ARGUMENTS."));
        // No description: parse_command refuses it.
        root.write("bad.md", "---\nname: bad\n---\n\nno description\n");

        let (commands, report) = load_commands_from_roots(&[root.path().to_path_buf()]);

        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "good");
        assert_eq!(report.loaded, 1);
        assert_eq!(report.errors.len(), 1);
        assert!(report.errors[0].reason.contains("no description"));
    }

    #[test]
    fn an_unknown_command_reason_names_the_broken_file_instead_of_denying_it_exists() {
        let report = CommandLoadReport {
            loaded: 0,
            skipped: 0,
            errors: vec![CommandLoadError {
                path: "C:/ws/commands/typo.md".to_string(),
                reason: "command `typo` has no description".to_string(),
            }],
        };

        let reason = unknown_command_reason("typo", &[], &report);

        assert!(reason.contains("no command named `/typo` is installed"));
        // "not installed" alone would be a lie: the file is right there, broken.
        assert!(reason.contains("typo.md"));
        assert!(reason.contains("no description"));
    }

    #[test]
    fn a_non_ascii_typed_name_suggests_and_never_panics() {
        // Guards the UTF-8 boundary: the typed name is user input, so a byte slice
        // for the "did you mean" prefix would panic here.
        let reason = unknown_command_reason("профиль", &[], &CommandLoadReport::default());
        assert!(reason.contains("no command named"));
    }

    #[test]
    fn an_oversized_command_body_is_truncated_to_the_documented_ceiling() {
        let body = "x".repeat(MAX_COMMAND_BODY_CHARS + 500);
        let command = parse_command(
            "huge",
            &command_file("huge", "", &body),
            Path::new("huge.md"),
            CommandOrigin::Workspace,
        )
        .expect("parses");

        assert_eq!(command.body.chars().count(), MAX_COMMAND_BODY_CHARS);
    }
    #[test]
    fn seeding_installs_the_pack_and_is_idempotent() {
        let root = TempRoot::new("seed-install");

        let first = seed_commands_into_root(root.path(), false).expect("first seed");
        assert_eq!(first.installed, BUILTIN_COMMANDS.len());
        assert_eq!(first.refreshed, 0);
        assert_eq!(first.unchanged, 0);
        for (file_name, contents) in BUILTIN_COMMANDS {
            let installed =
                std::fs::read_to_string(root.path().join(file_name)).expect("installed");
            assert_eq!(installed, *contents, "{file_name} must be byte-identical");
        }

        let second = seed_commands_into_root(root.path(), false).expect("second seed");
        assert_eq!(second.installed, 0);
        assert_eq!(second.unchanged, BUILTIN_COMMANDS.len());
        assert_eq!(second.user_modified, 0);
    }

    #[test]
    fn seeding_never_clobbers_a_command_the_user_edited() {
        let root = TempRoot::new("seed-edit");
        seed_commands_into_root(root.path(), false).expect("seed");

        let edited = command_file("explain", "", "My own explain body: $ARGUMENTS");
        std::fs::write(root.path().join("explain.md"), &edited).expect("edit");

        let report = seed_commands_into_root(root.path(), false).expect("re-seed");

        assert_eq!(report.user_modified, 1);
        assert_eq!(report.unchanged, BUILTIN_COMMANDS.len() - 1);
        assert_eq!(
            std::fs::read_to_string(root.path().join("explain.md")).expect("read back"),
            edited,
            "an edited command must survive every later seed"
        );
    }

    #[test]
    fn seeding_restores_a_builtin_the_user_deleted() {
        let root = TempRoot::new("seed-restore");
        seed_commands_into_root(root.path(), false).expect("seed");
        std::fs::remove_file(root.path().join("profile.md")).expect("delete");

        let report = seed_commands_into_root(root.path(), false).expect("re-seed");

        // A missing file holds no user intent, so it is healed rather than
        // reported as userModified - the same asymmetry as the rules seeder.
        assert_eq!(report.installed, 1);
        assert!(root.path().join("profile.md").exists());
    }

    #[test]
    fn reset_force_restores_an_edited_builtin_only_when_asked() {
        let root = TempRoot::new("seed-force");
        seed_commands_into_root(root.path(), false).expect("seed");
        std::fs::write(
            root.path().join("plan.md"),
            command_file("plan", "", "Mine: $ARGUMENTS"),
        )
        .expect("edit");

        let report = seed_commands_into_root(root.path(), true).expect("force seed");

        assert_eq!(report.refreshed, 1);
        let restored = std::fs::read_to_string(root.path().join("plan.md")).expect("read back");
        let shipped = BUILTIN_COMMANDS
            .iter()
            .find(|(file_name, _)| *file_name == "plan.md")
            .map(|(_, contents)| *contents)
            .expect("shipped plan");
        assert_eq!(restored, shipped);
    }

    #[test]
    fn a_seeded_command_is_recognised_as_a_builtin_on_reload() {
        let root = TempRoot::new("seed-origin");
        seed_commands_into_root(root.path(), false).expect("seed");

        // The data-dir root is `roots.last()`, which is how an untouched built-in
        // is told apart from a command the user wrote by hand.
        let (commands, report) = load_commands_from_roots(&[root.path().to_path_buf()]);

        assert_eq!(commands.len(), BUILTIN_COMMANDS.len());
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(commands
            .iter()
            .all(|command| command.origin == CommandOrigin::Builtin));
    }
}
