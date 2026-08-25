use super::super::{ApiError, AppState, MAX_ATTACHMENT_CHUNK_BYTES};
use axum::{
    body::{Body, Bytes},
    extract::Path,
    http::{header, HeaderValue, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{env, path::PathBuf};
use tokio::{
    fs::{self, File, OpenOptions},
    io::AsyncWriteExt,
};
use tokio_util::io::ReaderStream;

const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const DEFAULT_ATTACHMENT_QUOTA_BYTES: u64 = 50 * 1024 * 1024 * 1024;
const STALE_TRANSFER_AGE_SECS: u64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentDiskManifest {
    attachment_id: String,
    filename: String,
    mime_type: String,
    size: u64,
    chunk_size: u64,
    chunk_count: u64,
    content_hash: String,
}

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/p2p/attachments/{transfer_id}/prepare", post(prepare))
        .route(
            "/p2p/attachments/{transfer_id}/chunks/{index}",
            get(has_chunk).post(write_chunk),
        )
        .route("/p2p/attachments/{transfer_id}/finalize", post(finalize))
        .route("/p2p/attachments/{transfer_id}/discard", post(discard))
        .route("/p2p/attachments/content/{attachment_id}", get(content))
}

async fn prepare(
    Path(transfer_id): Path<String>,
    Json(manifest): Json<AttachmentDiskManifest>,
) -> Result<Json<Value>, ApiError> {
    validate_transfer_id(&transfer_id)?;
    validate_manifest(&manifest)?;
    let directory = transfer_dir(&transfer_id)?;
    if fs::try_exists(&directory).await.map_err(internal)? {
        if read_transfer_manifest(&transfer_id).await? != manifest {
            return Err(ApiError::Bad(
                "O manifesto não corresponde à transferência já iniciada".into(),
            ));
        }
    } else {
        let quota = env::var("RISK_ATTACHMENT_QUOTA_BYTES")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_ATTACHMENT_QUOTA_BYTES);
        let used = directory_size(&attachment_root()?).await?;
        if used.saturating_add(manifest.size) > quota {
            return Err(ApiError::Bad(
                "O armazenamento de anexos atingiu a quota configurada".into(),
            ));
        }
    }
    fs::create_dir_all(&directory).await.map_err(internal)?;
    let encoded = serde_json::to_vec(&manifest).map_err(internal)?;
    fs::write(directory.join("manifest.json"), encoded)
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "prepared": true })))
}

async fn has_chunk(
    Path((transfer_id, index)): Path<(String, u64)>,
) -> Result<Json<Value>, ApiError> {
    validate_transfer_id(&transfer_id)?;
    let manifest = read_transfer_manifest(&transfer_id).await?;
    if index >= manifest.chunk_count {
        return Err(ApiError::Bad("Índice de chunk inválido".into()));
    }
    let exists = fs::try_exists(transfer_dir(&transfer_id)?.join(format!("{index}.part")))
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "exists": exists })))
}

async fn write_chunk(
    Path((transfer_id, index)): Path<(String, u64)>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    validate_transfer_id(&transfer_id)?;
    let manifest = read_transfer_manifest(&transfer_id).await?;
    if index >= manifest.chunk_count {
        return Err(ApiError::Bad("Índice de chunk inválido".into()));
    }
    let expected = expected_chunk_size(&manifest, index)?;
    if body.len() != expected || body.len() > MAX_ATTACHMENT_CHUNK_BYTES {
        return Err(ApiError::Bad("Tamanho do chunk inválido".into()));
    }
    let directory = transfer_dir(&transfer_id)?;
    let target = directory.join(format!("{index}.part"));
    let temporary = directory.join(format!("{index}.part.tmp"));
    fs::write(&temporary, &body).await.map_err(internal)?;
    fs::rename(&temporary, &target).await.map_err(internal)?;
    Ok(Json(json!({ "stored": true, "bytes": body.len() })))
}

