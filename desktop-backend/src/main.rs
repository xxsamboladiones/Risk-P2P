mod p2p;

use anyhow::Context;
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{Path, Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::Utc;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    SqlitePool,
};
use std::{env, path::PathBuf, time::Duration};
use tokio::io::AsyncReadExt;
use tower_http::{cors::CorsLayer, limit::RequestBodyLimitLayer, trace::TraceLayer};
use uuid::Uuid;

const LOCAL_TOKEN_HEADER: &str = "x-risk-desktop-token";
const ACCESS_TOKEN_TTL_SECONDS: i64 = 12 * 60 * 60;

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
    local_token: String,
    jwt_secret: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: Uuid,
    exp: usize,
    kind: String,
}

#[derive(Debug, thiserror::Error)]
enum ApiError {
    #[error("{0}")]
    Bad(String),
    #[error("Não autorizado")]
    Unauthorized,
    #[error("{0}")]
    Conflict(String),
    #[error("Erro interno")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if let Self::Internal(error) = &self {
            tracing::error!(error = %error, "desktop backend internal error");
        }
        let status = match &self {
            Self::Bad(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(json!({ "message": self.to_string() }))).into_response()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterInput {
    display_name: String,
    email: String,
    password: String,
}

#[derive(Deserialize)]
struct LoginInput {
    email: String,
    password: String,
}

#[derive(Deserialize)]
struct FriendRequestInput {
    email: String,
}

#[derive(Deserialize)]
struct NewCommunity {
    name: String,
}

#[derive(Deserialize)]
struct NewChannel {
    name: String,
    kind: String,
}

#[derive(Deserialize)]
struct NewRoom {
    name: String,
}

#[derive(Deserialize)]
struct NewMessage {
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "risk_desktop_backend=info,tower_http=warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let local_token = env::var("RISK_LOCAL_TOKEN")
        .context("RISK_LOCAL_TOKEN precisa ser fornecido pelo Electron")?;
    if local_token.len() < 32 {
        anyhow::bail!("RISK_LOCAL_TOKEN precisa ter pelo menos 32 caracteres");
    }

    let data_dir = env::var_os("RISK_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("risk-data"));
    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("não foi possível criar {}", data_dir.display()))?;
    let db_path = data_dir.join("risk.sqlite3");
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));
    let db = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;
    sqlx::migrate!("./migrations").run(&db).await?;

    let mut secret_bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut secret_bytes);
    let state = AppState {
        db,
        local_token,
        jwt_secret: URL_SAFE_NO_PAD.encode(secret_bytes),
    };

    let protected = Router::new()
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/auth/refresh", post(refresh))
        .route("/auth/logout", post(logout))
        .route("/me", get(me))
        .route("/friends", get(list_friends))
        .route("/friends/requests", post(send_friend_request))
        .route("/friends/requests/{id}/accept", post(accept_friend_request))
        .route("/communities", get(list_communities).post(create_community))
        .route(
            "/communities/{id}/channels",
            get(list_channels).post(create_channel),
        )
        .route(
            "/channels/{id}/messages",
            get(list_messages).post(create_message),
        )
        .route("/rooms", post(create_room))
        .route("/rtc/credentials", get(rtc_credentials))
        .merge(p2p::router())
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            local_token_guard,
        ));

    let web_origin = env::var("RISK_WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".into());
    let app = Router::new()
        .route("/health", get(health))
        .merge(protected)
        .layer(RequestBodyLimitLayer::new(64 * 1024))
        .layer(
            CorsLayer::new()
                .allow_origin(web_origin.parse::<HeaderValue>()?)
                .allow_headers([
                    header::CONTENT_TYPE,
                    header::AUTHORIZATION,
                    HeaderName::from_static(LOCAL_TOKEN_HEADER),
                ])
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS]),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let bind = env::var("RISK_BACKEND_BIND").unwrap_or_else(|_| "127.0.0.1:0".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    let address = listener.local_addr()?;
    println!(
        "RISK_BACKEND_READY {}",
        serde_json::to_string(&json!({ "url": format!("http://{}", address) }))?
    );
    use std::io::Write;
    std::io::stdout().flush()?;
    tracing::info!(%address, database = %db_path.display(), "desktop backend ready");

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let mut input = tokio::io::stdin();
        let mut buffer = Vec::new();
        let _ = input.read_to_end(&mut buffer).await;
        let _ = shutdown_tx.send(());
    });
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .await?;
    Ok(())
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "mode": "desktop-local", "storage": "sqlite" }))
}

