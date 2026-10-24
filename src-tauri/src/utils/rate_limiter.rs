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

pub struct SandboxExecutionLimiter {
    per_minute: SlidingWindowRateLimiter,
    per_second: SlidingWindowRateLimiter,
}

impl SandboxExecutionLimiter {
    pub fn new() -> Self {
        Self {
            per_minute: SlidingWindowRateLimiter::new(
                Duration::from_secs(60),
                20,
                "20 executions per minute exceeded; retry shortly",
            ),
            per_second: SlidingWindowRateLimiter::new(
                Duration::from_secs(1),
                10,
                "10 executions per second exceeded; retry shortly",
            ),
        }
    }

    pub async fn check(&self, key: &str) -> Result<(), String> {
        self.per_minute.check(key).await?;
        self.per_second.check(key).await
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
