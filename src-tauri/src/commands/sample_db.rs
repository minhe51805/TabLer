//! First-run convenience: generate a small, self-contained SQLite demo
//! database ("chinook-lite") inside the app data directory and register it as
//! a saved connection so the empty launcher can offer a one-click workspace.

use super::connection_support::run_blocking_storage_task;
use crate::database::driver::DatabaseDriver;
use crate::database::models::{ConnectionConfig, DatabaseType};
use crate::database::sqlite::SqliteDriver;
use crate::storage::connection_storage::ConnectionStorage;
use crate::utils::paths::resolve_data_dir;
use tauri::State;
use uuid::Uuid;

const SAMPLE_DB_FILE: &str = "sample-chinook-lite.db";
const SAMPLE_CONNECTION_NAME: &str = "Sample (SQLite)";

/// Create (or reuse) the bundled sample SQLite database and persist it as a
/// saved connection. Returns the saved `ConnectionConfig` so the frontend can
/// update its list and connect immediately.
#[tauri::command]
pub async fn create_sample_database(
    conn_storage: State<'_, ConnectionStorage>,
) -> Result<ConnectionConfig, String> {
    let file_path = resolve_data_dir()
        .map_err(|error| format!("Could not resolve the app data directory: {error}"))?
        .join(SAMPLE_DB_FILE);
    let file_path_string = file_path.to_string_lossy().to_string();

    let driver = SqliteDriver::connect(&file_path_string)
        .await
        .map_err(|error| format!("Could not create the sample database file: {error}"))?;

    // Always close the pool before returning, even when seeding fails.
    let seed_result = seed_sample_database(&driver).await;
    let close_result = driver.disconnect().await;
    seed_result?;
    close_result.map_err(|error| format!("Sample database did not close cleanly: {error}"))?;

    let config = ConnectionConfig {
        id: Uuid::new_v4().to_string(),
        name: SAMPLE_CONNECTION_NAME.to_string(),
        db_type: DatabaseType::SQLite,
        file_path: Some(file_path_string),
        ..ConnectionConfig::default()
    };

    let storage = conn_storage.inner().clone();
    let config_to_save = config.clone();
    run_blocking_storage_task(move || {
        storage
            .save_connection(&config_to_save)
            .map_err(|error| error.to_string())
    })
    .await?;

    Ok(config)
}

/// Apply the demo schema and insert the generated rows. Re-running against an
/// already-seeded file is a no-op so the card stays idempotent.
async fn seed_sample_database(driver: &SqliteDriver) -> Result<(), String> {
    for statement in SAMPLE_SCHEMA {
        driver
            .execute_query(statement)
            .await
            .map_err(|error| format!("Sample schema setup failed: {error}"))?;
    }

    let count = driver
        .execute_query("SELECT COUNT(*) FROM customers")
        .await
        .map_err(|error| format!("Could not inspect the sample database: {error}"))?;
    let already_seeded = count
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
        > 0;
    if already_seeded {
        return Ok(());
    }

    for statement in build_seed_statements() {
        driver
            .execute_query(&statement)
            .await
            .map_err(|error| format!("Sample data seeding failed: {error}"))?;
    }
    Ok(())
}

const SAMPLE_SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        city TEXT NOT NULL,
        country TEXT NOT NULL,
        created_at TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        sku TEXT NOT NULL UNIQUE,
        price REAL NOT NULL,
        stock INTEGER NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        status TEXT NOT NULL,
        order_date TEXT NOT NULL,
        total REAL NOT NULL DEFAULT 0
    )",
    "CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity INTEGER NOT NULL,
        unit_price REAL NOT NULL
    )",
    "CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)",
    "CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)",
];

