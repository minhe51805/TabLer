use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// In-flight request slot used so cancel can race ahead of backend-id registration.
///
/// `cancel_flag` is shared with engines that cannot be killed by id (SQLite's
/// progress handler polls it from inside the running statement), so a cancel
/// recorded before the backend id lands still reaches the executor.
#[derive(Clone, Debug)]
struct Slot {
    backend_id: Option<i64>,
    cancel_requested: bool,
    cancel_flag: Arc<AtomicBool>,
}

/// Per-driver registry mapping a frontend `request_id` to a live backend
/// process/connection id so `cancel_query` can reach the server.
#[derive(Default)]
pub struct QueryCancelRegistry {
    slots: HashMap<String, Slot>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelLookup {
    /// Query never began or already finished.
    NotRunning,
    /// Cancel was recorded; the execute path must abort before starting SQL.
    Pending,
    /// Backend id is known; caller should issue a server-side cancel.
    Backend(i64),
}

impl QueryCancelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin(&mut self, request_id: &str) {
        self.slots
            .entry(request_id.to_string())
            .or_insert_with(Slot::new);
    }

    /// Record the live backend id. Returns true when cancel already won the race
    /// and the caller must not start the user SQL.
    pub fn register_backend(&mut self, request_id: &str, backend_id: i64) -> bool {
        let slot = self
            .slots
            .entry(request_id.to_string())
            .or_insert_with(Slot::new);
        slot.backend_id = Some(backend_id);
        slot.cancel_requested
    }

    /// Shared flag flipped by `request_cancel`. Drivers without a killable
    /// backend id (e.g. SQLite's progress handler) poll this instead.
    pub fn cancel_flag(&self, request_id: &str) -> Option<Arc<AtomicBool>> {
        self.slots
            .get(request_id)
            .map(|slot| slot.cancel_flag.clone())
    }

    pub fn request_cancel(&mut self, request_id: &str) -> CancelLookup {
        match self.slots.get_mut(request_id) {
            None => CancelLookup::NotRunning,
            Some(slot) => {
                slot.cancel_requested = true;
                slot.cancel_flag.store(true, Ordering::SeqCst);
                match slot.backend_id {
                    Some(id) => CancelLookup::Backend(id),
                    None => CancelLookup::Pending,
                }
            }
        }
    }

    pub fn finish(&mut self, request_id: &str) {
        self.slots.remove(request_id);
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }
}
impl Slot {
    fn new() -> Self {
        Self {
            backend_id: None,
            cancel_requested: false,
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }
}

pub struct CancelScopeGuard<'a> {
    lock: &'a RwLock<QueryCancelRegistry>,
    request_id: String,
}

impl<'a> CancelScopeGuard<'a> {
    pub fn begin(lock: &'a RwLock<QueryCancelRegistry>, request_id: &str) -> Self {
        write_registry(lock).begin(request_id);
        Self {
            lock,
            request_id: request_id.to_string(),
        }
    }

    pub fn register_backend(&self, backend_id: i64) -> bool {
        write_registry(self.lock).register_backend(&self.request_id, backend_id)
    }

    /// Shared cancel flag for the request, if the slot is still open.
    pub fn cancel_flag(&self) -> Option<Arc<AtomicBool>> {
        read_registry(self.lock).cancel_flag(&self.request_id)
    }
}

impl Drop for CancelScopeGuard<'_> {
    fn drop(&mut self) {
        write_registry(self.lock).finish(&self.request_id);
    }
}

pub fn request_cancel(lock: &RwLock<QueryCancelRegistry>, request_id: &str) -> CancelLookup {
    write_registry(lock).request_cancel(request_id)
}

/// Read-side helper for drivers that poll the shared cancel flag.
pub fn cancel_flag(
    lock: &RwLock<QueryCancelRegistry>,
    request_id: &str,
) -> Option<Arc<AtomicBool>> {
    read_registry(lock).cancel_flag(request_id)
}

fn read_registry(lock: &RwLock<QueryCancelRegistry>) -> RwLockReadGuard<'_, QueryCancelRegistry> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_registry(lock: &RwLock<QueryCancelRegistry>) -> RwLockWriteGuard<'_, QueryCancelRegistry> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::RwLock;

    #[test]
    fn default_absent_request_is_not_running() {
        let mut registry = QueryCancelRegistry::new();
        assert_eq!(registry.request_cancel("missing"), CancelLookup::NotRunning);
        assert!(registry.is_empty());
    }

    #[test]
    fn cancel_before_backend_id_marks_pending() {
        let mut registry = QueryCancelRegistry::new();
        registry.begin("req-1");
        assert_eq!(registry.request_cancel("req-1"), CancelLookup::Pending);
        assert!(registry.register_backend("req-1", 42));
    }

    #[test]
    fn cancel_after_backend_id_returns_the_pid() {
        let mut registry = QueryCancelRegistry::new();
        registry.begin("req-1");
        assert!(!registry.register_backend("req-1", 99));
        assert_eq!(registry.request_cancel("req-1"), CancelLookup::Backend(99));
    }

    #[test]
    fn finish_does_not_leak_and_late_cancel_is_not_running() {
        let mut registry = QueryCancelRegistry::new();
        registry.begin("req-1");
        registry.register_backend("req-1", 7);
        registry.finish("req-1");
        assert!(registry.is_empty());
        assert_eq!(registry.request_cancel("req-1"), CancelLookup::NotRunning);
        assert!(registry.is_empty());
    }

    #[test]
    fn drop_guard_finishes_on_success_and_on_early_error() {
        let lock = RwLock::new(QueryCancelRegistry::new());
        {
            let guard = CancelScopeGuard::begin(&lock, "req-drop");
            assert!(!guard.register_backend(11));
            assert!(!write_registry(&lock).is_empty());
        }
        assert!(write_registry(&lock).is_empty());

        // A block, not a closure: the guard must drop - and so deregister -
        // before the assertions below read the registry. Inlining the statements
        // into the function body would keep the guard alive across them.
        let result: Result<(), &'static str> = {
            let guard = CancelScopeGuard::begin(&lock, "req-err");
            let _ = guard.register_backend(12);
            Err("boom")
        };
        assert!(result.is_err());
        assert!(write_registry(&lock).is_empty());
    }

    #[test]
    fn request_cancel_flips_the_shared_flag() {
        let lock = RwLock::new(QueryCancelRegistry::new());
        let guard = CancelScopeGuard::begin(&lock, "req-flag");
        let flag = guard.cancel_flag().expect("slot flag");
        assert!(!flag.load(Ordering::SeqCst));
        assert_eq!(request_cancel(&lock, "req-flag"), CancelLookup::Pending);
        assert!(flag.load(Ordering::SeqCst));
        assert!(cancel_flag(&lock, "missing").is_none());
    }
}
