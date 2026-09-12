//! Host-side transport for the `driver-sidecar-v1` protocol.
//!
//! [`SidecarClient`] owns the two halves of the stdio conversation with a
//! spawned sidecar process and turns the framed, id-correlated wire protocol
//! into ergonomic `async` calls. It is deliberately transport-agnostic (built
//! from any `AsyncRead`/`AsyncWrite` pair) so the correlation, timeout,
//! cancellation, and lifecycle logic can be unit-tested over an in-memory
//! duplex without spawning a real process.
//!
//! Concurrency model:
//! - a writer task owns the write half and serializes outgoing frames received
//!   over a bounded channel (so many callers can write without sharing a lock);
//! - a reader task owns the read half, decodes each line, and routes a
//!   [`SidecarResponse`] to the matching caller via a per-id oneshot.

use super::protocol::{
    HostFrame, SidecarCall, SidecarFrame, SidecarOutcome, SidecarRequest, SidecarResponsePayload,
};
use super::{decode_frame, encode_frame};
use crate::database::models::CsvImportRow;
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

/// Rows are forwarded to a streaming import in batches of this size.
const STREAM_BATCH_ROWS: usize = 500;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<SidecarOutcome>>>>;

pub struct SidecarClient {
    next_id: AtomicU64,
    pending: Pending,
    writer_tx: mpsc::Sender<String>,
    reader_task: JoinHandle<()>,
    writer_task: JoinHandle<()>,
    /// Timeout applied to unary calls. Long-running cancellable/streaming
    /// operations do not use it (they end on completion or cancellation).
    call_timeout: Duration,
}

