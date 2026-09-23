use super::csv::{
    decode_csv_cell, detect_delimiter, looks_like_header, sample_and_count, strip_text_bom,
};
use super::insert::{build_insert_batch, ImportColumnMapping};
use super::json::{
    align_object, collect_keys, json_shape_from_prefix, json_value_to_cell, parse_json_object_line,
    JsonShape,
};
use super::xlsx::{align_row_to_len, xlsx_cell_to_string, xlsx_header_columns};
use crate::database::models::DatabaseType;
use calamine::{Data, ExcelDateTime, ExcelDateTimeType};
use std::collections::HashSet;
use std::io::Cursor;

#[test]
fn detects_common_delimiters() {
    assert_eq!(detect_delimiter("a,b,c\n1,2,3"), b',');
    assert_eq!(detect_delimiter("a;b;c\n1;2;3"), b';');
    assert_eq!(detect_delimiter("a\tb\tc\n1\t2\t3"), b'\t');
    assert_eq!(detect_delimiter("\"a,b\"\tc\n"), b'\t');
    assert_eq!(detect_delimiter("a|b|c\n1|2|3"), b'|');
}

#[test]
fn delimiter_sniffing_uses_every_line_not_just_the_first() {
    // A stray ';' inside one quoted cell must not outvote the real delimiter.
    let text = "a|b\n\"x;y\"|z\n1|2\n";
    assert_eq!(detect_delimiter(text), b'|');
    // First line has no separators at all (single-column header); the data
    // lines still identify the delimiter.
    let text = "title\n1,2,3\n4,5,6\n";
    assert_eq!(detect_delimiter(text), b',');
}

#[test]
fn strip_text_bom_skips_utf8_and_rejects_utf16() {
    assert_eq!(strip_text_bom(b"\xEF\xBB\xBFa,b").unwrap(), b"a,b");
    assert_eq!(strip_text_bom(b"a,b").unwrap(), b"a,b");
    assert!(strip_text_bom(b"\xFF\xFEa\x00").is_err());
    assert!(strip_text_bom(b"\xFE\xFF\x00a").is_err());
}

#[test]
fn decode_csv_cell_round_trips_null_marker() {
    assert_eq!(decode_csv_cell("\\N"), None);
    assert_eq!(decode_csv_cell("\\\\N"), Some("\\N".to_string()));
    assert_eq!(decode_csv_cell("\\\\\\N"), Some("\\\\N".to_string()));
    assert_eq!(decode_csv_cell(""), Some(String::new()));
    assert_eq!(decode_csv_cell("plain"), Some("plain".to_string()));
    assert_eq!(
        decode_csv_cell("C:\\new\\path"),
        Some("C:\\new\\path".to_string())
    );
}

#[test]
fn header_detection_keeps_data_first_rows() {
    // All-numeric first row is data, not a header.
    assert!(!looks_like_header(
        &["1".to_string(), "2".to_string(), "3".to_string()],
        Some(&["4".to_string(), "5".to_string(), "6".to_string()])
    ));
    // Text first row over typed data rows is a header.
    assert!(looks_like_header(
        &["id".to_string(), "name".to_string()],
        Some(&["1".to_string(), "alice".to_string()])
    ));
}

#[test]
fn insert_batches_use_bound_placeholders_and_quoted_identifiers() {
    let record = vec![Some("alice".to_string()), Some("42".to_string())];
    let mappings = vec![
        ImportColumnMapping {
            source_index: 0,
            target_column: "name".to_string(),
        },
        ImportColumnMapping {
            source_index: 1,
            target_column: "age".to_string(),
        },
    ];
    let (sql, parameters) = build_insert_batch(
        DatabaseType::PostgreSQL,
        "\"public\".\"users\"",
        &mappings,
        &[record],
        0,
    )
    .unwrap();
    assert_eq!(
        sql,
        "INSERT INTO \"public\".\"users\" (\"name\", \"age\") VALUES (:r0c0, :r0c1)"
    );
    assert_eq!(parameters[0].name, "r0c0");
    assert_eq!(parameters[0].value, serde_json::json!("alice"));
}

#[test]
fn mappings_pick_cells_by_source_index() {
    // Column order in the mapping must follow source_index, not list order.
    let record = vec![Some("42".to_string()), Some("alice".to_string())];
    let mappings = vec![
        ImportColumnMapping {
            source_index: 1,
            target_column: "name".to_string(),
        },
        ImportColumnMapping {
            source_index: 0,
            target_column: "age".to_string(),
        },
    ];
    let (sql, parameters) = build_insert_batch(
        DatabaseType::PostgreSQL,
        "\"users\"",
        &mappings,
        &[record],
        0,
    )
    .unwrap();
    assert!(sql.contains("(\"name\", \"age\")"));
    assert_eq!(parameters[0].value, serde_json::json!("alice"));
    assert_eq!(parameters[1].value, serde_json::json!("42"));
}

