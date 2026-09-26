use super::MssqlDriver;
use crate::database::models::{ColumnInfo, QueryResult};
use chrono::{Duration as ChronoDuration, NaiveDate};
use tiberius::{ColumnData, Row};

impl MssqlDriver {
    /// Days since 0001-01-01 (TDS `date` type) to ISO date string.
    pub(super) fn ms_date_to_string(days: u32) -> String {
        let base = NaiveDate::from_ymd_opt(1, 1, 1).expect("valid base date");
        (base + ChronoDuration::days(i64::from(days)))
            .format("%Y-%m-%d")
            .to_string()
    }

    /// TDS `time` increments (10^-scale seconds since midnight) to ISO time.
    pub(super) fn ms_time_to_string(increments: u64, scale: u8) -> String {
        let seconds = increments as f64 / 10f64.powi(i32::from(scale));
        let whole = seconds.floor() as u64;
        let fraction = seconds - whole as f64;
        let hour = (whole / 3600) % 24;
        let minute = (whole / 60) % 60;
        let second = whole % 60;
        if fraction > 0.0 {
            let nanos = (fraction * 10_000_000.0).round() as u64;
            format!("{hour:02}:{minute:02}:{second:02}.{nanos:07}")
        } else {
            format!("{hour:02}:{minute:02}:{second:02}")
        }
    }

    /// TDS `datetime`/`smalldatetime` (days since 1900-01-01 plus second
    /// fragments of `fragments_per_second` per second) to ISO string.
    pub(super) fn ms_datetime_to_string(
        days: i32,
        fragments: u32,
        fragments_per_second: f64,
    ) -> String {
        let base = NaiveDate::from_ymd_opt(1900, 1, 1)
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .expect("valid base datetime");
        let seconds = f64::from(fragments) / fragments_per_second;
        let whole_seconds = seconds.floor() as i64;
        let date_time =
            base + ChronoDuration::days(i64::from(days)) + ChronoDuration::seconds(whole_seconds);
        let fraction = seconds - whole_seconds as f64;
        if fraction > 0.0 {
            let millis = (fraction * 1000.0).round() as u64;
            format!("{}.{:03}", date_time.format("%Y-%m-%d %H:%M:%S"), millis)
        } else {
            date_time.format("%Y-%m-%d %H:%M:%S").to_string()
        }
    }

    pub(super) fn ms_cell_to_json(value: &ColumnData<'static>) -> serde_json::Value {
        match value {
            ColumnData::U8(Some(v)) => serde_json::Value::from(*v),
            ColumnData::I16(Some(v)) => serde_json::Value::from(*v),
            ColumnData::I32(Some(v)) => serde_json::Value::from(*v),
            ColumnData::I64(Some(v)) => serde_json::Value::from(*v),
            ColumnData::F32(Some(v)) => serde_json::Value::from(*v as f64),
            ColumnData::F64(Some(v)) => serde_json::Value::from(*v),
            ColumnData::Bit(Some(v)) => serde_json::Value::from(*v),
            ColumnData::Guid(Some(v)) => serde_json::Value::String(v.to_string()),
            ColumnData::String(Some(v)) => serde_json::Value::String(v.to_string()),
            ColumnData::Binary(Some(v)) => serde_json::Value::String(
                v.iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
            ),
            ColumnData::Numeric(Some(v)) => serde_json::Value::String(v.to_string()),
            ColumnData::DateTime(Some(v)) => serde_json::Value::String(
                Self::ms_datetime_to_string(v.days(), v.seconds_fragments(), 300.0),
            ),
            ColumnData::SmallDateTime(Some(v)) => {
                // `seconds_fragments` counts MINUTES for smalldatetime, so the
                // fragment rate is 1/60 s⁻¹ (not 60 s⁻¹ like datetime's 300).
                serde_json::Value::String(Self::ms_datetime_to_string(
                    i32::from(v.days()),
                    u32::from(v.seconds_fragments()),
                    1.0 / 60.0,
                ))
            }
            ColumnData::Time(Some(v)) => {
                serde_json::Value::String(Self::ms_time_to_string(v.increments(), v.scale()))
            }
            ColumnData::Date(Some(v)) => {
                serde_json::Value::String(Self::ms_date_to_string(v.days()))
            }
            ColumnData::DateTime2(Some(v)) => {
                let time = v.time();
                serde_json::Value::String(format!(
                    "{} {}",
                    Self::ms_date_to_string(v.date().days()),
                    Self::ms_time_to_string(time.increments(), time.scale())
                ))
            }
            ColumnData::DateTimeOffset(Some(v)) => {
                let dt2 = v.datetime2();
                let time = dt2.time();
                let offset = v.offset();
                let sign = if offset < 0 { '-' } else { '+' };
                let abs = offset.unsigned_abs();
                serde_json::Value::String(format!(
                    "{} {}{}{:02}:{:02}",
                    Self::ms_date_to_string(dt2.date().days()),
                    Self::ms_time_to_string(time.increments(), time.scale()),
                    sign,
                    abs / 60,
                    abs % 60
                ))
            }
            _ => serde_json::Value::Null,
        }
    }

