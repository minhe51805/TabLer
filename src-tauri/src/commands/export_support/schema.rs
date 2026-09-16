//! SQL DDL rendering for exports: CREATE TABLE, column definitions, indexes,
//! and foreign-key statements, plus schema-object SQL normalization.

use super::rows::{qualify_name, quote_identifier_for};
use super::{normalize_referenced_table_name, table_identifier};
use crate::database::models::{
    ColumnDetail, DatabaseType, ForeignKeyInfo, SchemaObjectInfo, TableInfo, TableStructure,
};
use anyhow::Result;
use std::collections::BTreeSet;

pub(crate) fn build_create_table_statement(
    db_type: DatabaseType,
    table: &TableInfo,
    structure: &TableStructure,
    database: Option<&str>,
) -> Result<String> {
    let table_ref = qualify_name(db_type, &table_identifier(table), database)?;
    let mut definitions = structure
        .columns
        .iter()
        .map(|column| build_column_definition(db_type, column))
        .collect::<Result<Vec<_>>>()?;

    let primary_keys = structure
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| quote_identifier_for(db_type, &column.name))
        .collect::<Result<Vec<_>>>()?;

    if !primary_keys.is_empty() {
        definitions.push(format!("  PRIMARY KEY ({})", primary_keys.join(", ")));
    }

    if should_inline_foreign_keys(db_type) {
        for foreign_key in &structure.foreign_keys {
            definitions.push(build_inline_foreign_key_clause(
                db_type,
                table,
                foreign_key,
                database,
            )?);
        }
    }

    let definitions_body = definitions.join(",\n");
    Ok(match db_type {
        // Full-snapshot restore: DROP first (fresh recreate eliminates
        // identity drift from the existing schema — errors 544/8106/1919).
        DatabaseType::MSSQL => format!(
            "DROP TABLE IF EXISTS {table_ref};\nCREATE TABLE {table_ref} (\n{definitions_body}\n);"
        ),
        _ => format!("CREATE TABLE IF NOT EXISTS {table_ref} (\n{definitions_body}\n);"),
    })
}

pub(super) fn build_column_definition(
    db_type: DatabaseType,
    column: &ColumnDetail,
) -> Result<String> {
    let mut column_type = normalized_column_type(column);
    if db_type == DatabaseType::MSSQL {
        column_type = normalize_mssql_column_type(&column_type);
    }
    let mut parts = vec![quote_identifier_for(db_type, &column.name)?, column_type];

    if let Some(default_value) = column
        .default_value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("DEFAULT {default_value}"));
    }

    if column.is_primary_key || !column.is_nullable {
        parts.push("NOT NULL".to_string());
    }

    if let Some(extra) = column
        .extra
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "-")
    {
        parts.push(extra.to_string());
    }

    Ok(format!("  {}", parts.join(" ")))
}

pub(super) fn normalized_column_type(column: &ColumnDetail) -> String {
    column
        .column_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| column.data_type.trim())
        .to_string()
}

/// MSSQL treats a bare `nvarchar`/`varchar` in DDL as length 1, which would
/// silently truncate restored rows. Widen them to 255 in generated dumps —
/// deliberately NOT `max`: key/index columns reject `nvarchar(max)` with
/// error 1919, which used to break checkpoint restore on keyed columns.
pub(super) fn normalize_mssql_column_type(column_type: &str) -> String {
    let trimmed = column_type.trim();
    let lower = trimmed.to_ascii_lowercase();
    if matches!(lower.as_str(), "nvarchar" | "varchar") && !lower.contains('(') {
        format!("{trimmed}(255)")
    } else {
        trimmed.to_string()
    }
}

pub(super) fn should_inline_foreign_keys(db_type: DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::SQLite
            | DatabaseType::DuckDB
            | DatabaseType::LibSQL
            | DatabaseType::CloudflareD1
    )
}

pub(super) fn build_inline_foreign_key_clause(
    db_type: DatabaseType,
    table: &TableInfo,
    foreign_key: &ForeignKeyInfo,
    database: Option<&str>,
) -> Result<String> {
    let mut statement = format!(
        "  FOREIGN KEY ({}) REFERENCES {} ({})",
        quote_identifier_for(db_type, &foreign_key.column)?,
        qualify_name(
            db_type,
            &normalize_referenced_table_name(table, foreign_key),
            database,
        )?,
        quote_identifier_for(db_type, &foreign_key.referenced_column)?,
    );

    if let Some(on_update) = foreign_key
        .on_update
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        statement.push_str(&format!(" ON UPDATE {on_update}"));
    }

    if let Some(on_delete) = foreign_key
        .on_delete
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        statement.push_str(&format!(" ON DELETE {on_delete}"));
    }

    Ok(statement)
}

