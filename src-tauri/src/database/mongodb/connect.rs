use super::{strip_database_prefix, MongoDbDriver};
use crate::database::models::*;
use crate::database::query_cancel::QueryCancelRegistry;
use anyhow::{anyhow, Context, Result};
use mongodb::bson::{doc, Document};
use mongodb::options::ClientOptions;
use mongodb::{Client, Collection, Database};
use std::sync::atomic::AtomicBool;
use std::sync::RwLock as StdRwLock;
use tokio::sync::RwLock;

impl MongoDbDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let connection_uri = Self::build_connection_uri(config)?;
        let mut options = ClientOptions::parse(&connection_uri)
            .await
            .context("Failed to parse MongoDB connection options")?;
        options.app_name = Some("TableR".to_string());

        let client = Client::with_options(options).context("Failed to create MongoDB client")?;
        client
            .database("admin")
            .run_command(doc! { "ping": 1 })
            .await
            .context("MongoDB ping failed during connect")?;

        let current_db = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                config
                    .additional_fields
                    .get("auth_source")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "admin".to_string());

        Ok(Self {
            client,
            current_db: RwLock::new(current_db),
            current_op_all_users: AtomicBool::new(true),
            // Probed lazily on the first transaction attempt: sessions and
            // transactions need a replica set or mongos, which `hello` reveals.
            transactions_supported: StdRwLock::new(None),
            cancel_registry: StdRwLock::new(QueryCancelRegistry::new()),
        })
    }

    pub(super) fn build_connection_uri(config: &ConnectionConfig) -> Result<String> {
        let raw_host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("MongoDB host is required")?;

        // Detect Atlas/SRV targets: either an explicit `mongodb+srv://` scheme
        // pasted into the host field or an official Atlas hostname. SRV is
        // required to discover the cluster (plain mongodb:// only reaches one
        // node and Atlas rejects it), and SRV connections are always TLS.
        // `.mongodb.net` is reserved for Atlas so the bare-hostname heuristic
        // cannot misfire on self-hosted servers. Escape hatch for the rare
        // non-SRV Atlas target (e.g. PrivateLink endpoints, whose hostnames
        // still end in .mongodb.net but have no SRV records): prefix the host
        // with `mongodb://` to disable SRV discovery, or pick "Direct" in the
        // form's Connection discovery field (`srv_mode`).
        let mut is_srv = false;
        let mut explicit_srv_scheme = false;
        let mut host = raw_host.to_string();
        if let Some(rest) = host.strip_prefix("mongodb+srv://") {
            is_srv = true;
            explicit_srv_scheme = true;
            host = rest.to_string();
        } else if let Some(rest) = host.strip_prefix("mongodb://") {
            host = rest.to_string();
        } else if host
            .split('/')
            .next()
            .is_some_and(|host_part| host_part.trim_end_matches('.').ends_with(".mongodb.net"))
        {
            is_srv = true;
        }
        // UI override (Connection form "Connection discovery" field):
        // "force" always uses SRV, "direct" never does — except when the user
        // explicitly pasted a mongodb+srv:// scheme, which IS the request.
        match config
            .additional_fields
            .get("srv_mode")
            .map(String::as_str)
            .map(str::trim)
        {
            Some("force") => is_srv = true,
            Some("direct") if !explicit_srv_scheme => is_srv = false,
            _ => {}
        }
        // A full connection URL pasted into the host field: keep only the
        // host portion, dropping any embedded `user:pass@` credentials (the
        // structured username/password fields are authoritative). An embedded
        // path is ignored in favor of config.database.
        host = host.split('/').next().unwrap_or_default().to_string();
        if let Some((_, without_credentials)) = host.rsplit_once('@') {
            host = without_credentials.to_string();
        }
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host
        };

        let username = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let password = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        if username.is_none() && password.is_some() {
            return Err(anyhow!(
                "MongoDB password authentication requires a username"
            ));
        }

        let mut uri = String::from(if is_srv {
            "mongodb+srv://"
        } else {
            "mongodb://"
        });
        if let Some(username) = username {
            uri.push_str(&Self::percent_encode(username));
            if let Some(password) = password {
                uri.push(':');
                uri.push_str(&Self::percent_encode(password));
            }
            uri.push('@');
        }
        uri.push_str(&host);
        // SRV records already encode the port — appending one is invalid.
        if !is_srv {
            if let Some(port) = config.port.filter(|value| *value > 0) {
                uri.push(':');
                uri.push_str(&port.to_string());
            }
        }

        let database = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("admin");
        uri.push('/');
        uri.push_str(database);

        let mut query_params = Vec::new();
        if let Some(auth_source) = config
            .additional_fields
            .get("auth_source")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            query_params.push(format!("authSource={}", Self::percent_encode(auth_source)));
        }
        if let Some(replica_set) = config
            .additional_fields
            .get("replica_set")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            query_params.push(format!("replicaSet={}", Self::percent_encode(replica_set)));
        }
        // Atlas users live in the admin database, but the URI path carries the
        // target database — without an explicit authSource the server would
        // look the user up there and fail. Only defaulted for SRV targets;
        // explicit auth_source always wins.
        if is_srv
            && username.is_some()
            && !query_params
                .iter()
                .any(|param| param.starts_with("authSource="))
        {
            query_params.push("authSource=admin".to_string());
        }
        query_params.push(format!(
            "tls={}",
            // SRV targets are Atlas, which rejects plain connections.
            if is_srv || config.use_ssl {
                "true"
            } else {
                "false"
            }
        ));

        if !query_params.is_empty() {
            uri.push('?');
            uri.push_str(&query_params.join("&"));
        }

        Ok(uri)
    }

    pub(super) fn percent_encode(value: &str) -> String {
        value
            .bytes()
            .flat_map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    vec![byte as char].into_iter().collect::<Vec<_>>()
                }
                _ => format!("%{byte:02X}").chars().collect(),
            })
            .collect()
    }

    pub(super) async fn database_name(&self, database: Option<&str>) -> String {
        if let Some(database) = database.map(str::trim).filter(|value| !value.is_empty()) {
            return database.to_string();
        }
        self.current_db.read().await.clone()
    }
    pub(super) async fn database_handle(&self, database: Option<&str>) -> Database {
        let name = self.database_name(database).await;
        self.client.database(&name)
    }

    pub(super) async fn collection_handle(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<Collection<Document>> {
        let table_name = table.trim();
        if table_name.is_empty() {
            return Err(anyhow!("MongoDB collection name cannot be empty"));
        }
        // SQL-style callers pass schema-qualified names (`<db>.<collection>`)
        // because MongoDB's list_tables reports the database as the schema —
        // the Explorer then opens tabs like "avtech_operations.users", which
        // reads as a nonexistent dotted collection and silently yields zero
        // rows. Strip the resolved-database prefix; a real collection sharing
        // that exact dotted name is pathological enough to accept.
        let db_name = self.database_name(database).await;
        let collection_name = strip_database_prefix(table_name, &db_name);
        Ok(self
            .database_handle(database)
            .await
            .collection(collection_name))
    }
}