async fn local_token_guard(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = headers
        .get(LOCAL_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok());
    if token != Some(state.local_token.as_str()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(request).await)
}

async fn register(
    State(state): State<AppState>,
    Json(input): Json<RegisterInput>,
) -> Result<Json<TokenResponse>, ApiError> {
    let display_name = input.display_name.trim();
    validate_name(display_name, 80, "Nome inválido")?;
    validate_password(&input.password)?;
    let email = normalize_email(&input.email)?;
    let salt = SaltString::generate(&mut OsRng);
    let password_hash = Argon2::default()
        .hash_password(input.password.as_bytes(), &salt)
        .map_err(|error| ApiError::Internal(anyhow::anyhow!(error.to_string())))?
        .to_string();
    let user_id = Uuid::new_v4();
    let now = now_seconds();
    sqlx::query(
        "INSERT INTO users(id,display_name,email,password_hash,created_at) VALUES(?,?,?,?,?)",
    )
    .bind(user_id)
    .bind(display_name)
    .bind(&email)
    .bind(password_hash)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(map_unique("Este e-mail já está cadastrado"))?;
    set_current_user(&state.db, user_id).await?;
    Ok(Json(TokenResponse {
        access_token: issue(&state, user_id)?,
    }))
}

async fn login(
    State(state): State<AppState>,
    Json(input): Json<LoginInput>,
) -> Result<Json<TokenResponse>, ApiError> {
    let email = normalize_email(&input.email)?;
    let user = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id,password_hash FROM users WHERE email=? COLLATE NOCASE",
    )
    .bind(email)
    .fetch_optional(&state.db)
    .await
    .map_err(internal)?
    .ok_or(ApiError::Unauthorized)?;
    Argon2::default()
        .verify_password(
            input.password.as_bytes(),
            &PasswordHash::new(&user.1).map_err(|_| ApiError::Unauthorized)?,
        )
        .map_err(|_| ApiError::Unauthorized)?;
    set_current_user(&state.db, user.0).await?;
    Ok(Json(TokenResponse {
        access_token: issue(&state, user.0)?,
    }))
}

async fn refresh(State(state): State<AppState>) -> Result<Json<TokenResponse>, ApiError> {
    let user_id = current_user(&state.db)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    let exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE id=?)")
        .bind(user_id)
        .fetch_one(&state.db)
        .await
        .map_err(internal)?;
    if !exists {
        clear_current_user(&state.db).await?;
        return Err(ApiError::Unauthorized);
    }
    Ok(Json(TokenResponse {
        access_token: issue(&state, user_id)?,
    }))
}

async fn logout(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    clear_current_user(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let user_id = bearer(&headers, &state)?;
    let row = sqlx::query_as::<_, (Uuid, String, String)>(
        "SELECT id,display_name,email FROM users WHERE id=?",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal)?
    .ok_or(ApiError::Unauthorized)?;
    Ok(Json(
        json!({ "id": row.0, "displayName": row.1, "email": row.2 }),
    ))
}

async fn list_friends(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state)?;
    let friends = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT u.id,u.display_name FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_a=? THEN f.user_b ELSE f.user_a END WHERE f.user_a=? OR f.user_b=? ORDER BY lower(u.display_name)",
    )
    .bind(user)
    .bind(user)
    .bind(user)
    .fetch_all(&state.db)
    .await
    .map_err(internal)?;
    let pending = sqlx::query_as::<_, (Uuid, Uuid, String)>(
        "SELECT r.id,u.id,u.display_name FROM friend_requests r JOIN users u ON u.id=r.sender_id WHERE r.recipient_id=? AND r.status='pending' ORDER BY r.created_at DESC",
    )
    .bind(user)
    .fetch_all(&state.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({
        "friends": friends.into_iter().map(|(id, display_name)| json!({"id": id,"displayName": display_name})).collect::<Vec<_>>(),
        "pending": pending.into_iter().map(|(request_id, id, display_name)| json!({"requestId": request_id,"id": id,"displayName": display_name})).collect::<Vec<_>>()
    })))
}