async fn finalize(Path(transfer_id): Path<String>) -> Result<Json<Value>, ApiError> {
    validate_transfer_id(&transfer_id)?;
    let manifest = read_transfer_manifest(&transfer_id).await?;
    let destination_directory = content_dir(&manifest.attachment_id)?;
    fs::create_dir_all(&destination_directory)
        .await
        .map_err(internal)?;
    let filename = sanitize_filename(&manifest.filename);
    let final_path = destination_directory.join(&filename);
    let temporary_path = destination_directory.join(format!(".{filename}.risk-part"));
    let mut output = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary_path)
        .await
        .map_err(internal)?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let transfer_directory = transfer_dir(&transfer_id)?;

    for index in 0..manifest.chunk_count {
        let chunk = fs::read(transfer_directory.join(format!("{index}.part")))
            .await
            .map_err(|_| ApiError::Bad(format!("Chunk {index} ausente")))?;
        if chunk.len() != expected_chunk_size(&manifest, index)? {
            return Err(ApiError::Bad(format!(
                "Chunk {index} possui tamanho inválido"
            )));
        }
        total = total
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| ApiError::Bad("Tamanho final inválido".into()))?;
        hasher.update(&chunk);
        output.write_all(&chunk).await.map_err(internal)?;
    }
    output.flush().await.map_err(internal)?;
    output.sync_data().await.map_err(internal)?;
    drop(output);

    if total != manifest.size {
        let _ = fs::remove_file(&temporary_path).await;
        return Err(ApiError::Bad("Tamanho final do arquivo não confere".into()));
    }
    let content_hash = format!("{:x}", hasher.finalize());
    if !content_hash.eq_ignore_ascii_case(&manifest.content_hash) {
        let _ = fs::remove_file(&temporary_path).await;
        return Err(ApiError::Bad("SHA-256 final do arquivo não confere".into()));
    }

    if fs::try_exists(&final_path).await.map_err(internal)? {
        fs::remove_file(&final_path).await.map_err(internal)?;
    }
    fs::rename(&temporary_path, &final_path)
        .await
        .map_err(internal)?;
    fs::write(
        destination_directory.join("manifest.json"),
        serde_json::to_vec(&manifest).map_err(internal)?,
    )
    .await
    .map_err(internal)?;
    let _ = fs::remove_dir_all(&transfer_directory).await;
    Ok(Json(json!({ "contentHash": content_hash, "bytes": total })))
}