fn reader_from(text: &str) -> csv::Reader<Cursor<&str>> {
    csv::ReaderBuilder::new()
        .delimiter(b',')
        .has_headers(false)
        .flexible(true)
        .from_reader(Cursor::new(text))
}

#[test]
fn sample_and_count_streams_without_loading_every_row() {
    let mut text = String::from("id,name\n");
    for index in 0..50 {
        text.push_str(&format!("{index},row{index}\n"));
    }
    let (rows, total, truncated) =
        sample_and_count(reader_from(&text), true, 5, 1_000_000).unwrap();
    assert_eq!(rows.len(), 5);
    assert_eq!(rows[0], vec!["0", "row0"]);
    assert_eq!(total, 50);
    assert!(!truncated);
}

#[test]
fn sample_and_count_reports_truncation_at_the_cap() {
    let mut text = String::from("id\n");
    for index in 0..10 {
        text.push_str(&format!("{index}\n"));
    }
    let (rows, total, truncated) = sample_and_count(reader_from(&text), true, 3, 5).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(total, 5, "count stops at the cap");
    assert!(truncated);
}

#[test]
fn sample_and_count_without_header_counts_every_line() {
    let (rows, total, truncated) =
        sample_and_count(reader_from("a,b\nc,d\n"), false, 10, 1_000_000).unwrap();
    assert_eq!(total, 2);
    assert_eq!(rows.len(), 2);
    assert!(!truncated);
}

#[test]
fn json_shape_detects_array_ndjson_and_rejects_scalars() {
    assert_eq!(
        json_shape_from_prefix("  [ {} ]").unwrap(),
        JsonShape::Array
    );
    assert_eq!(
        json_shape_from_prefix("\n{\"a\":1}\n").unwrap(),
        JsonShape::Ndjson
    );
    assert_eq!(
        json_shape_from_prefix("\u{feff}[").unwrap(),
        JsonShape::Array
    );
    assert!(json_shape_from_prefix("   ").is_err());
    assert!(json_shape_from_prefix("42").is_err());
}

#[test]
fn json_values_render_as_import_cells() {
    assert_eq!(json_value_to_cell(&serde_json::json!(null)), "");
    assert_eq!(json_value_to_cell(&serde_json::json!("hi")), "hi");
    assert_eq!(json_value_to_cell(&serde_json::json!(true)), "true");
    assert_eq!(json_value_to_cell(&serde_json::json!(42)), "42");
    assert_eq!(
        json_value_to_cell(&serde_json::json!({"k": 1})),
        "{\"k\":1}"
    );
}

#[test]
fn collect_keys_preserves_first_seen_order_across_objects() {
    let mut seen = HashSet::new();
    let mut columns = Vec::new();
    let first = parse_json_object_line("{\"b\":1,\"a\":2}").unwrap();
    let second = parse_json_object_line("{\"a\":9,\"c\":3}").unwrap();
    collect_keys(&first, &mut seen, &mut columns);
    collect_keys(&second, &mut seen, &mut columns);
    assert_eq!(columns, vec!["b", "a", "c"]);
}

#[test]
fn align_object_maps_by_column_and_blanks_missing_keys() {
    let object = parse_json_object_line("{\"name\":\"alice\",\"age\":30}").unwrap();
    let columns = vec!["name".to_string(), "age".to_string(), "city".to_string()];
    assert_eq!(align_object(&columns, &object), vec!["alice", "30", ""]);
}

#[test]
fn parse_json_object_line_rejects_non_objects() {
    assert!(parse_json_object_line("[1,2,3]").is_err());
    assert!(parse_json_object_line("not json").is_err());
}

#[test]
fn xlsx_cells_render_typed_values_including_dates() {
    assert_eq!(xlsx_cell_to_string(&Data::Empty), "");
    assert_eq!(xlsx_cell_to_string(&Data::String("hi".to_string())), "hi");
    assert_eq!(xlsx_cell_to_string(&Data::Bool(true)), "true");
    assert_eq!(xlsx_cell_to_string(&Data::Int(42)), "42");
    assert_eq!(xlsx_cell_to_string(&Data::Float(42.5)), "42.5");
    // 45943.0 is the Excel 1900-epoch serial for 2025-10-13 (midnight).
    let datetime = ExcelDateTime::new(45943.0, ExcelDateTimeType::DateTime, false);
    assert_eq!(xlsx_cell_to_string(&Data::DateTime(datetime)), "2025-10-13");
}

#[test]
fn xlsx_header_uses_positional_fallback_for_blanks() {
    let header = vec![Data::String("name".to_string()), Data::Empty, Data::Int(3)];
    assert_eq!(xlsx_header_columns(&header), vec!["name", "column_2", "3"]);
}

#[test]
fn xlsx_rows_align_and_pad_to_header_width() {
    let row = vec![Data::String("a".to_string()), Data::Int(2)];
    assert_eq!(align_row_to_len(&row, 3), vec!["a", "2", ""]);
}
