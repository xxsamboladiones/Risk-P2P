use super::{bearer, internal, ApiError, AppState};
use axum::{
    extract::State,
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct P2pFriend {
    peer_id: String,
    display_name: String,
    public_key: Value,
    avatar: Option<String>,
    added_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct P2pGroup {
    group_id: String,
    name: String,
    avatar: Option<String>,
    channels: Value,
    members: Value,
    joined_at: i64,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/p2p/friends", get(list_friends).post(save_friend))
        .route("/p2p/groups", get(list_groups).post(save_group))
}

async fn list_friends(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<P2pFriend>>, ApiError> {
    let owner = bearer(&headers, &state)?;
    let rows = sqlx::query_as::<_, (String, String, String, Option<String>, i64)>(
        "SELECT peer_id,display_name,public_key_json,avatar,added_at FROM p2p_friends WHERE owner_user_id=? ORDER BY added_at",
    )
    .bind(owner)
    .fetch_all(&state.db)
    .await
    .map_err(internal)?;
    let mut result = Vec::with_capacity(rows.len());
    for (peer_id, display_name, public_key_json, avatar, added_at) in rows {
        let public_key = serde_json::from_str(&public_key_json)
            .map_err(|error| ApiError::Internal(error.into()))?;
        result.push(P2pFriend { peer_id, display_name, public_key, avatar, added_at });
    }
    Ok(Json(result))
}

async fn save_friend(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(friend): Json<P2pFriend>,
) -> Result<Json<P2pFriend>, ApiError> {
    let owner = bearer(&headers, &state)?;
    validate_peer(&friend.peer_id, &friend.display_name, &friend.public_key)?;
    if friend.added_at <= 0 {
        return Err(ApiError::Bad("Data da amizade inválida".into()));
    }
    let public_key_json = serde_json::to_string(&friend.public_key)
        .map_err(|error| ApiError::Internal(error.into()))?;
    sqlx::query(
        "INSERT INTO p2p_friends(owner_user_id,peer_id,display_name,public_key_json,avatar,added_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_user_id,peer_id) DO UPDATE SET display_name=excluded.display_name,public_key_json=excluded.public_key_json,avatar=excluded.avatar,added_at=excluded.added_at",
    )
    .bind(owner)
    .bind(&friend.peer_id)
    .bind(&friend.display_name)
    .bind(&public_key_json)
    .bind(&friend.avatar)
    .bind(friend.added_at)
    .execute(&state.db)
    .await
    .map_err(internal)?;
    Ok(Json(friend))
}

async fn list_groups(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<P2pGroup>>, ApiError> {
    let owner = bearer(&headers, &state)?;
    let rows = sqlx::query_as::<_, (String, String, Option<String>, String, String, i64)>(
        "SELECT group_id,name,avatar,channels_json,members_json,joined_at FROM p2p_groups WHERE owner_user_id=? ORDER BY joined_at",
    )
    .bind(owner)
    .fetch_all(&state.db)
    .await
    .map_err(internal)?;
    let mut result = Vec::with_capacity(rows.len());
    for (group_id, name, avatar, channels_json, members_json, joined_at) in rows {
        let channels = serde_json::from_str(&channels_json)
            .map_err(|error| ApiError::Internal(error.into()))?;
        let members = serde_json::from_str(&members_json)
            .map_err(|error| ApiError::Internal(error.into()))?;
        result.push(P2pGroup { group_id, name, avatar, channels, members, joined_at });
    }
    Ok(Json(result))
}

async fn save_group(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(group): Json<P2pGroup>,
) -> Result<Json<P2pGroup>, ApiError> {
    let owner = bearer(&headers, &state)?;
    if !valid_id(&group.group_id) || group.name.trim().is_empty() || group.name.chars().count() > 80 {
        return Err(ApiError::Bad("Grupo P2P inválido".into()));
    }
    let channels = group.channels.as_array().ok_or_else(|| ApiError::Bad("Canais P2P inválidos".into()))?;
    let members = group.members.as_array().ok_or_else(|| ApiError::Bad("Membros P2P inválidos".into()))?;
    if channels.len() > 100 || members.len() > 256 || group.joined_at <= 0 {
        return Err(ApiError::Bad("Metadados do grupo P2P excedem os limites".into()));
    }
    let channels_json = serde_json::to_string(&group.channels)
        .map_err(|error| ApiError::Internal(error.into()))?;
    let members_json = serde_json::to_string(&group.members)
        .map_err(|error| ApiError::Internal(error.into()))?;
    sqlx::query(
        "INSERT INTO p2p_groups(owner_user_id,group_id,name,avatar,channels_json,members_json,joined_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,group_id) DO UPDATE SET name=excluded.name,avatar=excluded.avatar,channels_json=excluded.channels_json,members_json=excluded.members_json,joined_at=excluded.joined_at",
    )
    .bind(owner)
    .bind(&group.group_id)
    .bind(group.name.trim())
    .bind(&group.avatar)
    .bind(channels_json)
    .bind(members_json)
    .bind(group.joined_at)
    .execute(&state.db)
    .await
    .map_err(internal)?;
    Ok(Json(group))
}

fn validate_peer(peer_id: &str, display_name: &str, public_key: &Value) -> Result<(), ApiError> {
    if !valid_id(peer_id)
        || display_name.trim().is_empty()
        || display_name.chars().count() > 80
        || !public_key.is_object()
    {
        return Err(ApiError::Bad("Identidade P2P inválida".into()));
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}
