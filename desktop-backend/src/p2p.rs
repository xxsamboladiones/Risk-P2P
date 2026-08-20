mod attachments;
mod screen_audio;

use super::{bearer, internal, ApiError, AppState};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct P2pMessage {
    id: String,
    channel_id: String,
    author: String,
    content: String,
    created_at: String,
    author_peer_id: Option<String>,
    signature: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/p2p/friends", get(list_friends).post(save_friend))
        .route("/p2p/friends/{peer_id}/delete", post(delete_p2p_friend))
        .route("/p2p/groups", get(list_groups).post(save_group))
        .route("/p2p/groups/{group_id}/delete", post(delete_p2p_group))
        .route("/friends/{friend_id}/remove", post(remove_friendship))
        .route("/communities/{community_id}/remove", post(remove_community))
        .route(
            "/p2p/messages/{channel_id}",
            get(list_messages).post(save_message),
        )
        .merge(attachments::router())
        .merge(screen_audio::router())
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
        result.push(P2pFriend {
            peer_id,
            display_name,
            public_key,
            avatar,
            added_at,
        });
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

async fn delete_p2p_friend(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(peer_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let owner = bearer(&headers, &state)?;
    if !valid_id(&peer_id) {
        return Err(ApiError::Bad("Amigo P2P inválido".into()));
    }
    sqlx::query("DELETE FROM p2p_friends WHERE owner_user_id=? AND peer_id=?")
        .bind(owner)
        .bind(peer_id)
        .execute(&state.db)
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
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
        result.push(P2pGroup {
            group_id,
            name,
            avatar,
            channels,
            members,
            joined_at,
        });
    }
    Ok(Json(result))
}

async fn save_group(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(group): Json<P2pGroup>,
) -> Result<Json<P2pGroup>, ApiError> {
    let owner = bearer(&headers, &state)?;
    if !valid_id(&group.group_id) || group.name.trim().is_empty() || group.name.chars().count() > 80
    {
        return Err(ApiError::Bad("Grupo P2P inválido".into()));
    }
    let channels = group
        .channels
        .as_array()
        .ok_or_else(|| ApiError::Bad("Canais P2P inválidos".into()))?;
    let members = group
        .members
        .as_array()
        .ok_or_else(|| ApiError::Bad("Membros P2P inválidos".into()))?;
    if channels.len() > 100 || members.len() > 256 || group.joined_at <= 0 {
        return Err(ApiError::Bad(
            "Metadados do grupo P2P excedem os limites".into(),
        ));
    }
    let channels_json =
        serde_json::to_string(&group.channels).map_err(|error| ApiError::Internal(error.into()))?;
    let members_json =
        serde_json::to_string(&group.members).map_err(|error| ApiError::Internal(error.into()))?;
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

async fn delete_p2p_group(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(group_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let owner = bearer(&headers, &state)?;
    if !valid_id(&group_id) {
        return Err(ApiError::Bad("Grupo P2P inválido".into()));
    }
    let channels_json = sqlx::query_scalar::<_, String>(
        "SELECT channels_json FROM p2p_groups WHERE owner_user_id=? AND group_id=?",
    )
    .bind(owner)
    .bind(&group_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal)?;

    let mut transaction = state.db.begin().await.map_err(internal)?;
    if let Some(channels_json) = channels_json {
        if let Ok(Value::Array(channels)) = serde_json::from_str::<Value>(&channels_json) {
            for channel in channels {
                let Some(channel_id) = channel.get("id").and_then(Value::as_str) else {
                    continue;
                };
                sqlx::query("DELETE FROM p2p_messages WHERE owner_user_id=? AND channel_id=?")
                    .bind(owner)
                    .bind(channel_id)
                    .execute(&mut *transaction)
                    .await
                    .map_err(internal)?;
            }
        }
    }
    sqlx::query("DELETE FROM p2p_groups WHERE owner_user_id=? AND group_id=?")
        .bind(owner)
        .bind(group_id)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    transaction.commit().await.map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

async fn remove_friendship(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(friend_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state)?;
    if friend_id == user {
        return Err(ApiError::Bad("Amizade inválida".into()));
    }
    let mut transaction = state.db.begin().await.map_err(internal)?;
    sqlx::query(
        "DELETE FROM friendships WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)",
    )
    .bind(user)
    .bind(friend_id)
    .bind(friend_id)
    .bind(user)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;
    sqlx::query(
        "DELETE FROM friend_requests WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)",
    )
    .bind(user)
    .bind(friend_id)
    .bind(friend_id)
    .bind(user)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;
    transaction.commit().await.map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

async fn remove_community(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(community_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state)?;
    let owner = sqlx::query_scalar::<_, Uuid>("SELECT owner_id FROM communities WHERE id=?")
        .bind(community_id)
        .fetch_optional(&state.db)
        .await
        .map_err(internal)?;
    let Some(owner) = owner else {
        return Ok(Json(json!({ "ok": true, "action": "missing" })));
    };

    if owner != user {
        sqlx::query("DELETE FROM community_members WHERE community_id=? AND user_id=?")
            .bind(community_id)
            .bind(user)
            .execute(&state.db)
            .await
            .map_err(internal)?;
        return Ok(Json(json!({ "ok": true, "action": "left" })));
    }

    let room_ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT voice_room_id FROM channels WHERE community_id=? AND voice_room_id IS NOT NULL",
    )
    .bind(community_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal)?;
    let mut transaction = state.db.begin().await.map_err(internal)?;
    sqlx::query("DELETE FROM communities WHERE id=? AND owner_id=?")
        .bind(community_id)
        .bind(user)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    for room_id in room_ids {
        sqlx::query("DELETE FROM rooms WHERE id=? AND owner_id=?")
            .bind(room_id)
            .bind(user)
            .execute(&mut *transaction)
            .await
            .map_err(internal)?;
    }
    transaction.commit().await.map_err(internal)?;
    Ok(Json(json!({ "ok": true, "action": "deleted" })))
}

async fn list_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
) -> Result<Json<Vec<P2pMessage>>, ApiError> {
    let owner = bearer(&headers, &state)?;
    if !valid_id(&channel_id) {
        return Err(ApiError::Bad("Canal P2P inválido".into()));
    }
    let rows = sqlx::query_as::<_, (String, String, String, String, Option<String>, Option<String>)>(
        "SELECT id,author,content,created_at,author_peer_id,signature FROM p2p_messages WHERE owner_user_id=? AND channel_id=? ORDER BY created_at DESC LIMIT 200",
    )
    .bind(owner)
    .bind(&channel_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal)?;
    Ok(Json(
        rows.into_iter()
            .rev()
            .map(|(id, author, content, created_at, author_peer_id, signature)| P2pMessage {
                id,
                channel_id: channel_id.clone(),
                author,
                content,
                created_at,
                author_peer_id,
                signature,
            })
            .collect(),
    ))
}

async fn save_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
    Json(message): Json<P2pMessage>,
) -> Result<Json<P2pMessage>, ApiError> {
    let owner = bearer(&headers, &state)?;
    let signed_metadata_valid = match (&message.author_peer_id, &message.signature) {
        (None, None) => true,
        (Some(peer_id), Some(signature)) => {
            valid_id(peer_id)
                && (16..=256).contains(&signature.len())
                && signature
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        }
        _ => false,
    };
    if channel_id != message.channel_id
        || !valid_id(&channel_id)
        || !valid_id(&message.id)
        || message.author.trim().is_empty()
        || message.author.chars().count() > 80
        || message.content.trim().is_empty()
        || message.content.chars().count() > 4_000
        || chrono::DateTime::parse_from_rfc3339(&message.created_at).is_err()
        || !signed_metadata_valid
    {
        return Err(ApiError::Bad("Mensagem P2P inválida".into()));
    }
    sqlx::query(
        "INSERT OR IGNORE INTO p2p_messages(owner_user_id,channel_id,id,author,content,created_at,author_peer_id,signature) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(owner)
    .bind(&message.channel_id)
    .bind(&message.id)
    .bind(&message.author)
    .bind(&message.content)
    .bind(&message.created_at)
    .bind(&message.author_peer_id)
    .bind(&message.signature)
    .execute(&state.db)
    .await
    .map_err(internal)?;
    Ok(Json(message))
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
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}
