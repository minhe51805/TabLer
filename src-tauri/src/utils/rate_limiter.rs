use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct SlidingWindowRateLimiter {
    attempts: Mutex<HashMap<String, Vec<Instant>>>,
    window: Duration,
    max_attempts: usize,
    retry_after_message: &'static str,
}

impl SlidingWindowRateLimiter {
    pub fn new(
        window: Duration,
        max_attempts: usize,
        retry_after_message: &'static str,
    ) -> Self {
        Self {
            attempts: Mutex::new(HashMap::new()),
            window,
            max_attempts,
            retry_after_message,
        }
    }

    pub fn check(&self, key: &str) -> Result<(), String> {
        let now = Instant::now();
        let mut attempts = self
            .attempts
            .lock()
            .map_err(|_| "Internal rate limiter lock failed.".to_string())?;

        let entry = attempts.entry(key.to_string()).or_default();
        entry.retain(|attempt| now.duration_since(*attempt) < self.window);

        if entry.len() >= self.max_attempts {
            return Err(self.retry_after_message.to_string());
        }

        entry.push(now);
        Ok(())
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

    pub fn check(&self, key: &str) -> Result<(), String> {
        self.inner.check(key)
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

    pub fn check(&self, key: &str) -> Result<(), String> {
        self.inner.check(key)
    }
}
