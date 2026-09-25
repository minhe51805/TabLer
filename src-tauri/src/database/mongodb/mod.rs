use crate::database::query_cancel::QueryCancelRegistry;
use mongodb::bson::Document;
use mongodb::Client;
use std::sync::atomic::AtomicBool;
use std::sync::RwLock as StdRwLock;
use tokio::sync::RwLock;

pub struct MongoDbDriver {
    client: Client,
    current_db: RwLock<String>,
    /// Whether this deployment accepts `$currentOp` with `allUsers: true`.
    /// Shared MongoDB Atlas tiers reject that argument (error 8000
    /// "arg=allUsers isn't allowed in this atlas tier"), so once we see the
    /// rejection we cache it and sample only the current user's operations
    /// instead of issuing a doomed cluster-wide request on every poll.
    current_op_all_users: AtomicBool,
    /// Lazily-detected multi-document transaction support, resolved on the
    /// first transaction attempt via the `hello` response: replica set members
    /// report `setName` and mongos routers report `msg: "isdbgrid"`, while a
    /// standalone mongod reports neither. `None` means "not probed yet".
    transactions_supported: StdRwLock<Option<bool>>,
    /// request_id → running-operation scope so `cancel_query_request` can
    /// find the tagged op via `$currentOp` and kill it with `killOp`.
    cancel_registry: StdRwLock<QueryCancelRegistry>,
}

#[derive(Debug)]
pub(super) enum MongoQueryCommand {
    RunCommand(Document),
    Find {
        collection: String,
        filter: Document,
        projection: Option<Document>,
        sort: Option<Document>,
        limit: Option<i64>,
        skip: Option<u64>,
    },
    FindOne {
        collection: String,
        filter: Document,
    },
    Aggregate {
        collection: String,
        pipeline: Vec<Document>,
    },
    CountDocuments {
        collection: String,
        filter: Document,
    },
    InsertOne {
        collection: String,
        document: Document,
    },
    InsertMany {
        collection: String,
        documents: Vec<Document>,
    },
    UpdateOne {
        collection: String,
        filter: Document,
        update: MongoUpdatePayload,
    },
    UpdateMany {
        collection: String,
        filter: Document,
        update: MongoUpdatePayload,
    },
    DeleteOne {
        collection: String,
        filter: Document,
    },
    DeleteMany {
        collection: String,
        filter: Document,
    },
}

#[derive(Debug)]
pub(super) enum MongoUpdatePayload {
    Document(Document),
    Pipeline(Vec<Document>),
}

/// Strips a `<database>.` prefix from a table reference when it names the
/// currently resolved database. MongoDB's list_tables reports the database as
/// the schema, so SQL-style callers (the Explorer tab opener, the AI tooling)
/// hand over names like "avtech_operations.users" — a dotted collection name
/// that does not exist and silently reads as empty. A genuine collection
/// named exactly "<db>.<something>" collides only in pathological cases.
fn strip_database_prefix<'a>(table: &'a str, db_name: &str) -> &'a str {
    let db_prefix = format!("{db_name}.");
    table.strip_prefix(db_prefix.as_str()).unwrap_or(table)
}

mod connect;

mod driver_ops;

mod profiler;

#[cfg(test)]
mod tests {
    use super::{strip_database_prefix, MongoDbDriver, MongoQueryCommand, MongoUpdatePayload};
    use mongodb::bson::Bson;

    #[test]
    fn parses_run_command_with_relaxed_json() {
        let parsed = MongoDbDriver::parse_command("db.runCommand({ ping: 1 })").unwrap();
        match parsed {
            MongoQueryCommand::RunCommand(command) => {
                assert!(matches!(
                    command.get("ping"),
                    Some(Bson::Int32(1)) | Some(Bson::Int64(1))
                ));
            }
            _ => panic!("expected run command"),
        }
    }

