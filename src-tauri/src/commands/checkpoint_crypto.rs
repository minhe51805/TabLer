//! Checkpoint payload encryption (AES-256-GCM) backed by a data key in the
//! OS keyring.
//!
//! The 32-byte data key is generated once and stored as
//! `keyring::Entry::new("TableR_DataKey", "checkpoints")`; ciphertext blobs
//! are `MAGIC | nonce(12) | ciphertext` and are bound to their connection via
//! the AAD `tabler.checkpoint.v1|<connection_id>`, so a blob copied between
//! connections fails authentication instead of decrypting.
//!
//! `decrypt_checkpoint_payload` passes blobs without the `TCK1` magic through
//! unchanged so legacy plaintext checkpoints remain restorable. Callers must
//! not pre-branch on the blob format.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use keyring::Error as KeyringError;
use rand::RngCore;
use std::sync::{LazyLock, MutexGuard};

const MAGIC: &[u8; 4] = b"TCK1";
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const KEYRING_SERVICE: &str = "TableR_DataKey";
const KEYRING_USER: &str = "checkpoints";
const AAD_PREFIX: &[u8] = b"tabler.checkpoint.v1|";

/// The `keyring::Entry` (not just the key bytes) is process-cached so the
/// get-or-create sequence below stays atomic on this device and credential
/// stores that keep per-handle state behave consistently. The error is held
/// in the lazy value so a missing secure store surfaces on every call
/// instead of panicking during static initialization.
static DATA_KEY_ENTRY: LazyLock<Result<keyring::Entry, String>> = LazyLock::new(|| {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|error| format!("Failed to open secure storage for the checkpoint key: {error}"))
});

/// Serializes the read-or-generate sequence so two threads cannot both see
/// `NoEntry` and overwrite each other's fresh key.
static DATA_KEY_GUARD: LazyLock<std::sync::Mutex<()>> = LazyLock::new(|| std::sync::Mutex::new(()));

fn data_key_entry() -> Result<&'static keyring::Entry, String> {
    DATA_KEY_ENTRY
        .as_ref()
        .map_err(|error| format!("Secure storage is unavailable for checkpoint keys: {error}"))
}

fn data_key_guard() -> Result<MutexGuard<'static, ()>, String> {
    DATA_KEY_GUARD
        .lock()
        .map_err(|_| "Checkpoint key lock poisoned".to_string())
}

fn data_key() -> Result<[u8; KEY_LEN], String> {
    let _guard = data_key_guard()?;
    let entry = data_key_entry()?;
    match entry.get_password() {
        Ok(encoded) => decode_data_key(&encoded),
        Err(KeyringError::NoEntry) => {
            let mut key = [0u8; KEY_LEN];
            rand::rngs::OsRng.fill_bytes(&mut key);
            entry.set_password(&BASE64.encode(key)).map_err(|error| {
                format!("Failed to store the checkpoint data key in secure storage: {error}")
            })?;
            Ok(key)
        }
        Err(error) => Err(format!(
            "Failed to read the checkpoint data key from secure storage: {error}"
        )),
    }
}

fn decode_data_key(encoded: &str) -> Result<[u8; KEY_LEN], String> {
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "Checkpoint data key in secure storage is not valid base64.".to_string())?;
    <[u8; KEY_LEN]>::try_from(bytes.as_slice())
        .map_err(|_| "Checkpoint data key in secure storage has an unexpected length.".to_string())
}

fn aad(connection_id: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_PREFIX.len() + connection_id.len());
    aad.extend_from_slice(AAD_PREFIX);
    aad.extend_from_slice(connection_id.as_bytes());
    aad
}

fn encrypt_with_key(
    key: &[u8; KEY_LEN],
    connection_id: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|error| format!("Failed to initialize checkpoint encryption: {error}"))?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext,
                aad: &aad(connection_id),
            },
        )
        .map_err(|_| "Failed to encrypt the checkpoint payload.".to_string())?;
    let mut blob = Vec::with_capacity(MAGIC.len() + NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(MAGIC);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

fn decrypt_with_key(
    key: &[u8; KEY_LEN],
    connection_id: &str,
    blob: &[u8],
) -> Result<Vec<u8>, String> {
    if !blob.starts_with(MAGIC) {
        return Ok(blob.to_vec());
    }
    let body = &blob[MAGIC.len()..];
    if body.len() < NONCE_LEN {
        return Err("Checkpoint payload is truncated: missing nonce.".to_string());
    }
    let (nonce, ciphertext) = body.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|error| format!("Failed to initialize checkpoint decryption: {error}"))?;
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: &aad(connection_id),
            },
        )
        .map_err(|_| "Failed to decrypt the checkpoint payload.".to_string())
}