async fn discard(Path(transfer_id): Path<String>) -> Result<StatusCode, ApiError> {
    validate_transfer_id(&transfer_id)?;
    let directory = transfer_dir(&transfer_id)?;
    if fs::try_exists(&directory).await.map_err(internal)? {
        fs::remove_dir_all(directory).await.map_err(internal)?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn content(Path(attachment_id): Path<String>) -> Result<Response, ApiError> {
    validate_attachment_id(&attachment_id)?;
    let directory = content_dir(&attachment_id)?;
    let encoded = fs::read(directory.join("manifest.json"))
        .await
        .map_err(|_| ApiError::Bad("Anexo não encontrado".into()))?;
    let manifest: AttachmentDiskManifest = serde_json::from_slice(&encoded).map_err(internal)?;
    validate_manifest(&manifest)?;
    let filename = sanitize_filename(&manifest.filename);
    let file = File::open(directory.join(filename))
        .await
        .map_err(internal)?;
    let mut builder = Response::builder().status(StatusCode::OK);
    if let Ok(value) = HeaderValue::from_str(&manifest.mime_type) {
        builder = builder.header(header::CONTENT_TYPE, value);
    } else {
        builder = builder.header(header::CONTENT_TYPE, "application/octet-stream");
    }
    builder = builder
        .header(header::CONTENT_LENGTH, manifest.size.to_string())
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store");
    builder
        .body(Body::from_stream(ReaderStream::new(file)))
        .map_err(|error| ApiError::Internal(error.into()))
}

async fn read_transfer_manifest(transfer_id: &str) -> Result<AttachmentDiskManifest, ApiError> {
    let bytes = fs::read(transfer_dir(transfer_id)?.join("manifest.json"))
        .await
        .map_err(|_| ApiError::Bad("Transferência não preparada".into()))?;
    let manifest: AttachmentDiskManifest = serde_json::from_slice(&bytes).map_err(internal)?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn expected_chunk_size(manifest: &AttachmentDiskManifest, index: u64) -> Result<usize, ApiError> {
    let offset = index
        .checked_mul(manifest.chunk_size)
        .ok_or_else(|| ApiError::Bad("Offset de chunk inválido".into()))?;
    let remaining = manifest.size.saturating_sub(offset);
    usize::try_from(remaining.min(manifest.chunk_size))
        .map_err(|_| ApiError::Bad("Chunk grande demais".into()))
}

fn validate_manifest(manifest: &AttachmentDiskManifest) -> Result<(), ApiError> {
    validate_attachment_id(&manifest.attachment_id)?;
    if manifest.filename.trim().is_empty()
        || manifest.filename.chars().count() > 255
        || manifest.mime_type.len() > 127
        || manifest.size > MAX_ATTACHMENT_BYTES
        || manifest.chunk_size == 0
        || manifest.chunk_size as usize > MAX_ATTACHMENT_CHUNK_BYTES
        || manifest.chunk_count != manifest.size.div_ceil(manifest.chunk_size)
        || !is_sha256(&manifest.content_hash)
        || !manifest
            .attachment_id
            .eq_ignore_ascii_case(&manifest.content_hash)
    {
        return Err(ApiError::Bad("Manifesto de anexo inválido".into()));
    }
    Ok(())
}

fn validate_transfer_id(value: &str) -> Result<(), ApiError> {
    if !(8..=128).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ApiError::Bad("ID de transferência inválido".into()));
    }
    Ok(())
}

fn validate_attachment_id(value: &str) -> Result<(), ApiError> {
    if !is_sha256(value) {
        return Err(ApiError::Bad("ID de anexo inválido".into()));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sanitize_filename(value: &str) -> String {
    let candidate = value
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or("attachment")
        .trim()
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    if candidate.is_empty() || candidate.chars().all(|character| character == '.') {
        "attachment".into()
    } else {
        candidate.chars().take(255).collect()
    }
}

fn attachment_root() -> Result<PathBuf, ApiError> {
    let data_dir = env::var_os("RISK_DATA_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| ApiError::Bad("RISK_DATA_DIR não configurado".into()))?;
    Ok(data_dir.join("attachments"))
}

fn transfer_dir(transfer_id: &str) -> Result<PathBuf, ApiError> {
    validate_transfer_id(transfer_id)?;
    Ok(attachment_root()?.join("transfers").join(transfer_id))
}

fn content_dir(attachment_id: &str) -> Result<PathBuf, ApiError> {
    validate_attachment_id(attachment_id)?;
    Ok(attachment_root()?.join("content").join(attachment_id))
}

fn internal(error: impl Into<anyhow::Error>) -> ApiError {
    ApiError::Internal(error.into())
}

async fn directory_size(root: &std::path::Path) -> Result<u64, ApiError> {
    if !fs::try_exists(root).await.map_err(internal)? {
        return Ok(0);
    }
    let mut pending = vec![root.to_path_buf()];
    let mut total = 0_u64;
    while let Some(directory) = pending.pop() {
        let mut entries = fs::read_dir(directory).await.map_err(internal)?;
        while let Some(entry) = entries.next_entry().await.map_err(internal)? {
            let metadata = entry.metadata().await.map_err(internal)?;
            if metadata.is_dir() {
                pending.push(entry.path());
            } else {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

pub(crate) async fn cleanup_stale_transfers() {
    let Ok(root) = attachment_root().map(|path| path.join("transfers")) else {
        return;
    };
    let Ok(mut entries) = fs::read_dir(root).await else {
        return;
    };
    let now = std::time::SystemTime::now();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age.as_secs() > STALE_TRANSFER_AGE_SECS);
        if metadata.is_dir() && stale {
            let _ = fs::remove_dir_all(entry.path()).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(chunk_size: u64) -> AttachmentDiskManifest {
        AttachmentDiskManifest {
            attachment_id: "a".repeat(64),
            filename: "foto.png".into(),
            mime_type: "image/png".into(),
            size: chunk_size,
            chunk_size,
            chunk_count: 1,
            content_hash: "a".repeat(64),
        }
    }

    #[test]
    fn validates_the_same_maximum_chunk_size_as_the_http_layer() {
        assert!(validate_manifest(&manifest(MAX_ATTACHMENT_CHUNK_BYTES as u64)).is_ok());
        assert!(validate_manifest(&manifest(MAX_ATTACHMENT_CHUNK_BYTES as u64 + 1)).is_err());
    }

    #[test]
    fn sanitizes_paths_and_windows_unsafe_characters() {
        assert_eq!(sanitize_filename("../pasta/foto?.png"), "foto_.png");
        assert_eq!(sanitize_filename("..."), "attachment");
    }
}