    #[test]
    fn parses_find_command_with_get_collection() {
        let parsed =
            MongoDbDriver::parse_command("db.getCollection('users').find({ status: 'active' })")
                .unwrap();
        match parsed {
            MongoQueryCommand::Find {
                collection, filter, ..
            } => {
                assert_eq!(collection, "users");
                assert_eq!(filter.get_str("status").unwrap(), "active");
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn parses_update_many_pipeline() {
        let parsed = MongoDbDriver::parse_command(
            "db.users.updateMany({ role: 'user' }, [{ $set: { active: true } }])",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::UpdateMany { update, .. } => match update {
                MongoUpdatePayload::Pipeline(stages) => {
                    assert_eq!(stages.len(), 1);
                    assert!(matches!(stages[0].get("$set"), Some(Bson::Document(_))));
                }
                _ => panic!("expected pipeline update"),
            },
            _ => panic!("expected updateMany command"),
        }
    }
    #[test]
    fn parses_insert_many_seed_script_with_leading_comment() {
        // Mirrors the AI agent's propose_seed_data output: a `//` header line
        // above a multi-line db.<collection>.insertMany([...]); script. Before
        // the comment strip this failed with "must start with db.".
        let script = concat!(
            "// Seed data proposal generated by the AI agent — review before running.\n",
            "db.teams.insertMany([\n",
            "  {\"name\":\"Core Engineering\",\"__v\":0},\n",
            "  {\"name\":\"Product Design\",\"__v\":0}\n",
            "]);"
        );
        let parsed = MongoDbDriver::parse_command(script).unwrap();
        match parsed {
            MongoQueryCommand::InsertMany {
                collection,
                documents,
            } => {
                assert_eq!(collection, "teams");
                assert_eq!(documents.len(), 2);
                assert_eq!(documents[0].get_str("name").unwrap(), "Core Engineering");
            }
            _ => panic!("expected insertMany command"),
        }
    }

    #[test]
    fn keeps_comment_like_sequences_inside_strings() {
        // A `//` inside a quoted value (a URL) must not be treated as a comment.
        let parsed = MongoDbDriver::parse_command(
            "db.sites.insertOne({ \"url\": \"https://example.com/a//b\" })",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::InsertOne { document, .. } => {
                assert_eq!(document.get_str("url").unwrap(), "https://example.com/a//b");
            }
            _ => panic!("expected insertOne command"),
        }
    }

    #[test]
    fn strips_inline_block_comments() {
        let parsed = MongoDbDriver::parse_command(
            "db.users./* pick method */ insertOne({ /* first */ \"name\": \"A\" })",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::InsertOne {
                collection,
                document,
            } => {
                assert_eq!(collection, "users");
                assert_eq!(document.get_str("name").unwrap(), "A");
            }
            _ => panic!("expected insertOne command"),
        }
    }

    #[test]
    fn translates_select_star_from_collection() {
        let parsed = MongoDbDriver::parse_command("Select * From users").unwrap();
        match parsed {
            MongoQueryCommand::Find {
                collection,
                filter,
                projection,
                sort,
                limit,
                skip,
            } => {
                assert_eq!(collection, "users");
                assert!(filter.is_empty());
                assert!(projection.is_none());
                assert!(sort.is_none());
                assert!(limit.is_none());
                assert!(skip.is_none());
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn parses_find_with_projection_and_cursor_chains() {
        let parsed = MongoDbDriver::parse_command(
            "db.media_assets.find({ resourceType: \"image\", width: { $gt: 1000 } }, \
             { publicId: 1, url: 1 }).sort({ width: -1 }).limit(50).skip(10)",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::Find {
                collection,
                filter,
                projection,
                sort,
                limit,
                skip,
            } => {
                assert_eq!(collection, "media_assets");
                assert_eq!(filter.get_str("resourceType").unwrap(), "image");
                assert!(matches!(
                    filter.get_document("width").unwrap().get("$gt"),
                    Some(Bson::Int32(1000)) | Some(Bson::Int64(1000))
                ));
                let projection = projection.unwrap();
                assert!(matches!(
                    projection.get("publicId"),
                    Some(Bson::Int32(1)) | Some(Bson::Int64(1))
                ));
                assert!(matches!(
                    sort.unwrap().get("width"),
                    Some(Bson::Int32(-1)) | Some(Bson::Int64(-1))
                ));
                assert_eq!(limit, Some(50));
                assert_eq!(skip, Some(10));
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn rejects_unknown_find_chain() {
        let error = MongoDbDriver::parse_command("db.users.find({}).limt(5)").unwrap_err();
        assert!(error.to_string().contains("Unsupported find() chain"));
    }

    #[test]
    fn rejects_trailing_chain_on_non_find_methods() {
        let error = MongoDbDriver::parse_command("db.users.findOne({}).limit(5)").unwrap_err();
        assert!(error.to_string().contains("Unexpected trailing characters"));
    }

    #[test]
    fn unwraps_markdown_sql_fence_and_ignores_trailing_blocks() {
        // Pasting an AI answer into a query tab carries the ```sql fence plus
        // a second resolved-example block; only the first block runs.
        let parsed = MongoDbDriver::parse_command(
            "```sql\nSELECT * FROM media_assets WHERE resourceType = 'image' AND width > 1000\n```\n\
             ```sql\nSELECT * FROM media_assets WHERE status = TRUE\n```",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::Find {
                collection, filter, ..
            } => {
                assert_eq!(collection, "media_assets");
                let conditions = filter.get_array("$and").unwrap();
                assert_eq!(
                    conditions[0]
                        .as_document()
                        .unwrap()
                        .get_str("resourceType")
                        .unwrap(),
                    "image"
                );
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn translates_select_columns_where_order_limit() {
        let parsed = MongoDbDriver::parse_command(
            "select name, profile.email from users where age >= 18 and status = 'active' \
             order by name desc limit 10 offset 5",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::Find {
                collection,
                filter,
                projection,
                sort,
                limit,
                skip,
            } => {
                assert_eq!(collection, "users");

                let conditions = filter.get_array("$and").unwrap();
                assert_eq!(conditions.len(), 2);
                let age_condition = conditions[0].as_document().unwrap();
                assert_eq!(
                    age_condition
                        .get_document("age")
                        .unwrap()
                        .get_i64("$gte")
                        .unwrap(),
                    18
                );
                let status_condition = conditions[1].as_document().unwrap();
                assert_eq!(status_condition.get_str("status").unwrap(), "active");

                let projection = projection.unwrap();
                assert_eq!(projection.get_i32("name").unwrap(), 1);
                assert_eq!(projection.get_i32("profile.email").unwrap(), 1);
                assert_eq!(projection.get_i32("_id").unwrap(), 0);

                assert_eq!(sort.unwrap().get_i32("name").unwrap(), -1);
                assert_eq!(limit, Some(10));
                assert_eq!(skip, Some(5));
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn translates_select_count_star() {
        let parsed = MongoDbDriver::parse_command("SELECT COUNT(*) FROM users").unwrap();
        match parsed {
            MongoQueryCommand::CountDocuments { collection, filter } => {
                assert_eq!(collection, "users");
                assert!(filter.is_empty());
            }
            _ => panic!("expected count command"),
        }
    }

    #[test]
    fn translates_where_operators() {
        let parsed = MongoDbDriver::parse_command(
            "select * from users where role in ('admin', 'editor') and deleted_at is null \
             and name like 'jo%' and age not between 30 and 40",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::Find { filter, .. } => {
                let conditions = filter.get_array("$and").unwrap();
                assert_eq!(conditions.len(), 4);

                let roles = conditions[0]
                    .as_document()
                    .unwrap()
                    .get_document("role")
                    .unwrap()
                    .get_array("$in")
                    .unwrap();
                assert_eq!(roles.len(), 2);
                assert_eq!(roles[0].as_str().unwrap(), "admin");

                let deleted_at = conditions[1].as_document().unwrap();
                assert_eq!(deleted_at.get("deleted_at").unwrap(), &Bson::Null);

                let name = conditions[2]
                    .as_document()
                    .unwrap()
                    .get_document("name")
                    .unwrap();
                assert_eq!(name.get_str("$regex").unwrap(), "^jo.*$");
                assert_eq!(name.get_str("$options").unwrap(), "i");

                let age = conditions[3]
                    .as_document()
                    .unwrap()
                    .get_document("age")
                    .unwrap();
                assert!(age.get_document("$not").is_ok());
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn translates_group_by_with_count() {
        let parsed = MongoDbDriver::parse_command(
            "select status, count(*) as total from users group by status order by total desc limit 5",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::Aggregate {
                collection,
                pipeline,
            } => {
                assert_eq!(collection, "users");
                assert_eq!(pipeline.len(), 4);

                let group = pipeline[0].get_document("$group").unwrap();
                assert_eq!(
                    group
                        .get_document("_id")
                        .unwrap()
                        .get_str("status")
                        .unwrap(),
                    "$status"
                );
                assert_eq!(
                    group
                        .get_document("total")
                        .unwrap()
                        .get_i32("$sum")
                        .unwrap(),
                    1
                );

                let project = pipeline[1].get_document("$project").unwrap();
                assert_eq!(project.get_str("status").unwrap(), "$_id.status");
                assert_eq!(project.get_i32("total").unwrap(), 1);
                assert_eq!(project.get_i32("_id").unwrap(), 0);

                assert_eq!(
                    pipeline[2]
                        .get_document("$sort")
                        .unwrap()
                        .get_i32("total")
                        .unwrap(),
                    -1
                );
                assert_eq!(pipeline[3].get_i64("$limit").unwrap(), 5);
            }
            _ => panic!("expected aggregate command"),
        }
    }

    #[test]
    fn translates_sum_with_where() {
        let parsed =
            MongoDbDriver::parse_command("select sum(amount) from orders where user_id = 7")
                .unwrap();
        match parsed {
            MongoQueryCommand::Aggregate { pipeline, .. } => {
                assert_eq!(pipeline.len(), 2);
                let match_stage = pipeline[0].get_document("$match").unwrap();
                assert_eq!(match_stage.get_i64("user_id").unwrap(), 7);
                let group = pipeline[1].get_document("$group").unwrap();
                assert_eq!(group.get("_id"), Some(&Bson::Null));
                assert_eq!(
                    group
                        .get_document("sum_amount")
                        .unwrap()
                        .get_str("$sum")
                        .unwrap(),
                    "$amount"
                );
            }
            _ => panic!("expected aggregate command"),
        }
    }

    #[test]
    fn translates_alias_projection() {
        let parsed =
            MongoDbDriver::parse_command("select name as full_name from users limit 3").unwrap();
        match parsed {
            MongoQueryCommand::Aggregate { pipeline, .. } => {
                assert_eq!(pipeline.len(), 2);
                let project = pipeline[0].get_document("$project").unwrap();
                assert_eq!(project.get_str("full_name").unwrap(), "$name");
                assert_eq!(project.get_i32("_id").unwrap(), 0);
                assert_eq!(pipeline[1].get_i64("$limit").unwrap(), 3);
            }
            _ => panic!("expected aggregate command"),
        }
    }

    #[test]
    fn translates_distinct_columns() {
        let parsed = MongoDbDriver::parse_command("select distinct city from users").unwrap();
        match parsed {
            MongoQueryCommand::Aggregate { pipeline, .. } => {
                assert_eq!(pipeline.len(), 2);
                let group = pipeline[0].get_document("$group").unwrap();
                assert_eq!(
                    group.get_document("_id").unwrap().get_str("city").unwrap(),
                    "$city"
                );
                let project = pipeline[1].get_document("$project").unwrap();
                assert_eq!(project.get_str("city").unwrap(), "$_id.city");
                assert_eq!(project.get_i32("_id").unwrap(), 0);
            }
            _ => panic!("expected aggregate command"),
        }
    }

    #[test]
    fn translates_object_id_equality() {
        let parsed = MongoDbDriver::parse_command(
            "select * from users where _id = '507f1f77bcf86cd799439011'",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::Find { filter, .. } => {
                assert!(matches!(filter.get("_id"), Some(Bson::ObjectId(_))));
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn translates_or_and_not() {
        let parsed = MongoDbDriver::parse_command(
            "select * from users where (role = 'admin' or role = 'editor') and not banned = true",
        )
        .unwrap();
        match parsed {
            MongoQueryCommand::Find { filter, .. } => {
                let conditions = filter.get_array("$and").unwrap();
                assert_eq!(conditions.len(), 2);
                let or_clause = conditions[0].as_document().unwrap();
                assert_eq!(or_clause.get_array("$or").unwrap().len(), 2);
                let nor = conditions[1]
                    .as_document()
                    .unwrap()
                    .get_array("$nor")
                    .unwrap();
                let banned = nor[0].as_document().unwrap();
                assert_eq!(banned.get("banned").unwrap(), &Bson::Boolean(true));
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn sql_writes_get_shell_hints() {
        for (sql, hint) in [
            ("insert into users (name) values ('x')", "insertOne"),
            ("update users set name = 'x' where _id = 1", "updateOne"),
            ("delete from users where _id = 1", "deleteOne"),
            ("create table users (id int)", "createCollection"),
        ] {
            let error = MongoDbDriver::parse_command(sql).unwrap_err().to_string();
            assert!(
                error.contains(hint),
                "error for '{sql}' should mention '{hint}': {error}"
            );
        }
    }

    #[test]
    fn shell_find_keeps_default_options() {
        let parsed = MongoDbDriver::parse_command("db.users.find({ age: { $gte: 18 } })").unwrap();
        match parsed {
            MongoQueryCommand::Find {
                collection,
                projection,
                sort,
                limit,
                skip,
                ..
            } => {
                assert_eq!(collection, "users");
                assert!(projection.is_none());
                assert!(sort.is_none());
                assert!(limit.is_none());
                assert!(skip.is_none());
            }
            _ => panic!("expected find command"),
        }
    }

    #[test]
    fn non_sql_non_shell_input_reports_shell_requirement() {
        let error = MongoDbDriver::parse_command("show dbs")
            .unwrap_err()
            .to_string();
        assert!(error.contains("must start with db."));
    }

    #[test]
    fn broken_select_reports_translation_error() {
        let error = MongoDbDriver::parse_command("select from where")
            .unwrap_err()
            .to_string();
        assert!(error.contains("could not be translated"));
    }

    #[test]
    fn multiple_sql_statements_are_rejected() {
        assert!(MongoDbDriver::parse_command("select * from users; select * from teams").is_err());
    }

    fn config_with(
        host: &str,
        username: Option<&str>,
        password: Option<&str>,
        database: Option<&str>,
    ) -> crate::database::models::ConnectionConfig {
        crate::database::models::ConnectionConfig {
            host: Some(host.to_string()),
            username: username.map(str::to_string),
            password: password.map(str::to_string),
            database: database.map(str::to_string),
            ..crate::database::models::ConnectionConfig::default()
        }
    }

    #[test]
    fn atlas_host_builds_srv_uri_with_admin_auth_source() {
        let config = config_with(
            "cluster0.67gwy4b.mongodb.net",
            Some("avtech_operations_db_user"),
            Some("secret"),
            Some("avtech_operations"),
        );
        let uri = MongoDbDriver::build_connection_uri(&config).unwrap();
        assert!(uri.starts_with("mongodb+srv://"));
        assert!(uri.contains("authSource=admin"));
        assert!(uri.contains("tls=true"));
        assert!(!uri.contains(":27017"), "SRV URIs must not carry a port");
        assert!(
            uri.contains("/avtech_operations?"),
            "target db must be the URI path: {uri}"
        );
    }

    #[test]
    fn srv_mode_field_overrides_the_hostname_heuristic() {
        // PrivateLink endpoints end in .mongodb.net but have no SRV records:
        // the form's "Direct" choice must beat the hostname heuristic.
        let mut config = config_with(
            "pl-0-us-east1-abc123.mongodb.net:1024",
            Some("u"),
            Some("p"),
            Some("db"),
        );
        config
            .additional_fields
            .insert("srv_mode".to_string(), "direct".to_string());
        let uri = MongoDbDriver::build_connection_uri(&config).unwrap();
        // The port-carrying host gets bracketed by the URI builder.
        assert!(
            uri.starts_with("mongodb://u:p@[pl-0-us-east1-abc123.mongodb.net:1024]/db"),
            "{uri}"
        );
        assert!(
            !uri.contains("tls=true"),
            "direct mode keeps use_ssl in charge: {uri}"
        );

        // "Force" flips a plain host into SRV.
        config
            .additional_fields
            .insert("srv_mode".to_string(), "force".to_string());
        config.host = Some("mongobox.internal".to_string());
        config.port = None;
        let uri = MongoDbDriver::build_connection_uri(&config).unwrap();
        assert!(
            uri.starts_with("mongodb+srv://") && uri.contains("mongobox.internal"),
            "{uri}"
        );
    }

    #[test]
    fn pasted_connection_url_host_is_reduced_to_the_host_part() {
        let config = config_with(
            "avtech_operations_db_user:pw@cluster0.67gwy4b.mongodb.net/avtech_operations?retryWrites=true",
            None,
            None,
            None,
        );
        let uri = MongoDbDriver::build_connection_uri(&config).unwrap();
        assert!(uri.starts_with("mongodb+srv://"));
        assert!(uri.contains("cluster0.67gwy4b.mongodb.net"));
        assert!(!uri.contains("avtech_operations_db_user"));
        assert!(!uri.contains("retryWrites"));
    }

    #[test]
    fn local_host_keeps_plain_scheme_and_port() {
        let config = crate::database::models::ConnectionConfig {
            host: Some("localhost".to_string()),
            port: Some(27017),
            username: Some("dev".to_string()),
            password: Some("dev".to_string()),
            database: Some("localdb".to_string()),
            ..crate::database::models::ConnectionConfig::default()
        };
        let uri = MongoDbDriver::build_connection_uri(&config).unwrap();
        assert!(uri.starts_with("mongodb://"));
        assert!(uri.contains("localhost:27017"));
        assert!(!uri.contains("authSource=admin"));
        assert!(uri.contains("tls=false"));
    }

    /// Live diagnostic against a real Atlas cluster. Run manually:
    /// `cargo test --lib mongo_live_probe -- --ignored --nocapture`
    /// Requires TABLER_TEST_MONGO_URI (full mongodb+srv connection string).
    #[tokio::test]
    #[ignore = "requires TABLER_TEST_MONGO_URI"]
    async fn mongo_live_probe() {
        use crate::database::driver::DatabaseDriver;
        // CI runs with --include-ignored on machines without a live cluster:
        // skip quietly instead of panicking when the URI is not configured.
        let uri = match std::env::var("TABLER_TEST_MONGO_URI") {
            Ok(uri) => uri,
            Err(_) => {
                eprintln!("skipping mongo_live_probe: TABLER_TEST_MONGO_URI is not set");
                return;
            }
        };
        // The embedded credentials must go through the structured fields (the
        // builder strips them from the host on purpose). Without them the
        // connection is anonymous — MongoDB's ping succeeds unauthenticated,
        // which masks the missing credentials until the first real command.
        let authority = uri
            .split("//")
            .nth(1)
            .and_then(|rest| rest.split('@').next())
            .unwrap_or_default();
        let (username, password) = match authority.split_once(':') {
            Some((user, pass)) => (Some(user.to_string()), Some(pass.to_string())),
            None => (None, None),
        };
        let config = crate::database::models::ConnectionConfig {
            id: "mongo-probe".to_string(),
            name: "mongo-probe".to_string(),
            db_type: crate::database::models::DatabaseType::MongoDB,
            host: Some(uri),
            port: None,
            username,
            password,
            database: Some("avtech_operations".to_string()),
            file_path: None,
            use_ssl: true,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields: std::collections::HashMap::new(),
            startup_commands: None,
            pre_connect_script: None,
            query_timeout_seconds: None,
            read_only: false,
            ssh_config: None,
        };
        let driver = MongoDbDriver::connect(&config).await.expect("connect");
        // Note: Atlas users scoped to a single database lack listDatabases on
        // admin — that call panics the probe, so it stays removed here.
        let tables = driver
            .list_tables(Some("avtech_operations"))
            .await
            .expect("list_tables");
        println!(
            "[probe] avtech_operations collections: {:?}",
            tables.iter().map(|t| &t.name).collect::<Vec<_>>()
        );

        for collection in ["users", "projects", "teams"] {
            match driver
                .count_rows(collection, Some("avtech_operations"))
                .await
            {
                Ok(count) => println!("[probe] {collection}: count={count}"),
                Err(error) => println!("[probe] {collection}: count ERROR: {error:#}"),
            }
            match driver
                .get_table_data(
                    collection,
                    Some("avtech_operations"),
                    0,
                    10,
                    None,
                    None,
                    None,
                )
                .await
            {
                Ok(data) => println!(
                    "[probe] {collection}: fetched={} columns={:?} first_row={:?}",
                    data.rows.len(),
                    data.columns.iter().map(|c| &c.name).collect::<Vec<_>>(),
                    data.rows.first().map(|row| row.first()),
                ),
                Err(error) => println!("[probe] {collection}: fetch ERROR: {error:#}"),
            }
        }
    }

    #[test]
    fn strips_schema_qualified_collection_prefix() {
        // The Explorer opens tabs as "<db>.<collection>" because MongoDB's
        // list_tables reports the database as the schema.
        assert_eq!(
            strip_database_prefix("avtech_operations.users", "avtech_operations"),
            "users"
        );
        // Already-bare names pass through untouched.
        assert_eq!(strip_database_prefix("users", "avtech_operations"), "users");
        // A different database prefix is NOT stripped.
        assert_eq!(
            strip_database_prefix("other_db.users", "avtech_operations"),
            "other_db.users"
        );
        // The bare database name itself is left alone.
        assert_eq!(
            strip_database_prefix("avtech_operations", "avtech_operations"),
            "avtech_operations"
        );
    }

    #[test]
    fn hello_probe_detects_transaction_capable_topologies() {
        use mongodb::bson::doc;

        // Replica set member: `setName` is present.
        assert!(MongoDbDriver::hello_supports_transactions(&doc! {
            "setName": "rs0",
            "isWritablePrimary": true,
        }));
        // mongos router: no setName, but `msg: "isdbgrid"`.
        assert!(MongoDbDriver::hello_supports_transactions(&doc! {
            "msg": "isdbgrid",
            "isWritablePrimary": true,
        }));
        // Standalone mongod: neither marker → transactions unavailable.
        assert!(!MongoDbDriver::hello_supports_transactions(&doc! {
            "isWritablePrimary": true,
            "maxWireVersion": 17,
        }));
        // A stray `msg` value must not be mistaken for a router.
        assert!(!MongoDbDriver::hello_supports_transactions(&doc! {
            "msg": "something else",
        }));
    }

    #[test]
    fn strips_explain_prefixes() {
        assert_eq!(
            MongoDbDriver::strip_explain_prefix("EXPLAIN SELECT * FROM users"),
            Some(("SELECT * FROM users", false))
        );
        assert_eq!(
            MongoDbDriver::strip_explain_prefix("explain analyze select 1"),
            Some(("select 1", true))
        );
        assert_eq!(
            MongoDbDriver::strip_explain_prefix("EXPLAIN (ANALYZE, COSTS) SELECT 1"),
            Some(("SELECT 1", true))
        );
        assert_eq!(
            MongoDbDriver::strip_explain_prefix("-- note\nEXPLAIN SELECT 1"),
            Some(("SELECT 1", false))
        );
        assert_eq!(
            MongoDbDriver::strip_explain_prefix("// shell note\nEXPLAIN db.users.find({})"),
            Some(("db.users.find({})", false))
        );
        assert_eq!(
            MongoDbDriver::strip_explain_prefix("/* c */ EXPLAIN SELECT 1"),
            Some(("SELECT 1", false))
        );
        assert_eq!(
            MongoDbDriver::strip_explain_prefix("db.users.find({})"),
            None
        );
        assert_eq!(
            MongoDbDriver::strip_explain_prefix("EXPLAINS SELECT 1"),
            None
        );
        assert_eq!(MongoDbDriver::strip_explain_prefix("EXPLAIN"), None);
    }

    #[test]
    fn explain_wraps_translated_select_as_find() {
        use mongodb::bson::doc;

        let inner = MongoDbDriver::parse_command(
            "SELECT name FROM users WHERE status = 'active' ORDER BY name LIMIT 5",
        )
        .unwrap();
        let command = MongoDbDriver::explainable_command_document(inner, false).unwrap();
        assert_eq!(command.get_str("verbosity").unwrap(), "executionStats");
        let explain = command.get_document("explain").unwrap();
        assert_eq!(explain.get_str("find").unwrap(), "users");
        assert_eq!(
            explain.get_document("filter").unwrap(),
            &doc! { "status": "active" }
        );
        assert_eq!(explain.get_i64("limit").unwrap(), 5);
        assert_eq!(explain.get_document("sort").unwrap(), &doc! { "name": 1 });
    }

    #[test]
    fn explain_wraps_aggregate_pipeline_with_cursor() {
        let inner =
            MongoDbDriver::parse_command("SELECT status, COUNT(*) AS n FROM users GROUP BY status")
                .unwrap();
        let command = MongoDbDriver::explainable_command_document(inner, true).unwrap();
        assert_eq!(command.get_str("verbosity").unwrap(), "allPlansExecution");
        let explain = command.get_document("explain").unwrap();
        assert_eq!(explain.get_str("aggregate").unwrap(), "users");
        assert!(!explain.get_array("pipeline").unwrap().is_empty());
        // The aggregate command requires a cursor field even under explain.
        assert!(explain.get_document("cursor").unwrap().is_empty());
    }

    #[test]
    fn explain_wraps_count_and_write_commands() {
        use mongodb::bson::doc;

        let count = MongoDbDriver::explainable_command_document(
            MongoDbDriver::parse_command("SELECT COUNT(*) FROM users WHERE active = true").unwrap(),
            false,
        )
        .unwrap();
        let explain = count.get_document("explain").unwrap();
        assert_eq!(explain.get_str("count").unwrap(), "users");
        assert_eq!(
            explain.get_document("query").unwrap(),
            &doc! { "active": true }
        );

        let update = MongoDbDriver::explainable_command_document(
            MongoDbDriver::parse_command(
                "db.users.updateMany({ role: 'user' }, { $set: { active: true } })",
            )
            .unwrap(),
            false,
        )
        .unwrap();
        let explain = update.get_document("explain").unwrap();
        assert_eq!(explain.get_str("update").unwrap(), "users");
        let spec = &explain.get_array("updates").unwrap()[0];
        assert!(spec.as_document().unwrap().get_bool("multi").unwrap());

        let delete = MongoDbDriver::explainable_command_document(
            MongoDbDriver::parse_command("db.users.deleteOne({ name: 'A' })").unwrap(),
            false,
        )
        .unwrap();
        let explain = delete.get_document("explain").unwrap();
        assert_eq!(explain.get_str("delete").unwrap(), "users");
        let spec = &explain.get_array("deletes").unwrap()[0];
        assert_eq!(spec.as_document().unwrap().get_i32("limit").unwrap(), 1);
    }

    #[test]
    fn explain_runs_existing_explain_command_verbatim() {
        let inner = MongoDbDriver::parse_command(
            "db.runCommand({ explain: { find: 'users', filter: {} }, verbosity: 'queryPlanner' })",
        )
        .unwrap();
        let command = MongoDbDriver::explainable_command_document(inner, false).unwrap();
        // Already an explain command — returned as-is, not nested.
        assert!(command.get_document("explain").is_ok());
        assert_eq!(command.get_str("verbosity").unwrap(), "queryPlanner");
    }
}