async fn send_friend_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<FriendRequestInput>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state)?;
    let email = normalize_email(&input.email)?;
    let recipient = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM users WHERE email=? COLLATE NOCASE",
    )
    .bind(email)
    .fetch_optional(&state.db)
    .await
    .map_err(internal)?
    .ok_or_else(|| {
        ApiError::Bad(
            "Usuário local não encontrado. Para outro dispositivo, use convite P2P por código."
                .into(),
        )
    })?;
    if recipient == user {
        return Err(ApiError::Bad("Você não pode adicionar a si mesmo".into()));
    }
    let (a, b) = canonical_pair(user, recipient);
    let already = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM friendships WHERE user_a=? AND user_b=?)",
    )
    .bind(a)
    .bind(b)
    .fetch_one(&state.db)
    .await
    .map_err(internal)?;
    if already {
        return Err(ApiError::Conflict("Vocês já são amigos".into()));
    }
    sqlx::query(
        "INSERT INTO friend_requests(id,sender_id,recipient_id,status,created_at) VALUES(?,?,?,'pending',?) ON CONFLICT(sender_id,recipient_id) DO UPDATE SET status='pending',created_at=excluded.created_at",
    )
    .bind(Uuid::new_v4())
    .bind(user)
    .bind(recipient)
    .bind(now_seconds())
    .execute(&state.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

async fn accept_friend_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state)?;
    let mut transaction = state.db.begin().await.map_err(internal)?;
    let sender = sqlx::query_scalar::<_, Uuid>(
        "SELECT sender_id FROM friend_requests WHERE id=? AND recipient_id=? AND status='pending'",
    )
    .bind(id)
    .bind(user)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(internal)?
    .ok_or(ApiError::Unauthorized)?;
    let (a, b) = canonical_pair(user, sender);
    sqlx::query("INSERT OR IGNORE INTO friendships(user_a,user_b,created_at) VALUES(?,?,?)")
        .bind(a)
        .bind(b)
        .bind(now_seconds())
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    sqlx::query(
        "UPDATE friend_requests SET status='accepted' WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)",
    )
    .bind(user)
    .bind(sender)
    .bind(sender)
    .bind(user)
    .execute(&mut *transaction)
    .await
    .map_err(internal)?;
    transaction.commit().await.map_err(internal)?;
    Ok(Json(json!({ "ok": true })))
}

async fn list_communities(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state)?;
    let rows = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT c.id,c.name FROM communities c JOIN community_members m ON m.community_id=c.id WHERE m.user_id=? ORDER BY c.created_at",
    )
    .bind(user)
    .fetch_all(&state.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .into_iter()
        .map(|(id, name)| json!({ "id": id, "name": name }))
        .collect::<Vec<_>>())))
}

async fn create_community(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<NewCommunity>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state)?;
    let name = input.name.trim();
    validate_name(name, 100, "Nome do grupo inválido")?;
    let now = now_seconds();
    let community_id = Uuid::new_v4();
    let text_channel_id = Uuid::new_v4();
    let voice_channel_id = Uuid::new_v4();
    let room_id = Uuid::new_v4();
    let mut transaction = state.db.begin().await.map_err(internal)?;
    sqlx::query("INSERT INTO communities(id,name,owner_id,created_at) VALUES(?,?,?,?)")
        .bind(community_id)
        .bind(name)
        .bind(user)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO community_members(community_id,user_id,joined_at) VALUES(?,?,?)")
        .bind(community_id)
        .bind(user)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO rooms(id,name,owner_id,created_at) VALUES(?,?,?,?)")
        .bind(room_id)
        .bind("Geral")
        .bind(user)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO room_members(room_id,user_id,joined_at) VALUES(?,?,?)")
        .bind(room_id)
        .bind(user)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO channels(id,community_id,name,kind,voice_room_id,position,created_at) VALUES(?,?,?,'text',NULL,0,?)")
        .bind(text_channel_id)
        .bind(community_id)
        .bind("geral")
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO channels(id,community_id,name,kind,voice_room_id,position,created_at) VALUES(?,?,?,'voice',?,1,?)")
        .bind(voice_channel_id)
        .bind(community_id)
        .bind("Geral")
        .bind(room_id)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    transaction.commit().await.map_err(internal)?;
    Ok(Json(json!({ "id": community_id, "name": name })))
}

async fn list_channels(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(community_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state)?;
    require_member(&state.db, community_id, user).await?;
    let rows = sqlx::query_as::<_, (Uuid, String, String, Option<Uuid>)>(
        "SELECT id,name,kind,voice_room_id FROM channels WHERE community_id=? ORDER BY position,created_at",
    )
    .bind(community_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .into_iter()
        .map(|(id, name, kind, voice_room_id)| json!({
            "id": id, "name": name, "kind": kind, "voiceRoomId": voice_room_id
        }))
        .collect::<Vec<_>>())))
}