const FIRST_NAMES: &[&str] = &[
    "Ana", "Bruno", "Carla", "Dmitri", "Elena", "Farid", "Grace", "Hiro", "Ingrid", "Jamal",
    "Kira", "Liam", "Maya", "Noah", "Olga", "Pedro", "Quinn", "Rosa", "Sam", "Tara",
];
const LAST_NAMES: &[&str] = &[
    "Nguyen", "Smith", "Garcia", "Kim", "Muller", "Rossi", "Dubois", "Silva", "Novak", "Tanaka",
    "Haddad", "Ivanov", "Costa", "Weber", "Lopez", "Kumar", "Santos", "Berg", "Fischer", "Ali",
];
const PRODUCT_WORDS: &[&str] = &[
    "Keyboard",
    "Mouse",
    "Monitor",
    "Headset",
    "Cable",
    "Dock",
    "Stand",
    "Speaker",
    "Webcam",
    "Hub",
    "Charger",
    "Case",
    "Drive",
    "Router",
    "Tablet",
    "Lamp",
    "Microphone",
    "Adapter",
    "Battery",
    "Console",
];
const PRODUCT_VARIANTS: &[&str] = &["Pro", "Lite", "Max", "Mini", "Air"];
const CITIES: &[&str] = &[
    "Berlin", "Hanoi", "Lisbon", "Toronto", "Osaka", "Nairobi", "Austin", "Prague", "Seoul", "Lima",
];
const COUNTRIES: &[&str] = &[
    "Germany",
    "Vietnam",
    "Portugal",
    "Canada",
    "Japan",
    "Kenya",
    "USA",
    "Czechia",
    "South Korea",
    "Peru",
];
const ORDER_STATUSES: &[&str] = &["paid", "shipped", "pending", "refunded"];

const CUSTOMER_COUNT: usize = 50;
const PRODUCT_COUNT: usize = 30;
const ORDER_COUNT: usize = 70;
const ORDER_ITEM_COUNT: usize = 140;

fn product_price(index: usize) -> f64 {
    // Deterministic price spread between roughly 10 and 250.
    9.99 + ((index * 13) % 240) as f64 + (index % 10) as f64 * 0.5
}

/// Deterministic demo rows (~290 total): enough for joins, aggregates and
/// pagination demos without shipping a real dataset.
fn build_seed_statements() -> Vec<String> {
    let mut statements = Vec::with_capacity(5);

    let customers: Vec<String> = (0..CUSTOMER_COUNT)
        .map(|i| {
            let first = FIRST_NAMES[i % FIRST_NAMES.len()];
            let last = LAST_NAMES[(i * 7) % LAST_NAMES.len()];
            let email = format!(
                "{}.{}{}@example.com",
                first.to_lowercase(),
                last.to_lowercase(),
                i + 1
            );
            let city = CITIES[i % CITIES.len()];
            let country = COUNTRIES[i % COUNTRIES.len()];
            let created = format!("2024-{:02}-{:02}", (i % 12) + 1, (i % 28) + 1);
            format!("('{first} {last}', '{email}', '{city}', '{country}', '{created}')")
        })
        .collect();
    statements.push(format!(
        "INSERT INTO customers (name, email, city, country, created_at) VALUES {}",
        customers.join(", ")
    ));

    let products: Vec<String> = (0..PRODUCT_COUNT)
        .map(|i| {
            let name = format!(
                "{} {}",
                PRODUCT_WORDS[i % PRODUCT_WORDS.len()],
                PRODUCT_VARIANTS[i % PRODUCT_VARIANTS.len()]
            );
            format!(
                "('{name}', 'SKU-{:04}', {:.2}, {})",
                i + 1,
                product_price(i),
                5 + (i * 17) % 120
            )
        })
        .collect();
    statements.push(format!(
        "INSERT INTO products (name, sku, price, stock) VALUES {}",
        products.join(", ")
    ));

    let orders: Vec<String> = (0..ORDER_COUNT)
        .map(|i| {
            let customer_id = (i * 7) % CUSTOMER_COUNT + 1;
            let status = ORDER_STATUSES[i % ORDER_STATUSES.len()];
            let date = format!("2025-{:02}-{:02}", (i % 12) + 1, (i % 28) + 1);
            format!("({customer_id}, '{status}', '{date}', 0)")
        })
        .collect();
    statements.push(format!(
        "INSERT INTO orders (customer_id, status, order_date, total) VALUES {}",
        orders.join(", ")
    ));

    let items: Vec<String> = (0..ORDER_ITEM_COUNT)
        .map(|i| {
            let order_id = i % ORDER_COUNT + 1;
            let product_id = (i * 11) % PRODUCT_COUNT + 1;
            let quantity = i % 4 + 1;
            format!(
                "({order_id}, {product_id}, {quantity}, {:.2})",
                product_price(product_id - 1)
            )
        })
        .collect();
    statements.push(format!(
        "INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES {}",
        items.join(", ")
    ));

    statements.push(
        "UPDATE orders SET total = (
            SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0)
            FROM order_items oi WHERE oi.order_id = orders.id
        )"
        .to_string(),
    );

    statements
}
