//! `driver-sidecar-v1`: the out-of-process host contract for `plugin_native`
//! engines (DuckDB, Cassandra, Redis, LibSQL).
//!
//! Rust has no stable ABI, so a downloaded "native driver" cannot be linked
//! into the running app. Phase 4 instead runs each native driver as a
//! standalone per-platform sidecar binary and speaks a stable, versioned
//! protocol to it over stdio. This module owns that protocol and its framing;
//! the spawning host proxy and the reference sidecar are layered on later.
//!
//! Framing: newline-delimited JSON. Each message is one compact JSON object on
//! its own line. `serde_json`'s compact form escapes control characters, so an
//! encoded frame never contains a raw newline and lines split unambiguously.

pub mod client;
pub mod driver;
pub mod protocol;
pub mod server;

pub use client::SidecarClient;
pub use driver::SidecarDriver;
pub use protocol::SIDECAR_PROTOCOL_VERSION;
pub use server::{serve, SidecarBackend};

use serde::de::DeserializeOwned;
use serde::Serialize;

/// Encode a message as a single newline-free JSON frame (the caller appends the
/// `\n` delimiter when writing to the stream).
pub fn encode_frame<T: Serialize>(message: &T) -> serde_json::Result<String> {
    serde_json::to_string(message)
}

/// Decode one framed line (its trailing newline already stripped) into a
/// message.
pub fn decode_frame<T: DeserializeOwned>(line: &str) -> serde_json::Result<T> {
    serde_json::from_str(line)
}

/// The `<os>-<arch>` key identifying the sidecar asset for the running host
/// (e.g. `windows-x86_64`, `macos-aarch64`, `linux-x86_64`). Used both to locate
/// the per-platform executable inside an installed sidecar bundle and, in the
/// registry, to publish per-platform assets.
pub fn platform_target() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// Absolute path to a sidecar executable inside an installed bundle. By
/// convention a `driver-sidecar-v1` bundle lays out its binaries as
/// `bin/<platform_target>/<driver_id>[.exe]`, so a single verified bundle can
/// carry every platform and the host picks the one it can run.
pub fn sidecar_executable_path(
    bundle_dir: &std::path::Path,
    driver_id: &str,
) -> std::path::PathBuf {
    let file_name = if cfg!(target_os = "windows") {
        format!("{driver_id}.exe")
    } else {
        driver_id.to_string()
    };
    bundle_dir
        .join("bin")
        .join(platform_target())
        .join(file_name)
}

#[cfg(test)]
mod tests {
    use super::protocol::{HostFrame, SidecarCall, SidecarFrame, SidecarRequest};
    use super::{decode_frame, encode_frame};

    #[test]
    fn a_frame_encodes_to_a_single_line_and_decodes_back() {
        let frame = HostFrame::Request(SidecarRequest {
            id: 3,
            call: SidecarCall::ExecuteQuery {
                sql: "SELECT 1".into(),
            },
        });
        let line = encode_frame(&frame).unwrap();
        assert!(!line.contains('\n'), "frame must be one line: {line}");
        let decoded: HostFrame = decode_frame(&line).unwrap();
        assert_eq!(encode_frame(&decoded).unwrap(), line);
    }

    #[test]
    fn embedded_newlines_in_payloads_are_escaped_not_raw() {
        // A message that itself contains a newline must not break framing: the
        // encoded line stays single-line (the newline is escaped as \n).
        let frame = SidecarFrame::Log {
            level: "warn".into(),
            message: "line one\nline two".into(),
        };
        let line = encode_frame(&frame).unwrap();
        assert!(!line.contains('\n'), "payload newline must be escaped: {line}");
        let decoded: SidecarFrame = decode_frame(&line).unwrap();
        match decoded {
            SidecarFrame::Log { message, .. } => assert_eq!(message, "line one\nline two"),
            _ => panic!("expected a log frame"),
        }
    }

    #[test]
    fn platform_target_is_os_dash_arch() {
        let key = super::platform_target();
        assert!(key.starts_with(std::env::consts::OS), "got: {key}");
        assert!(key.ends_with(std::env::consts::ARCH), "got: {key}");
        assert!(key.contains('-'));
    }

    #[test]
    fn sidecar_executable_path_follows_the_bin_platform_convention() {
        let path = super::sidecar_executable_path(std::path::Path::new("/plugins/duck"), "duckdb");
        let shown = path.to_string_lossy().replace('\\', "/");
        assert!(shown.contains("/bin/"), "got: {shown}");
        assert!(shown.contains(&super::platform_target()), "got: {shown}");
        if cfg!(target_os = "windows") {
            assert!(shown.ends_with("duckdb.exe"), "got: {shown}");
        } else {
            assert!(shown.ends_with("duckdb"), "got: {shown}");
        }
    }
}