async fn create_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(community_id): Path<Uuid>,
    Json(input): Json<NewChannel>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state)?;
    require_member(&state.db, community_id, user).await?;
    let name = input.name.trim();
    validate_name(name, 80, "Nome do canal inválido")?;
    if !matches!(input.kind.as_str(), "text" | "voice") {
        return Err(ApiError::Bad("Tipo de canal inválido".into()));
    }
    let now = now_seconds();
    let channel_id = Uuid::new_v4();
    let mut transaction = state.db.begin().await.map_err(internal)?;
    let voice_room_id = if input.kind == "voice" {
        let room_id = Uuid::new_v4();
        sqlx::query("INSERT INTO rooms(id,name,owner_id,created_at) VALUES(?,?,?,?)")
            .bind(room_id)
            .bind(name)
            .bind(user)
            .bind(now)
            .execute(&mut *transaction)
            .await
            .map_err(internal)?;
        sqlx::query("INSERT OR IGNORE INTO room_members(room_id,user_id,joined_at) SELECT ?,user_id,? FROM community_members WHERE community_id=?")
            .bind(room_id)
            .bind(now)
            .bind(community_id)
            .execute(&mut *transaction)
            .await
            .map_err(internal)?;
        Some(room_id)
    } else {
        None
    };
    let position = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM channels WHERE community_id=?",
    )
    .bind(community_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(internal)?;
    sqlx::query("INSERT INTO channels(id,community_id,name,kind,voice_room_id,position,created_at) VALUES(?,?,?,?,?,?,?)")
        .bind(channel_id)
        .bind(community_id)
        .bind(name)
        .bind(&input.kind)
        .bind(voice_room_id)
        .bind(position)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    transaction.commit().await.map_err(internal)?;
    Ok(Json(
        json!({ "id": channel_id, "name": name, "kind": input.kind, "voiceRoomId": voice_room_id }),
    ))
}

async fn list_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state)?;
    let community_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT community_id FROM channels WHERE id=? AND kind='text'",
    )
    .bind(channel_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal)?
    .ok_or_else(|| ApiError::Bad("Canal não encontrado".into()))?;
    require_member(&state.db, community_id, user).await?;
    let rows = sqlx::query_as::<_, (Uuid, String, String, i64)>(
        "SELECT m.id,u.display_name,m.content,m.created_at FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=? ORDER BY m.created_at DESC LIMIT 100",
    )
    .bind(channel_id)
    .fetch_all(&state.db)
    .await
    .map_err(internal)?;
    Ok(Json(json!(rows
        .into_iter()
        .rev()
        .map(|(id, author, content, created_at)| json!({
            "id": id, "author": author, "content": content, "createdAt": iso_timestamp(created_at)
        }))
        .collect::<Vec<_>>())))
}

async fn create_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<Uuid>,
    Json(input): Json<NewMessage>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state)?;
    let community_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT community_id FROM channels WHERE id=? AND kind='text'",
    )
    .bind(channel_id)
    .fetch_optional(&state.db)
    .await
    .map_err(internal)?
    .ok_or_else(|| ApiError::Bad("Canal não encontrado".into()))?;
    require_member(&state.db, community_id, user).await?;
    let content = input.content.trim();
    if content.is_empty() || content.chars().count() > 4_000 {
        return Err(ApiError::Bad("Mensagem inválida".into()));
    }
    let id = Uuid::new_v4();
    let created_at = now_seconds();
    sqlx::query(
        "INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES(?,?,?,?,?)",
    )
    .bind(id)
    .bind(channel_id)
    .bind(user)
    .bind(content)
    .bind(created_at)
    .execute(&state.db)
    .await
    .map_err(internal)?;
    let author = sqlx::query_scalar::<_, String>("SELECT display_name FROM users WHERE id=?")
        .bind(user)
        .fetch_one(&state.db)
        .await
        .map_err(internal)?;
    Ok(Json(
        json!({ "id": id, "author": author, "content": content, "createdAt": iso_timestamp(created_at) }),
    ))
}

