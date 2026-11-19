use std::collections::HashMap;
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::{Duration, Instant};

pub struct SlidingWindowRateLimiter {
    attempts: AsyncMutex<HashMap<String, Vec<Instant>>>,
    window: Duration,
    max_attempts: usize,
    retry_after_message: &'static str,
}

impl SlidingWindowRateLimiter {
    pub fn new(window: Duration, max_attempts: usize, retry_after_message: &'static str) -> Self {
        Self {
            attempts: AsyncMutex::new(HashMap::new()),
            window,
            max_attempts,
            retry_after_message,
        }
    }

    pub async fn check(&self, key: &str) -> Result<(), String> {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().await;

        let entry = attempts.entry(key.to_string()).or_default();
        entry.retain(|attempt| now.duration_since(*attempt) < self.window);

        if entry.len() >= self.max_attempts {
            return Err(self.retry_after_message.to_string());
        }

        entry.push(now);
        Ok(())
    }
}

const SANDBOX_MINUTE_LIMIT: (Duration, usize) = (Duration::from_secs(60), 20);
const SANDBOX_SECOND_LIMIT: (Duration, usize) = (Duration::from_secs(1), 10);

/// Dual-window sandbox execution limiter backed by a single per-key timestamp
/// log. Because the 1s window is a strict subset of the 60s window, checking
/// both under one lock avoids double-storing timestamps and guarantees that a
/// burst rejected by the 1s cap never consumes capacity from the 60s budget.
pub struct SandboxExecutionLimiter {
    attempts: AsyncMutex<HashMap<String, Vec<Instant>>>,
}

impl SandboxExecutionLimiter {
    pub fn new() -> Self {
        Self {
            attempts: AsyncMutex::new(HashMap::new()),
        }
    }

    pub async fn check(&self, key: &str) -> Result<(), String> {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().await;
        let entry = attempts.entry(key.to_string()).or_default();
        entry.retain(|attempt| now.duration_since(*attempt) < SANDBOX_MINUTE_LIMIT.0);

        if entry.len() >= SANDBOX_MINUTE_LIMIT.1 {
            return Err("20 executions per minute exceeded; retry shortly".to_string());
        }

        let recent_second = entry
            .iter()
            .filter(|attempt| now.duration_since(**attempt) < SANDBOX_SECOND_LIMIT.0)
            .count();
        if recent_second >= SANDBOX_SECOND_LIMIT.1 {
            return Err("10 executions per second exceeded; retry shortly".to_string());
        }

        entry.push(now);
        Ok(())
    }
}

impl Default for SandboxExecutionLimiter {
    fn default() -> Self {
        Self::new()
    }
}

pub struct ConnectionAttemptLimiter {
    inner: SlidingWindowRateLimiter,
}

impl ConnectionAttemptLimiter {
    pub fn new(window: Duration, max_attempts: usize, retry_after_message: &'static str) -> Self {
        Self {
            inner: SlidingWindowRateLimiter::new(window, max_attempts, retry_after_message),
        }
    }

    pub async fn check(&self, key: &str) -> Result<(), String> {
        self.inner.check(key).await
    }
}

pub struct AIRequestLimiter {
    inner: SlidingWindowRateLimiter,
}

impl AIRequestLimiter {
    pub fn new(window: Duration, max_attempts: usize, retry_after_message: &'static str) -> Self {
        Self {
            inner: SlidingWindowRateLimiter::new(window, max_attempts, retry_after_message),
        }
    }

    pub async fn check(&self, key: &str) -> Result<(), String> {
        self.inner.check(key).await
    }
}

#[cfg(test)]
mod tests {
    use super::SandboxExecutionLimiter;
    use tokio::time::{advance, Duration};

    #[tokio::test(start_paused = true)]
    async fn rejected_per_second_burst_does_not_burn_per_minute_quota() {
        let limiter = SandboxExecutionLimiter::new();
        for _ in 0..10 {
            limiter.check("agent:conn-1").await.unwrap();
        }
        // Burst attempts 11..25 within the same second are rejected by the 1s window
        // and must NOT consume the remaining 10 slots of the 60s window.
        for _ in 0..15 {
            let err = limiter.check("agent:conn-1").await.unwrap_err();
            assert!(err.contains("10 executions per second"));
        }

        advance(Duration::from_millis(1_100)).await;
        for _ in 0..10 {
            limiter
                .check("agent:conn-1")
                .await
                .expect("remaining 10 per-minute slots should still be available");
        }
        let minute_err = limiter.check("agent:conn-1").await.unwrap_err();
        assert!(minute_err.contains("20 executions per minute"));
    }
}