impl SidecarClient {
    /// Build a client over an already-open transport pair and start its I/O
    /// tasks. Callers spawning a real process pass the child's stdout/stdin.
    pub fn new<R, W>(reader: R, writer: W, call_timeout: Duration) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let reader_task = tokio::spawn(reader_loop(reader, Arc::clone(&pending)));
        let (writer_tx, writer_rx) = mpsc::channel::<String>(1024);
        let writer_task = tokio::spawn(writer_loop(writer, writer_rx));
        Self {
            next_id: AtomicU64::new(1),
            pending,
            writer_tx,
            reader_task,
            writer_task,
            call_timeout,
        }
    }

    fn register(&self) -> (u64, oneshot::Receiver<SidecarOutcome>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        (id, rx)
    }

    fn forget(&self, id: u64) {
        self.pending.lock().unwrap().remove(&id);
    }

    async fn write_frame<T: Serialize>(&self, frame: &T) -> Result<()> {
        let line =
            encode_frame(frame).map_err(|e| anyhow!("failed to encode sidecar frame: {e}"))?;
        self.writer_tx
            .send(line)
            .await
            .map_err(|_| anyhow!("sidecar writer channel is closed"))
    }

    /// Send a unary request and await its response, subject to `call_timeout`.
    pub async fn call(&self, call: SidecarCall) -> Result<SidecarResponsePayload> {
        let (id, rx) = self.register();
        if let Err(e) = self
            .write_frame(&HostFrame::Request(SidecarRequest { id, call }))
            .await
        {
            self.forget(id);
            return Err(e);
        }
        match tokio::time::timeout(self.call_timeout, rx).await {
            Ok(Ok(outcome)) => outcome_into_result(outcome),
            Ok(Err(_)) => {
                self.forget(id);
                Err(anyhow!("sidecar closed the connection before replying"))
            }
            Err(_) => {
                self.forget(id);
                Err(anyhow!("sidecar call timed out"))
            }
        }
    }

    /// Send a request that may be aborted mid-flight via the shared `cancelled`
    /// flag (mirrors the trait's `Arc<AtomicBool>` cancellation). No timeout:
    /// bulk operations end on completion or cancellation.
    pub async fn call_cancellable(
        &self,
        call: SidecarCall,
        cancelled: Arc<AtomicBool>,
    ) -> Result<SidecarResponsePayload> {
        if cancelled.load(Ordering::Relaxed) {
            return Err(anyhow!("operation cancelled before it started"));
        }
        let (id, mut rx) = self.register();
        if let Err(e) = self
            .write_frame(&HostFrame::Request(SidecarRequest { id, call }))
            .await
        {
            self.forget(id);
            return Err(e);
        }
        loop {
            tokio::select! {
                res = &mut rx => {
                    return match res {
                        Ok(outcome) => outcome_into_result(outcome),
                        Err(_) => {
                            self.forget(id);
                            Err(anyhow!("sidecar closed the connection before replying"))
                        }
                    };
                }
                _ = tokio::time::sleep(Duration::from_millis(50)) => {
                    if cancelled.load(Ordering::Relaxed) {
                        let _ = self.write_frame(&HostFrame::Cancel { id }).await;
                        return match rx.await {
                            Ok(outcome) => outcome_into_result(outcome),
                            Err(_) => {
                                self.forget(id);
                                Err(anyhow!("operation cancelled"))
                            }
                        };
                    }
                }
            }
        }
    }

    /// Drive a streaming atomic import: open the stream, pump rows in batches,
    /// end (or cancel) it, then await the sidecar's final tally.
    pub async fn stream_import(
        &self,
        mut rows: mpsc::Receiver<CsvImportRow>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<SidecarResponsePayload> {
        let (id, rx) = self.register();
        if let Err(e) = self
            .write_frame(&HostFrame::Request(SidecarRequest {
                id,
                call: SidecarCall::InsertTableRowStreamAtomically,
            }))
            .await
        {
            self.forget(id);
            return Err(e);
        }

        let mut batch: Vec<CsvImportRow> = Vec::with_capacity(STREAM_BATCH_ROWS);
        loop {
            if cancelled.load(Ordering::Relaxed) {
                let _ = self.write_frame(&HostFrame::Cancel { id }).await;
                break;
            }
            match rows.recv().await {
                Some(row) => {
                    batch.push(row);
                    if batch.len() >= STREAM_BATCH_ROWS {
                        let chunk = std::mem::take(&mut batch);
                        if let Err(e) =
                            self.write_frame(&HostFrame::StreamChunk { id, rows: chunk }).await
                        {
                            self.forget(id);
                            return Err(e);
                        }
                    }
                }
                None => {
                    if !batch.is_empty() {
                        let chunk = std::mem::take(&mut batch);
                        let _ = self.write_frame(&HostFrame::StreamChunk { id, rows: chunk }).await;
                    }
                    let _ = self.write_frame(&HostFrame::StreamEnd { id }).await;
                    break;
                }
            }
        }

        match rx.await {
            Ok(outcome) => outcome_into_result(outcome),
            Err(_) => {
                self.forget(id);
                Err(anyhow!(
                    "sidecar closed the connection during streaming import"
                ))
            }
        }
    }

    /// Best-effort request that the sidecar exit cleanly.
    pub async fn shutdown(&self) {
        let _ = self.write_frame(&HostFrame::Shutdown).await;
    }
}

impl Drop for SidecarClient {
    fn drop(&mut self) {
        self.reader_task.abort();
        self.writer_task.abort();
    }
}

fn outcome_into_result(outcome: SidecarOutcome) -> Result<SidecarResponsePayload> {
    match outcome {
        SidecarOutcome::Ok(payload) => Ok(payload),
        SidecarOutcome::Err(err) => Err(anyhow!(err.message)),
    }
}

async fn writer_loop<W: AsyncWrite + Unpin>(mut writer: W, mut rx: mpsc::Receiver<String>) {
    while let Some(line) = rx.recv().await {
        if writer.write_all(line.as_bytes()).await.is_err()
            || writer.write_all(b"\n").await.is_err()
            || writer.flush().await.is_err()
        {
            break;
        }
    }
}