pub(super) fn build_index_statements(
    db_type: DatabaseType,
    table: &TableInfo,
    structure: &TableStructure,
    database: Option<&str>,
) -> Result<Vec<String>> {
    let table_ref = qualify_name(db_type, &table_identifier(table), database)?;
    let primary_key_columns = structure
        .columns
        .iter()
        .filter(|column| column.is_primary_key)
        .map(|column| column.name.as_str())
        .collect::<BTreeSet<_>>();
    let mut statements = Vec::new();

    for index in &structure.indexes {
        let normalized_name = index.name.trim();
        if normalized_name.is_empty() || normalized_name.eq_ignore_ascii_case("PRIMARY") {
            continue;
        }

        let index_columns = index
            .columns
            .iter()
            .map(|column| column.as_str())
            .collect::<BTreeSet<_>>();
        if !primary_key_columns.is_empty() && index_columns == primary_key_columns {
            continue;
        }

        let columns = index
            .columns
            .iter()
            .map(|column| quote_identifier_for(db_type, column))
            .collect::<Result<Vec<_>>>()?;

        if columns.is_empty() {
            continue;
        }

        statements.push(format!(
            "CREATE {}INDEX {} ON {} ({});",
            if index.is_unique { "UNIQUE " } else { "" },
            quote_identifier_for(db_type, normalized_name)?,
            table_ref,
            columns.join(", ")
        ));
    }

    Ok(statements)
}

pub(super) fn build_foreign_key_statements(
    db_type: DatabaseType,
    table: &TableInfo,
    structure: &TableStructure,
    database: Option<&str>,
) -> Result<Vec<String>> {
    if should_inline_foreign_keys(db_type) || !supports_alter_foreign_keys(db_type) {
        return Ok(Vec::new());
    }

    let table_ref = qualify_name(db_type, &table_identifier(table), database)?;
    let mut statements = Vec::new();

    for foreign_key in &structure.foreign_keys {
        let constraint_name = foreign_key
            .name
            .trim()
            .split('.')
            .next_back()
            .unwrap_or("fk_exported");
        let mut statement = format!(
            "ALTER TABLE {table_ref} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
            quote_identifier_for(db_type, constraint_name)?,
            quote_identifier_for(db_type, &foreign_key.column)?,
            qualify_name(
                db_type,
                &normalize_referenced_table_name(table, foreign_key),
                database,
            )?,
            quote_identifier_for(db_type, &foreign_key.referenced_column)?,
        );

        if let Some(on_update) = foreign_key
            .on_update
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            statement.push_str(&format!(" ON UPDATE {on_update}"));
        }

        if let Some(on_delete) = foreign_key
            .on_delete
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            statement.push_str(&format!(" ON DELETE {on_delete}"));
        }

        statement.push(';');
        statements.push(statement);
    }

    Ok(statements)
}

pub(super) fn supports_alter_foreign_keys(db_type: DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::MySQL
            | DatabaseType::MariaDB
            | DatabaseType::PostgreSQL
            | DatabaseType::CockroachDB
            | DatabaseType::Greenplum
            | DatabaseType::Vertica
            | DatabaseType::MSSQL
    )
}

pub(super) fn normalize_schema_object_sql(
    db_type: DatabaseType,
    object: &SchemaObjectInfo,
    database: Option<&str>,
) -> Result<Option<String>> {
    let qualified_name = match object
        .schema
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(schema) => format!("{schema}.{}", object.name.trim()),
        None => object.name.trim().to_string(),
    };
    let object_ref = qualify_name(db_type, &qualified_name, database)?;
    let raw_definition = object
        .definition
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();

    if raw_definition.is_empty() {
        return Ok(Some(format!("-- {} {}", object.object_type, object_ref)));
    }

    let uppercase_head = raw_definition
        .chars()
        .take(24)
        .collect::<String>()
        .to_ascii_uppercase();

    if uppercase_head.starts_with("CREATE ") {
        return Ok(Some(ensure_trailing_semicolon(raw_definition)));
    }

    if object.object_type.eq_ignore_ascii_case("VIEW") {
        return Ok(Some(format!(
            "CREATE VIEW {object_ref} AS\n{};",
            raw_definition.trim_end_matches(';').trim()
        )));
    }

    Ok(Some(format!(
        "-- {} {}\n{}",
        object.object_type,
        object_ref,
        ensure_trailing_semicolon(raw_definition)
    )))
}

pub(crate) fn ensure_trailing_semicolon(statement: &str) -> String {
    let trimmed = statement.trim();
    if trimmed.ends_with(';') {
        trimmed.to_string()
    } else {
        format!("{trimmed};")
    }
}