    pub(super) fn ms_column_type(value: &ColumnData<'static>) -> String {
        match value {
            ColumnData::U8(_) => "tinyint",
            ColumnData::I16(_) => "smallint",
            ColumnData::I32(_) => "int",
            ColumnData::I64(_) => "bigint",
            ColumnData::F32(_) => "real",
            ColumnData::F64(_) => "float",
            ColumnData::Bit(_) => "bit",
            ColumnData::Guid(_) => "uniqueidentifier",
            ColumnData::String(_) => "nvarchar",
            ColumnData::Binary(_) => "varbinary",
            ColumnData::Numeric(_) => "numeric",
            ColumnData::DateTime(_) => "datetime",
            ColumnData::SmallDateTime(_) => "smalldatetime",
            ColumnData::Time(_) => "time",
            ColumnData::Date(_) => "date",
            ColumnData::DateTime2(_) => "datetime2",
            ColumnData::DateTimeOffset(_) => "datetimeoffset",
            _ => "unknown",
        }
        .to_string()
    }

    pub(super) fn row_value_string(row: &Row, index: usize) -> Option<String> {
        row.cells().nth(index).and_then(|(_, value)| match value {
            ColumnData::String(Some(v)) => Some(v.to_string()),
            ColumnData::Guid(Some(v)) => Some(v.to_string()),
            ColumnData::Numeric(Some(v)) => Some(v.to_string()),
            ColumnData::I16(Some(v)) => Some(v.to_string()),
            ColumnData::I32(Some(v)) => Some(v.to_string()),
            ColumnData::I64(Some(v)) => Some(v.to_string()),
            ColumnData::U8(Some(v)) => Some(v.to_string()),
            ColumnData::F32(Some(v)) => Some(v.to_string()),
            ColumnData::F64(Some(v)) => Some(v.to_string()),
            ColumnData::Bit(Some(v)) => Some(v.to_string()),
            _ => None,
        })
    }

    pub(super) fn row_value_i64(row: &Row, index: usize) -> Option<i64> {
        row.cells().nth(index).and_then(|(_, value)| match value {
            ColumnData::I16(Some(v)) => Some((*v).into()),
            ColumnData::I32(Some(v)) => Some((*v).into()),
            ColumnData::I64(Some(v)) => Some(*v),
            ColumnData::U8(Some(v)) => Some((*v).into()),
            ColumnData::String(Some(v)) => v.parse::<i64>().ok(),
            _ => None,
        })
    }

