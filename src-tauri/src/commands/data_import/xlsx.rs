//! XLSX/ODS import: workbook opening plus typed cell/date formatting and
//! header + row alignment. calamine loads a sheet fully into memory.

use calamine::{open_workbook_auto, Data, Reader};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxPreview {
    pub file_name: String,
    /// Absolute path so `import_xlsx` and sheet-switching can re-read the file.
    pub file_path: String,
    pub sheet_names: Vec<String>,
    /// The sheet this preview was built from.
    pub sheet: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub total_rows_truncated: bool,
}

/// Formats an Excel serial datetime/duration without pulling in chrono, using
/// calamine's own component splitter.
pub(super) fn format_excel_datetime(value: &calamine::ExcelDateTime) -> String {
    if value.is_duration() {
        let total_seconds = (value.as_f64() * 86_400.0).round() as i64;
        let hours = total_seconds / 3600;
        let minutes = (total_seconds % 3600) / 60;
        let seconds = total_seconds % 60;
        return format!("{hours}:{minutes:02}:{seconds:02}");
    }
    let (year, month, day, hour, minute, second, milli) = value.to_ymd_hms_milli();
    if hour == 0 && minute == 0 && second == 0 && milli == 0 {
        format!("{year:04}-{month:02}-{day:02}")
    } else if milli == 0 {
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
    } else {
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{milli:03}")
    }
}

/// Renders one worksheet cell as an import string, converting typed cells
/// (numbers, booleans, dates) to a stable textual form. Error cells import as
/// empty so a `#DIV/0!` never lands in a data column.
pub(super) fn xlsx_cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(text) => text.clone(),
        Data::Bool(flag) => flag.to_string(),
        Data::Int(number) => number.to_string(),
        Data::Float(number) => number.to_string(),
        Data::DateTime(datetime) => format_excel_datetime(datetime),
        Data::DateTimeIso(text) => text.clone(),
        Data::DurationIso(text) => text.clone(),
        Data::Error(_) => String::new(),
    }
}

/// Derives header column names from the first worksheet row; blank cells get a
/// positional `column_N` fallback like the CSV path.
pub(super) fn xlsx_header_columns(header: &[Data]) -> Vec<String> {
    header
        .iter()
        .enumerate()
        .map(|(index, cell)| {
            let name = xlsx_cell_to_string(cell);
            if name.trim().is_empty() {
                format!("column_{}", index + 1)
            } else {
                name
            }
        })
        .collect()
}

/// Converts a worksheet row to positional strings, padding/truncating to the
/// header width so every row lines up with the mapped columns.
pub(super) fn align_row_to_len(row: &[Data], len: usize) -> Vec<String> {
    (0..len)
        .map(|index| row.get(index).map(xlsx_cell_to_string).unwrap_or_default())
        .collect()
}

/// Opens the workbook, returning the sheet-name list plus the requested (or
/// first) sheet's range. calamine loads the whole sheet into memory.
pub(super) fn open_xlsx_sheet(
    path: &std::path::Path,
    sheet: Option<&str>,
) -> Result<(Vec<String>, String, calamine::Range<Data>), String> {
    let mut workbook =
        open_workbook_auto(path).map_err(|error| format!("Failed to open spreadsheet: {error}"))?;
    let sheet_names = workbook.sheet_names().to_owned();
    if sheet_names.is_empty() {
        return Err("The selected spreadsheet has no sheets.".to_string());
    }
    let active = match sheet {
        Some(name) if sheet_names.iter().any(|candidate| candidate == name) => name.to_string(),
        Some(name) => return Err(format!("Sheet '{name}' was not found in the spreadsheet.")),
        None => sheet_names[0].clone(),
    };
    let range = workbook
        .worksheet_range(&active)
        .map_err(|error| format!("Failed to read sheet '{active}': {error}"))?;
    Ok((sheet_names, active, range))
}
