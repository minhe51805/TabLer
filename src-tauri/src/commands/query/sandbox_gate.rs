use crate::error::AppError;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::{Duration, Instant};

pub const SANDBOX_MAX_CONCURRENCY: usize = 8;
pub const SANDBOX_BREAKER_FAILURE_THRESHOLD: u32 = 10;
pub const SANDBOX_BREAKER_FAILURE_WINDOW: Duration = Duration::from_secs(60);
pub const SANDBOX_BREAKER_OPEN_DURATION: Duration = Duration::from_secs(30);

#[derive(Debug, Default)]
struct BreakerEntry {
    consecutive_failures: u32,
    last_failure: Option<Instant>,
    opened_until: Option<Instant>,
    half_open_probe_in_flight: bool,
}

pub struct SandboxGateState {
    breakers: Mutex<HashMap<String, BreakerEntry>>,
    execution_slots: Arc<Semaphore>,
}

impl Default for SandboxGateState {
    fn default() -> Self {
        Self {
            breakers: Mutex::new(HashMap::new()),
            execution_slots: Arc::new(Semaphore::new(SANDBOX_MAX_CONCURRENCY)),
        }
    }
}

impl SandboxGateState {
    pub async fn acquire_execution_slot(&self) -> Result<OwnedSemaphorePermit, AppError> {
        self.execution_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| AppError::SandboxThrottled("execution queue is closed".to_string()))
    }

    pub async fn check_breaker(&self, connection_id: &str) -> Result<(), AppError> {
        let now = Instant::now();
        let mut breakers = self.breakers.lock().await;
        let Some(entry) = breakers.get_mut(connection_id) else {
            return Ok(());
        };
        let Some(opened_until) = entry.opened_until else {
            return Ok(());
        };
        if now < opened_until {
            let retry_after = opened_until.duration_since(now).as_secs().max(1);
            return Err(AppError::SandboxThrottled(format!(
                "circuit breaker is open for this connection; retry in {retry_after}s"
            )));
        }
        if entry.half_open_probe_in_flight {
            return Err(AppError::SandboxThrottled(
                "circuit breaker is waiting for its half-open probe".to_string(),
            ));
        }
        entry.half_open_probe_in_flight = true;
        Ok(())
    }

    pub async fn record_failure(&self, connection_id: &str) {
        let now = Instant::now();
        let mut breakers = self.breakers.lock().await;
        let entry = breakers.entry(connection_id.to_string()).or_default();
        if entry.half_open_probe_in_flight {
            entry.half_open_probe_in_flight = false;
            entry.opened_until = Some(now + SANDBOX_BREAKER_OPEN_DURATION);
            entry.last_failure = Some(now);
            return;
        }
        if entry
            .last_failure
            .is_some_and(|last| now.duration_since(last) >= SANDBOX_BREAKER_FAILURE_WINDOW)
        {
            entry.consecutive_failures = 0;
        }
        entry.consecutive_failures += 1;
        entry.last_failure = Some(now);
        if entry.consecutive_failures >= SANDBOX_BREAKER_FAILURE_THRESHOLD {
            entry.opened_until = Some(now + SANDBOX_BREAKER_OPEN_DURATION);
        }
    }

    pub async fn record_success(&self, connection_id: &str) {
        self.breakers.lock().await.remove(connection_id);
    }
}

#[cfg(test)]
mod tests {
    use super::{SandboxGateState, SANDBOX_MAX_CONCURRENCY};
    use crate::utils::rate_limiter::{SandboxExecutionLimiter, SlidingWindowRateLimiter};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::time::{advance, Duration};

    #[tokio::test(start_paused = true)]
    async fn sandbox_throttles_burst_above_limit() {
        let limiter =
            SlidingWindowRateLimiter::new(Duration::from_secs(60), 20, "minute limit reached");
        let mut passed = 0;
        let mut throttled = 0;
        for _ in 0..25 {
            match limiter.check("connection-1").await {
                Ok(()) => passed += 1,
                Err(_) => throttled += 1,
            }
        }
        assert_eq!((passed, throttled), (20, 5));

        let production_limiter = SandboxExecutionLimiter::new();
        for _ in 0..10 {
            production_limiter.check("connection-1").await.unwrap();
        }
        assert!(production_limiter.check("connection-1").await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn breaker_opens_after_consecutive_failures_and_half_opens() {
        let state = SandboxGateState::default();
        let driver_calls = Arc::new(AtomicUsize::new(0));
        for _ in 0..10 {
            state.check_breaker("connection-1").await.unwrap();
            driver_calls.fetch_add(1, Ordering::SeqCst);
            state.record_failure("connection-1").await;
        }
        state.check_breaker("connection-1").await.unwrap_err();
        assert_eq!(driver_calls.load(Ordering::SeqCst), 10);

        advance(Duration::from_secs(30)).await;
        state.check_breaker("connection-1").await.unwrap();
        state.check_breaker("connection-1").await.unwrap_err();
        driver_calls.fetch_add(1, Ordering::SeqCst);
        state.record_success("connection-1").await;
        state.check_breaker("connection-1").await.unwrap();
        assert_eq!(driver_calls.load(Ordering::SeqCst), 11);
    }

    #[tokio::test(start_paused = true)]
    async fn breaker_reopens_when_the_half_open_probe_fails() {
        let state = SandboxGateState::default();
        for _ in 0..10 {
            state.record_failure("connection-1").await;
        }
        advance(Duration::from_secs(30)).await;
        state.check_breaker("connection-1").await.unwrap();
        state.record_failure("connection-1").await;
        state.check_breaker("connection-1").await.unwrap_err();
    }

    #[tokio::test(start_paused = true)]
    async fn sandbox_concurrency_capped_at_eight() {
        let state = Arc::new(SandboxGateState::default());
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..20 {
            let state = Arc::clone(&state);
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            tasks.push(tokio::spawn(async move {
                let permit = state.acquire_execution_slot().await.unwrap();
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(current, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(10)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                drop(permit);
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), SANDBOX_MAX_CONCURRENCY);
    }

    #[tokio::test(start_paused = true)]
    async fn dispatch_flood_200_calls_over_60_seconds_stays_bounded() {
        let state = SandboxGateState::default();
        let limiter = SandboxExecutionLimiter::new();
        let mut driver_calls = 0;
        for _ in 0..200 {
            let permit = state.acquire_execution_slot().await.unwrap();
            let admitted = if limiter.check("connection-1").await.is_ok() {
                state.check_breaker("connection-1").await.is_ok()
            } else {
                false
            };
            if admitted {
                driver_calls += 1;
                state.record_failure("connection-1").await;
            }
            drop(permit);
            advance(Duration::from_millis(300)).await;
        }
        assert!(
            driver_calls <= 20,
            "flood reached the driver {driver_calls} times"
        );
    }
}
