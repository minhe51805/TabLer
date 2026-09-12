use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
    /// Elapsed query time in milliseconds. Kept as `u128` because drivers assign
    /// it straight from `Instant::elapsed().as_millis()`, but transported as a
    /// `u64` number so it round-trips through plain `serde_json` (which rejects
    /// `u128`) — e.g. the `driver-sidecar-v1` newline-JSON framing. `u64`
    /// milliseconds is astronomically sufficient and the on-wire JSON shape (a
    /// number) is unchanged for the frontend.
    #[serde(with = "millis_as_u64")]
    pub execution_time_ms: u128,
    pub query: String,
    pub sandboxed: bool,
    pub truncated: bool,
}

/// Serialize/deserialize a `u128` millisecond duration as a JSON `u64`. `u128`
/// is not representable by `serde_json` without `arbitrary_precision`, so any
/// JSON transport (frontend IPC, sidecar framing) needs this narrowing.
mod millis_as_u64 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u128, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u64(u64::try_from(*value).unwrap_or(u64::MAX))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u128, D::Error> {
        Ok(u128::from(u64::deserialize(deserializer)?))
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QueryParameterType {
    #[default]
    Text,
    Integer,
    Decimal,
    Boolean,
    Json,
    Null,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryParameter {
    pub name: String,
    pub value: serde_json::Value,
    #[serde(default)]
    pub data_type: QueryParameterType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub is_primary_key: bool,
    pub max_length: Option<u32>,
    pub default_value: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::QueryResult;

    /// `execution_time_ms` is a `u128`, which plain `serde_json` cannot encode.
    /// The `millis_as_u64` serde bridge must let a `QueryResult` round-trip
    /// through `serde_json` (the sidecar framing and frontend IPC both rely on
    /// this) while preserving the value.
    #[test]
    fn query_result_round_trips_through_serde_json_with_a_u128_duration() {
        let result = QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: 0,
            execution_time_ms: 1_234_u128,
            query: "SELECT 1".into(),
            sandboxed: false,
            truncated: false,
        };
        let json = serde_json::to_string(&result).expect("u128 duration must serialize as u64");
        assert!(
            json.contains("\"execution_time_ms\":1234"),
            "duration must be a plain JSON number: {json}"
        );
        let decoded: QueryResult = serde_json::from_str(&json).expect("must decode back");
        assert_eq!(decoded.execution_time_ms, 1_234_u128);
    }
}