/// Encrypt a checkpoint payload for `connection_id`. Returns
/// `TCK1 | nonce | ciphertext` (AES-256-GCM). Any keyring or RNG failure is
/// surfaced — callers must not fall back to writing plaintext.
pub fn encrypt_checkpoint_payload(
    connection_id: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let key = data_key()?;
    encrypt_with_key(&key, connection_id, plaintext)
}

/// Decrypt a `TCK1` checkpoint blob for `connection_id`. Blobs without the
/// magic are returned unchanged so pre-encryption checkpoints stay restorable;
/// callers do not branch on the format.
pub fn decrypt_checkpoint_payload(connection_id: &str, blob: &[u8]) -> Result<Vec<u8>, String> {
    if !blob.starts_with(MAGIC) {
        return Ok(blob.to_vec());
    }
    let key = data_key()?;
    decrypt_with_key(&key, connection_id, blob)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;

    static KEYRING_INIT: Once = Once::new();

    fn use_mock_keyring() {
        KEYRING_INIT.call_once(|| {
            keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        });
    }

    #[test]
    fn checkpoint_round_trip_through_keyring() {
        use_mock_keyring();
        let plaintext = b"CREATE TABLE widgets (id integer primary key);";
        let blob = encrypt_checkpoint_payload("conn-1", plaintext).unwrap();
        assert!(blob.starts_with(MAGIC));
        assert_eq!(
            decrypt_checkpoint_payload("conn-1", &blob).unwrap(),
            plaintext
        );
    }

    #[test]
    fn legacy_plaintext_checkpoint_passes_through() {
        use_mock_keyring();
        let legacy = b"BEGIN;\nINSERT INTO t VALUES (1);\nCOMMIT;".to_vec();
        assert_eq!(
            decrypt_checkpoint_payload("conn-1", &legacy).unwrap(),
            legacy
        );
        // An empty blob is also "not TCK1" and must not error.
        assert_eq!(
            decrypt_checkpoint_payload("conn-1", &[]).unwrap(),
            Vec::<u8>::new()
        );
    }

    #[test]
    fn blob_from_another_connection_is_rejected() {
        use_mock_keyring();
        let blob = encrypt_checkpoint_payload("conn-a", b"connection A dump").unwrap();
        assert!(decrypt_checkpoint_payload("conn-b", &blob).is_err());
        assert_eq!(
            decrypt_checkpoint_payload("conn-a", &blob).unwrap(),
            b"connection A dump"
        );
    }

    #[test]
    fn tampered_or_truncated_blob_is_rejected() {
        use_mock_keyring();
        let blob = encrypt_checkpoint_payload("conn-1", b"payload").unwrap();
        // Magic but no nonce.
        assert!(decrypt_with_key(&[7u8; KEY_LEN], "conn-1", MAGIC).is_err());
        // Flip a ciphertext byte.
        let mut corrupted = blob.clone();
        let last = corrupted.len() - 1;
        corrupted[last] ^= 0xFF;
        assert!(decrypt_checkpoint_payload("conn-1", &corrupted).is_err());
        // Wrong key fails authentication.
        assert!(decrypt_with_key(&[9u8; KEY_LEN], "conn-1", &blob).is_err());
    }

    #[test]
    fn invalid_stored_key_is_an_error_not_silent_regeneration() {
        use_mock_keyring();
        assert!(decode_data_key("!!!not base64!!!").is_err());
        assert!(decode_data_key(&BASE64.encode([1u8; 16])).is_err());
        assert_eq!(
            decode_data_key(&BASE64.encode([1u8; KEY_LEN])).unwrap(),
            [1u8; KEY_LEN]
        );
    }
}