async fn create_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<NewRoom>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state)?;
    let name = input.name.trim();
    validate_name(name, 100, "Nome da sala inválido")?;
    let room_id = Uuid::new_v4();
    let now = now_seconds();
    let mut transaction = state.db.begin().await.map_err(internal)?;
    sqlx::query("INSERT INTO rooms(id,name,owner_id,created_at) VALUES(?,?,?,?)")
        .bind(room_id)
        .bind(name)
        .bind(user)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO room_members(room_id,user_id,joined_at) VALUES(?,?,?)")
        .bind(room_id)
        .bind(user)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(internal)?;
    transaction.commit().await.map_err(internal)?;
    Ok(Json(json!({ "id": room_id })))
}

async fn rtc_credentials() -> (StatusCode, Json<Value>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "message": "Credenciais TURN não ficam embutidas no backend local. O cliente usará a configuração ICE pública/fallback."
        })),
    )
}

async fn require_member(db: &SqlitePool, community: Uuid, user: Uuid) -> Result<(), ApiError> {
    let allowed = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM community_members WHERE community_id=? AND user_id=?)",
    )
    .bind(community)
    .bind(user)
    .fetch_one(db)
    .await
    .map_err(internal)?;
    if allowed {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

fn issue(state: &AppState, user_id: Uuid) -> Result<String, ApiError> {
    encode(
        &Header::default(),
        &Claims {
            sub: user_id,
            exp: (Utc::now().timestamp() + ACCESS_TOKEN_TTL_SECONDS) as usize,
            kind: "access".into(),
        },
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    )
    .map_err(|error| ApiError::Internal(error.into()))
}

fn bearer(headers: &HeaderMap, state: &AppState) -> Result<Uuid, ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized)?;
    let claims = decode::<Claims>(
        token,
        &DecodingKey::from_secret(state.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| ApiError::Unauthorized)?
    .claims;
    if claims.kind != "access" {
        return Err(ApiError::Unauthorized);
    }
    Ok(claims.sub)
}

async fn set_current_user(db: &SqlitePool, user_id: Uuid) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO app_state(key,value) VALUES('current_user_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(user_id.to_string())
        .execute(db)
        .await
        .map_err(internal)?;
    Ok(())
}

async fn current_user(db: &SqlitePool) -> Result<Option<Uuid>, ApiError> {
    let value =
        sqlx::query_scalar::<_, String>("SELECT value FROM app_state WHERE key='current_user_id'")
            .fetch_optional(db)
            .await
            .map_err(internal)?;
    Ok(value.and_then(|value| Uuid::parse_str(&value).ok()))
}

async fn clear_current_user(db: &SqlitePool) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM app_state WHERE key='current_user_id'")
        .execute(db)
        .await
        .map_err(internal)?;
    Ok(())
}

fn canonical_pair(left: Uuid, right: Uuid) -> (Uuid, Uuid) {
    if left.as_bytes() <= right.as_bytes() {
        (left, right)
    } else {
        (right, left)
    }
}

fn normalize_email(value: &str) -> Result<String, ApiError> {
    let email = value.trim().to_lowercase();
    let length = email.chars().count();
    if !(3..=320).contains(&length)
        || !email.contains('@')
        || email.chars().any(char::is_whitespace)
    {
        return Err(ApiError::Bad("E-mail inválido".into()));
    }
    Ok(email)
}

fn validate_password(value: &str) -> Result<(), ApiError> {
    let length = value.chars().count();
    if !(8..=256).contains(&length) {
        return Err(ApiError::Bad(
            "Senha deve ter entre 8 e 256 caracteres".into(),
        ));
    }
    Ok(())
}
fn validate_name(value: &str, maximum: usize, message: &str) -> Result<(), ApiError> {
    let length = value.chars().count();
    if length < 2 || length > maximum {
        return Err(ApiError::Bad(message.into()));
    }
    Ok(())
}

fn now_seconds() -> i64 {
    Utc::now().timestamp()
}

fn iso_timestamp(value: i64) -> String {
    chrono::DateTime::<Utc>::from_timestamp(value, 0)
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

fn internal(error: sqlx::Error) -> ApiError {
    ApiError::Internal(error.into())
}

fn map_unique(message: &'static str) -> impl FnOnce(sqlx::Error) -> ApiError {
    move |error| {
        if matches!(error, sqlx::Error::Database(ref database) if database.is_unique_violation()) {
            ApiError::Conflict(message.into())
        } else {
            ApiError::Internal(error.into())
        }
    }
}