async fn reader_loop<R: AsyncRead + Unpin>(reader: R, pending: Pending) {
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let trimmed = line.trim_end_matches(['\r', '\n']);
                if trimmed.is_empty() {
                    continue;
                }
                match decode_frame::<SidecarFrame>(trimmed) {
                    Ok(SidecarFrame::Response(resp)) => {
                        if let Some(tx) = pending.lock().unwrap().remove(&resp.id) {
                            let _ = tx.send(resp.outcome);
                        }
                    }
                    Ok(SidecarFrame::Log { level, message }) => {
                        eprintln!("[sidecar:{level}] {message}");
                    }
                    Err(e) => {
                        eprintln!("[sidecar] dropping undecodable frame: {e}");
                    }
                }
            }
        }
    }
    // The stream ended: unblock every waiter with a channel-closed error.
    pending.lock().unwrap().clear();
}

#[cfg(test)]
mod tests {
    use super::SidecarClient;
    use crate::database::models::CsvImportRow;
    use crate::database::sidecar::protocol::{
        HostFrame, SidecarCall, SidecarFrame, SidecarOutcome, SidecarRequest, SidecarResponse,
        SidecarResponsePayload,
    };
    use crate::database::sidecar::{decode_frame, encode_frame};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
    use tokio::sync::mpsc;

    async fn send_ok<W: AsyncWrite + Unpin>(writer: &mut W, id: u64, payload: SidecarResponsePayload) {
        let frame = SidecarFrame::Response(SidecarResponse {
            id,
            outcome: SidecarOutcome::Ok(payload),
        });
        let line = encode_frame(&frame).unwrap();
        writer.write_all(line.as_bytes()).await.unwrap();
        writer.write_all(b"\n").await.unwrap();
        writer.flush().await.unwrap();
    }