    pub(super) fn build_result_from_rows(
        rows: &[Row],
        elapsed: u128,
        query: String,
        affected_rows: u64,
        sandboxed: bool,
        truncated: bool,
    ) -> QueryResult {
        let columns = rows
            .first()
            .map(|first| {
                first
                    .cells()
                    .map(|(column, value)| ColumnInfo {
                        name: column.name().to_string(),
                        data_type: Self::ms_column_type(value),
                        is_nullable: true,
                        is_primary_key: false,
                        max_length: None,
                        default_value: None,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let result_rows = rows
            .iter()
            .map(|row| {
                row.cells()
                    .map(|(_, value)| Self::ms_cell_to_json(value))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        QueryResult {
            columns,
            rows: result_rows,
            affected_rows,
            execution_time_ms: elapsed,
            query,
            sandboxed,
            truncated,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::MssqlDriver;
    use serde_json::json;
    use std::borrow::Cow;
    use tiberius::time::{Date, DateTime, DateTime2, DateTimeOffset, SmallDateTime, Time};
    use tiberius::ColumnData;

    #[test]
    fn ms_date_renders_iso_calendar_dates() {
        assert_eq!(MssqlDriver::ms_date_to_string(0), "0001-01-01");
        assert_eq!(MssqlDriver::ms_date_to_string(738885), "2024-01-01");
        assert_eq!(MssqlDriver::ms_date_to_string(738886), "2024-01-02");
    }

    #[test]
    fn ms_time_converts_increments_at_each_scale() {
        // Scale 0: increments are whole seconds.
        assert_eq!(MssqlDriver::ms_time_to_string(3_600, 0), "01:00:00");
        assert_eq!(MssqlDriver::ms_time_to_string(86_399, 0), "23:59:59");
        // Scale 7: 10^7 increments per second — the TDS default.
        assert_eq!(
            MssqlDriver::ms_time_to_string(15_000_000, 7),
            "00:00:01.5000000"
        );
        assert_eq!(
            MssqlDriver::ms_time_to_string(36_000_000_000, 7),
            "01:00:00"
        );
    }

    #[test]
    fn ms_datetime_uses_the_1900_epoch_with_second_fragments() {
        // days=0, fragments=0 → the epoch itself.
        assert_eq!(
            MssqlDriver::ms_datetime_to_string(0, 0, 300.0),
            "1900-01-01 00:00:00"
        );
        // 300 fragments/s → 450 s = 7.5 minutes.
        assert_eq!(
            MssqlDriver::ms_datetime_to_string(0, 135_000, 300.0),
            "1900-01-01 00:07:30"
        );
        // One fragment is 1/300 s ≈ 3.3 ms → rounds to .003.
        assert_eq!(
            MssqlDriver::ms_datetime_to_string(0, 1, 300.0),
            "1900-01-01 00:00:00.003"
        );
    }

    #[test]
    fn small_datetime_fragments_are_minutes_not_seconds() {
        // 12 fragments at smalldatetime = 12 minutes, not 12 seconds.
        let value = ColumnData::SmallDateTime(Some(SmallDateTime::new(0, 12)));
        assert_eq!(
            MssqlDriver::ms_cell_to_json(&value),
            json!("1900-01-01 00:12:00")
        );
    }
    #[test]
    fn datetime2_and_datetimeoffset_render_full_values() {
        let dt2 = DateTime2::new(
            Date::new(738_885),
            Time::new(162_000_000_000, 7), // 16,200 s = 04:30:00
        );
        assert_eq!(
            MssqlDriver::ms_cell_to_json(&ColumnData::DateTime2(Some(dt2))),
            json!("2024-01-01 04:30:00")
        );

        let dto = DateTimeOffset::new(dt2, -330);
        assert_eq!(
            MssqlDriver::ms_cell_to_json(&ColumnData::DateTimeOffset(Some(dto))),
            json!("2024-01-01 04:30:00-05:30")
        );
        let dto = DateTimeOffset::new(dt2, 60);
        assert_eq!(
            MssqlDriver::ms_cell_to_json(&ColumnData::DateTimeOffset(Some(dto))),
            json!("2024-01-01 04:30:00+01:00")
        );

        let dt = DateTime::new(45_960, 10_800 * 300); // +45,960 days, 3 h
                                                      // +45,960 days from 1900-01-01 is 2025-11-01.
        assert_eq!(
            MssqlDriver::ms_cell_to_json(&ColumnData::DateTime(Some(dt))),
            json!("2025-11-01 03:00:00")
        );
    }

    #[test]
    fn scalar_cells_convert_and_null_stays_null() {
        assert_eq!(
            MssqlDriver::ms_cell_to_json(&ColumnData::I32(Some(7))),
            json!(7)
        );
        assert_eq!(
            MssqlDriver::ms_cell_to_json(&ColumnData::Bit(Some(true))),
            json!(true)
        );
        assert_eq!(
            MssqlDriver::ms_cell_to_json(&ColumnData::String(Some(Cow::Borrowed("x")))),
            json!("x")
        );
        // Binary renders as lowercase hex (what the grid's hex editor expects).
        assert_eq!(
            MssqlDriver::ms_cell_to_json(&ColumnData::Binary(Some(Cow::Owned(vec![
                0xde, 0xad, 0xbe, 0xef
            ])))),
            json!("deadbeef")
        );
        for value in [
            ColumnData::I32(None),
            ColumnData::String(None),
            ColumnData::Binary(None),
            ColumnData::DateTime(None),
        ] {
            assert_eq!(MssqlDriver::ms_cell_to_json(&value), json!(null));
        }
    }

    #[test]
    fn column_type_names_match_the_tds_family() {
        assert_eq!(
            MssqlDriver::ms_column_type(&ColumnData::DateTimeOffset(None)),
            "datetimeoffset"
        );
        assert_eq!(
            MssqlDriver::ms_column_type(&ColumnData::DateTime2(None)),
            "datetime2"
        );
        assert_eq!(
            MssqlDriver::ms_column_type(&ColumnData::Binary(None)),
            "varbinary"
        );
        assert_eq!(
            MssqlDriver::ms_column_type(&ColumnData::U8(None)),
            "tinyint"
        );
    }
}