    /// A minimal in-memory sidecar for transport tests. It answers a few unary
    /// calls, tallies streamed rows until `StreamEnd`, and reports `Cancelled`
    /// on a `Cancel` frame. `Disconnect` and `InsertTableRowsAtomically` are
    /// intentionally left unanswered to exercise timeout/cancel paths.
    async fn fake_sidecar<R, W>(reader: R, mut writer: W)
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        let mut stream_counts: HashMap<u64, u64> = HashMap::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let trimmed = line.trim_end_matches(['\r', '\n']);
                    if trimmed.is_empty() {
                        continue;
                    }
                    let frame: HostFrame = decode_frame(trimmed).unwrap();
                    match frame {
                        HostFrame::Request(SidecarRequest { id, call }) => {
                            let reply = match call {
                                SidecarCall::Ping => Some(SidecarResponsePayload::Unit),
                                SidecarCall::Handshake { protocol_version } => {
                                    Some(SidecarResponsePayload::Handshake {
                                        protocol_version,
                                        driver_name: "fake".into(),
                                    })
                                }
                                SidecarCall::ListDatabases => {
                                    Some(SidecarResponsePayload::Databases(vec![]))
                                }
                                SidecarCall::CountRows { .. } => {
                                    Some(SidecarResponsePayload::Count(7))
                                }
                                SidecarCall::InsertTableRowStreamAtomically => {
                                    stream_counts.insert(id, 0);
                                    None
                                }
                                // Long-running / never-answered on purpose:
                                SidecarCall::InsertTableRowsAtomically { .. }
                                | SidecarCall::Disconnect => None,
                                _ => Some(SidecarResponsePayload::Unit),
                            };
                            if let Some(payload) = reply {
                                send_ok(&mut writer, id, payload).await;
                            }
                        }
                        HostFrame::StreamChunk { id, rows } => {
                            *stream_counts.entry(id).or_insert(0) += rows.len() as u64;
                        }
                        HostFrame::StreamEnd { id } => {
                            let total = stream_counts.remove(&id).unwrap_or(0);
                            send_ok(&mut writer, id, SidecarResponsePayload::Affected(total)).await;
                        }
                        HostFrame::Cancel { id } => {
                            stream_counts.remove(&id);
                            send_ok(&mut writer, id, SidecarResponsePayload::Cancelled(true)).await;
                        }
                        HostFrame::Shutdown => break,
                    }
                }
            }
        }
    }

    /// Reads exactly one request then drops the transport, simulating a sidecar
    /// that dies before replying.
    async fn read_then_close<R: AsyncRead + Unpin, W>(reader: R, _writer: W) {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        let _ = reader.read_line(&mut line).await;
    }

    fn connect_fake(call_timeout: Duration) -> SidecarClient {
        let (client_io, sidecar_io) = tokio::io::duplex(64 * 1024);
        let (cr, cw) = tokio::io::split(client_io);
        let (sr, sw) = tokio::io::split(sidecar_io);
        tokio::spawn(fake_sidecar(sr, sw));
        SidecarClient::new(cr, cw, call_timeout)
    }

    #[tokio::test]
    async fn unary_call_returns_its_payload() {
        let client = connect_fake(Duration::from_secs(5));
        let payload = client
            .call(SidecarCall::CountRows {
                table: "t".into(),
                database: None,
            })
            .await
            .unwrap();
        assert!(matches!(payload, SidecarResponsePayload::Count(7)));
    }

    #[tokio::test]
    async fn concurrent_calls_are_correlated_by_id() {
        let client = connect_fake(Duration::from_secs(5));
        let (ping, dbs, count) = tokio::join!(
            client.call(SidecarCall::Ping),
            client.call(SidecarCall::ListDatabases),
            client.call(SidecarCall::CountRows {
                table: "t".into(),
                database: None,
            }),
        );
        assert!(matches!(ping.unwrap(), SidecarResponsePayload::Unit));
        assert!(matches!(dbs.unwrap(), SidecarResponsePayload::Databases(v) if v.is_empty()));
        assert!(matches!(count.unwrap(), SidecarResponsePayload::Count(7)));
    }

    #[tokio::test]
    async fn call_times_out_when_the_sidecar_never_replies() {
        let client = connect_fake(Duration::from_millis(120));
        let err = client.call(SidecarCall::Disconnect).await.unwrap_err();
        assert!(err.to_string().contains("timed out"), "got: {err}");
    }

    #[tokio::test]
    async fn call_errors_when_the_sidecar_closes_before_replying() {
        let (client_io, sidecar_io) = tokio::io::duplex(1024);
        let (cr, cw) = tokio::io::split(client_io);
        let (sr, sw) = tokio::io::split(sidecar_io);
        tokio::spawn(read_then_close(sr, sw));
        let client = SidecarClient::new(cr, cw, Duration::from_secs(5));
        let err = client.call(SidecarCall::Ping).await.unwrap_err();
        assert!(err.to_string().contains("closed"), "got: {err}");
    }

    #[tokio::test]
    async fn streaming_import_reports_the_total_row_count() {
        let client = connect_fake(Duration::from_secs(5));
        let (tx, rx) = mpsc::channel::<CsvImportRow>(16);
        // Buffer rows and close the sender before draining, so the pump sees
        // three rows then end-of-stream. Err rows still count toward the tally.
        for _ in 0..3 {
            tx.send(Err("row".to_string())).await.unwrap();
        }
        drop(tx);
        let cancelled = Arc::new(AtomicBool::new(false));
        let payload = client.stream_import(rx, cancelled).await.unwrap();
        assert!(matches!(payload, SidecarResponsePayload::Affected(3)));
    }

    #[tokio::test]
    async fn cancellable_call_sends_a_cancel_and_resolves() {
        let client = connect_fake(Duration::from_secs(5));
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancelled);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            flag.store(true, Ordering::Relaxed);
        });
        let payload = client
            .call_cancellable(
                SidecarCall::InsertTableRowsAtomically { requests: vec![] },
                cancelled,
            )
            .await
            .unwrap();
        assert!(matches!(payload, SidecarResponsePayload::Cancelled(true)));
    }
}
