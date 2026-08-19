use argon2::{
    password_hash::{
        rand_core::{OsRng, RngCore},
        PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
    },
    Argon2,
};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::{DateTime, Duration, Utc};
use hmac::{Hmac, Mac};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{
    collections::HashMap,
    env,
    sync::Arc,
    time::{Duration as StdDuration, Instant},
};
use tokio::sync::Mutex;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    limit::RequestBodyLimitLayer,
    trace::TraceLayer,
};
use uuid::Uuid;

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS: i64 = 15 * 60;
const LOGIN_WINDOW: StdDuration = StdDuration::from_secs(10 * 60);
const MAX_LOGIN_ATTEMPTS: u32 = 10;

#[derive(Clone)]
struct Config {
    jwt: String,
    turn_host: String,
    turn_port: u16,
    turn_secret: String,
    refresh_days: i64,
    access_token_ttl_seconds: i64,
    cookie_secure: bool,
}

#[derive(Clone)]
struct AppState {
    db: PgPool,
    config: Config,
    login_attempts: Arc<Mutex<HashMap<String, LoginWindow>>>,
}

struct LoginWindow {
    started_at: Instant,
    attempts: u32,
}

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: Uuid,
    exp: usize,
    kind: String,
    jti: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Register {
    display_name: String,
    email: String,
    password: String,
}

#[derive(Deserialize)]
struct Login {
    email: String,
    password: String,
}

#[derive(Deserialize)]
struct NewRoom {
    name: String,
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
struct NewMessage {
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewMember {
    user_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewCommunityInvite {
    email: Option<String>,
    create_link: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
}

type AuthResponse = (HeaderMap, Json<TokenResponse>);

#[derive(Debug, thiserror::Error)]
enum ApiError {
    #[error("{0}")]
    Bad(String),
    #[error("Não autorizado")]
    Unauthorized,
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    TooMany(String),
    #[error("Erro interno")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if let Self::Internal(error) = &self {
            tracing::error!(error = %error, "internal API error");
        }
        let status = match &self {
            Self::Bad(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::TooMany(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(json!({"message": self.to_string()}))).into_response()
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let jwt = env::var("JWT_SECRET")?;
    if jwt.len() < 32 {
        anyhow::bail!("JWT_SECRET deve ter ao menos 32 caracteres");
    }
    let turn_secret = env::var("TURN_SECRET")?;
    if turn_secret.len() < 16 {
        anyhow::bail!("TURN_SECRET deve ter ao menos 16 caracteres");
    }

    let db = PgPoolOptions::new()
        .max_connections(20)
        .connect(&env::var("DATABASE_URL")?)
        .await?;
    sqlx::migrate!().run(&db).await?;

    let config = Config {
        jwt,
        turn_host: env::var("TURN_HOST").unwrap_or_else(|_| "localhost".into()),
        turn_port: env::var("TURN_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(3478),
        turn_secret,
        refresh_days: env::var("REFRESH_TOKEN_TTL_DAYS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(30),
        access_token_ttl_seconds: env::var("ACCESS_TOKEN_TTL_SECONDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .filter(|value: &i64| *value > 0)
            .unwrap_or(DEFAULT_ACCESS_TOKEN_TTL_SECONDS),
        cookie_secure: env::var("COOKIE_SECURE")
            .map(|value| value.eq_ignore_ascii_case("true"))
            .unwrap_or(false),
    };
    if config.refresh_days <= 0 {
        anyhow::bail!("REFRESH_TOKEN_TTL_DAYS deve ser maior que zero");
    }

    let cors_origins = configured_origins()?;
    let state = AppState {
        db,
        config,
        login_attempts: Arc::new(Mutex::new(HashMap::new())),
    };

    let app = Router::new()
        .route("/health", get(|| async { Json(json!({"status": "ok"})) }))
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
        .route("/communities/{id}/members", post(add_community_member))
        .route("/communities/{id}/invites", post(create_community_invite))
        .route("/community-invites", get(list_community_invites))
        .route(
            "/community-invites/{id}/accept",
            post(accept_community_invite),
        )
        .route("/invites/{token}/accept", post(accept_invite_link))
        .route(
            "/channels/{id}/messages",
            get(list_messages).post(create_message),
        )
        .route("/rooms", post(create_room))
        .route("/rtc/credentials", get(turn_credentials))
        .layer(RequestBodyLimitLayer::new(64 * 1024))
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(cors_origins))
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_credentials(true),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    tracing::info!("listening on 8080");
    axum::serve(listener, app).await?;
    Ok(())
}

fn configured_origins() -> anyhow::Result<Vec<HeaderValue>> {
    let configured = env::var("WEB_ORIGINS")
        .or_else(|_| env::var("WEB_ORIGIN"))
        .unwrap_or_else(|_| "http://localhost:5173".into());
    let origins = configured
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::parse::<HeaderValue>)
        .collect::<Result<Vec<_>, _>>()?;
    if origins.is_empty() {
        anyhow::bail!("WEB_ORIGINS não pode ficar vazio");
    }
    Ok(origins)
}

async fn register(
    State(state): State<AppState>,
    Json(input): Json<Register>,
) -> Result<AuthResponse, ApiError> {
    let display_name = input.display_name.trim();
    let email = normalize_email(&input.email)?;
    validate_display_name(display_name)?;
    validate_password(&input.password)?;

    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(input.password.as_bytes(), &salt)
        .map_err(|error| ApiError::Internal(anyhow::anyhow!(error.to_string())))?
        .to_string();
    let id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO users(display_name,email,password_hash) VALUES($1,$2,$3) RETURNING id",
    )
    .bind(display_name)
    .bind(email)
    .bind(hash)
    .fetch_one(&state.db)
    .await
    .map_err(|error| {
        if matches!(error, sqlx::Error::Database(ref database) if database.is_unique_violation()) {
            ApiError::Conflict("Este e-mail já está cadastrado".into())
        } else {
            ApiError::Internal(error.into())
        }
    })?;
    create_session(&state, id).await
}

async fn login(
    State(state): State<AppState>,
    Json(input): Json<Login>,
) -> Result<AuthResponse, ApiError> {
    let email = normalize_email(&input.email)?;
    check_login_limit(&state, &email).await?;

    let row = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id,password_hash FROM users WHERE email=$1",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::Unauthorized)?;

    Argon2::default()
        .verify_password(
            input.password.as_bytes(),
            &PasswordHash::new(&row.1).map_err(|_| ApiError::Unauthorized)?,
        )
        .map_err(|_| ApiError::Unauthorized)?;
    clear_login_limit(&state, &email).await;
    create_session(&state, row.0).await
}

async fn check_login_limit(state: &AppState, email: &str) -> Result<(), ApiError> {
    let now = Instant::now();
    let mut attempts = state.login_attempts.lock().await;
    attempts.retain(|_, window| now.duration_since(window.started_at) < LOGIN_WINDOW);
    let window = attempts.entry(email.to_owned()).or_insert(LoginWindow {
        started_at: now,
        attempts: 0,
    });
    if now.duration_since(window.started_at) >= LOGIN_WINDOW {
        window.started_at = now;
        window.attempts = 0;
    }
    if window.attempts >= MAX_LOGIN_ATTEMPTS {
        return Err(ApiError::TooMany(
            "Muitas tentativas de login. Aguarde alguns minutos.".into(),
        ));
    }
    window.attempts += 1;
    Ok(())
}

async fn clear_login_limit(state: &AppState, email: &str) {
    state.login_attempts.lock().await.remove(email);
}

async fn create_session(state: &AppState, user_id: Uuid) -> Result<AuthResponse, ApiError> {
    let (token, hash, expires) = new_refresh(&state.config);
    sqlx::query(
        "INSERT INTO sessions(user_id,refresh_token_hash,expires_at) VALUES($1,$2,$3)",
    )
    .bind(user_id)
    .bind(hash)
    .bind(expires)
    .execute(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    auth_response(&state.config, user_id, token)
}

async fn refresh(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<AuthResponse, ApiError> {
    let token = cookie(&headers, "refresh_token").ok_or(ApiError::Unauthorized)?;
    let hash = token_hash(&token);
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let session = sqlx::query_as::<_, (Uuid, Uuid, DateTime<Utc>, Option<DateTime<Utc>>)>(
        "SELECT id,user_id,expires_at,revoked_at FROM sessions WHERE refresh_token_hash=$1 FOR UPDATE",
    )
    .bind(hash)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::Unauthorized)?;

    if session.3.is_some() || session.2 <= Utc::now() {
        transaction
            .commit()
            .await
            .map_err(|error| ApiError::Internal(error.into()))?;
        return Err(ApiError::Unauthorized);
    }

    sqlx::query("UPDATE sessions SET revoked_at=now() WHERE id=$1")
        .bind(session.0)
        .execute(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let (new_token, new_hash, expires) = new_refresh(&state.config);
    sqlx::query(
        "INSERT INTO sessions(user_id,refresh_token_hash,expires_at) VALUES($1,$2,$3)",
    )
    .bind(session.1)
    .bind(new_hash)
    .bind(expires)
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    auth_response(&state.config, session.1, new_token)
}

async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<Value>), ApiError> {
    if let Some(token) = cookie(&headers, "refresh_token") {
        sqlx::query(
            "UPDATE sessions SET revoked_at=now() WHERE refresh_token_hash=$1 AND revoked_at IS NULL",
        )
        .bind(token_hash(&token))
        .execute(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    }
    let mut response = HeaderMap::new();
    response.insert(header::SET_COOKIE, clear_refresh_cookie(&state.config)?);
    Ok((response, Json(json!({"ok": true}))))
}

async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let row = sqlx::query_as::<_, (Uuid, String, String)>(
        "SELECT id,display_name,email FROM users WHERE id=$1",
    )
    .bind(user)
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::Unauthorized)?;
    Ok(Json(json!({"id": row.0, "displayName": row.1, "email": row.2})))
}

fn new_refresh(config: &Config) -> (String, String, DateTime<Utc>) {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let hash = token_hash(&token);
    (
        token,
        hash,
        Utc::now() + Duration::days(config.refresh_days),
    )
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|item| item.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then(|| value.to_owned()))
}

fn refresh_cookie_attributes(config: &Config) -> &'static str {
    if config.cookie_secure {
        "; Path=/auth; HttpOnly; SameSite=None; Secure"
    } else {
        "; Path=/auth; HttpOnly; SameSite=Lax"
    }
}

fn clear_refresh_cookie(config: &Config) -> Result<HeaderValue, ApiError> {
    HeaderValue::from_str(&format!(
        "refresh_token={}{}; Max-Age=0",
        "",
        refresh_cookie_attributes(config)
    ))
    .map_err(|error| ApiError::Internal(error.into()))
}

fn auth_response(
    config: &Config,
    user_id: Uuid,
    refresh_token: String,
) -> Result<AuthResponse, ApiError> {
    let cookie = format!(
        "refresh_token={refresh_token}{}; Max-Age={}",
        refresh_cookie_attributes(config),
        config.refresh_days * 86_400,
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|error| ApiError::Internal(error.into()))?,
    );
    Ok((
        headers,
        Json(TokenResponse {
            access_token: issue(config, user_id)?,
        }),
    ))
}

fn issue(config: &Config, id: Uuid) -> Result<String, ApiError> {
    encode(
        &Header::default(),
        &Claims {
            sub: id,
            exp: (Utc::now() + Duration::seconds(config.access_token_ttl_seconds)).timestamp()
                as usize,
            kind: "access".into(),
            jti: Uuid::new_v4(),
        },
        &EncodingKey::from_secret(config.jwt.as_bytes()),
    )
    .map_err(|error| ApiError::Internal(error.into()))
}

fn bearer(headers: &HeaderMap, config: &Config) -> Result<Uuid, ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized)?;
    let claims = decode::<Claims>(
        token,
        &DecodingKey::from_secret(config.jwt.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| ApiError::Unauthorized)?
    .claims;
    if claims.kind != "access" {
        return Err(ApiError::Unauthorized);
    }
    Ok(claims.sub)
}

fn normalize_email(value: &str) -> Result<String, ApiError> {
    let email = value.trim().to_lowercase();
    let length = email.chars().count();
    if length < 3 || length > 320 || !email.contains('@') || email.contains(char::is_whitespace) {
        return Err(ApiError::Bad("E-mail inválido".into()));
    }
    Ok(email)
}

fn validate_display_name(value: &str) -> Result<(), ApiError> {
    let length = value.chars().count();
    if !(2..=80).contains(&length) {
        return Err(ApiError::Bad("Nome deve ter entre 2 e 80 caracteres".into()));
    }
    Ok(())
}

fn validate_password(value: &str) -> Result<(), ApiError> {
    let length = value.chars().count();
    if !(8..=256).contains(&length) {
        return Err(ApiError::Bad("Senha deve ter entre 8 e 256 caracteres".into()));
    }
    Ok(())
}

async fn list_friends(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let friends = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT u.id,u.display_name FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END WHERE f.user_a=$1 OR f.user_b=$1 ORDER BY lower(u.display_name)",
    )
    .bind(user)
    .fetch_all(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let pending = sqlx::query_as::<_, (Uuid, Uuid, String)>(
        "SELECT r.id,u.id,u.display_name FROM friend_requests r JOIN users u ON u.id=r.sender_id WHERE r.recipient_id=$1 AND r.status='pending' ORDER BY r.created_at DESC",
    )
    .bind(user)
    .fetch_all(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(Json(json!({
        "friends": friends.into_iter().map(|(id, display_name)| json!({"id": id, "displayName": display_name})).collect::<Vec<_>>(),
        "pending": pending.into_iter().map(|(request_id, id, display_name)| json!({"requestId": request_id, "id": id, "displayName": display_name})).collect::<Vec<_>>()
    })))
}

async fn send_friend_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<FriendRequestInput>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let email = normalize_email(&input.email)?;
    let recipient = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email=$1")
        .bind(email)
        .fetch_optional(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?
        .ok_or_else(|| ApiError::Bad("Usuário não encontrado".into()))?;
    if recipient == user {
        return Err(ApiError::Bad("Você não pode adicionar a si mesmo".into()));
    }
    let already = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM friendships WHERE user_a=LEAST($1,$2) AND user_b=GREATEST($1,$2))",
    )
    .bind(user)
    .bind(recipient)
    .fetch_one(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if already {
        return Err(ApiError::Conflict("Vocês já são amigos".into()));
    }
    sqlx::query(
        "INSERT INTO friend_requests(sender_id,recipient_id) VALUES($1,$2) ON CONFLICT(sender_id,recipient_id) DO UPDATE SET status='pending',created_at=now()",
    )
    .bind(user)
    .bind(recipient)
    .execute(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(Json(json!({"ok": true})))
}

async fn accept_friend_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let sender = sqlx::query_scalar::<_, Uuid>(
        "UPDATE friend_requests SET status='accepted' WHERE id=$1 AND recipient_id=$2 AND status='pending' RETURNING sender_id",
    )
    .bind(id)
    .bind(user)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::Unauthorized)?;
    sqlx::query(
        "INSERT INTO friendships(user_a,user_b) VALUES(LEAST($1,$2),GREATEST($1,$2)) ON CONFLICT DO NOTHING",
    )
    .bind(user)
    .bind(sender)
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    sqlx::query(
        "UPDATE friend_requests SET status='accepted' WHERE status='pending' AND ((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1))",
    )
    .bind(user)
    .bind(sender)
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(Json(json!({"ok": true})))
}

async fn list_communities(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let rows = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT c.id,c.name FROM communities c JOIN community_members m ON m.community_id=c.id WHERE m.user_id=$1 ORDER BY c.created_at",
    )
    .bind(user)
    .fetch_all(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(Json(json!(rows
        .into_iter()
        .map(|(id, name)| json!({"id": id, "name": name}))
        .collect::<Vec<_>>())))
}

async fn create_community(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<NewCommunity>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let name = input.name.trim();
    validate_named_resource(name, 100, "Nome do grupo inválido")?;
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO communities(name,owner_id) VALUES($1,$2) RETURNING id",
    )
    .bind(name)
    .bind(user)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    sqlx::query("INSERT INTO community_members(community_id,user_id) VALUES($1,$2)")
        .bind(id)
        .bind(user)
        .execute(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    sqlx::query(
        "INSERT INTO channels(community_id,name,kind,position) VALUES($1,'geral','text',0)",
    )
    .bind(id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    let room = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO rooms(name,owner_id) VALUES('Geral',$1) RETURNING id",
    )
    .bind(user)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    sqlx::query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING")
        .bind(room)
        .bind(user)
        .execute(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    sqlx::query(
        "INSERT INTO channels(community_id,name,kind,voice_room_id,position) VALUES($1,'Geral','voice',$2,1)",
    )
    .bind(id)
    .bind(room)
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(Json(json!({"id": id, "name": name})))
}

async fn add_community_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<NewMember>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let owner = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM communities WHERE id=$1 AND owner_id=$2)",
    )
    .bind(id)
    .bind(user)
    .fetch_one(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if !owner {
        return Err(ApiError::Unauthorized);
    }
    let friend = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM friendships WHERE user_a=LEAST($1,$2) AND user_b=GREATEST($1,$2))",
    )
    .bind(user)
    .bind(input.user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if !friend {
        return Err(ApiError::Bad("Adicione essa pessoa como amiga primeiro".into()));
    }
    sqlx::query(
        "INSERT INTO community_members(community_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(input.user_id)
    .execute(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    add_user_to_community_voice_rooms(&state.db, id, input.user_id).await?;
    Ok(Json(json!({"ok": true})))
}

async fn create_community_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<NewCommunityInvite>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    require_member(&state.db, id, user).await?;
    if input.create_link.unwrap_or(false) {
        let mut bytes = [0_u8; 24];
        OsRng.fill_bytes(&mut bytes);
        let token = URL_SAFE_NO_PAD.encode(bytes);
        sqlx::query(
            "INSERT INTO community_invites(community_id,inviter_id,token_hash,max_uses) VALUES($1,$2,$3,100)",
        )
        .bind(id)
        .bind(user)
        .bind(token_hash(&token))
        .execute(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        return Ok(Json(json!({"token": token, "expiresInDays": 7})));
    }

    let email = normalize_email(input.email.as_deref().unwrap_or(""))?;
    let recipient = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email=$1")
        .bind(email)
        .fetch_optional(&state.db)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?
        .ok_or_else(|| ApiError::Bad("Usuário não encontrado".into()))?;
    if recipient == user {
        return Err(ApiError::Bad("Você já está no grupo".into()));
    }
    let member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2)",
    )
    .bind(id)
    .bind(recipient)
    .fetch_one(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if member {
        return Err(ApiError::Conflict("Essa pessoa já está no grupo".into()));
    }
    sqlx::query(
        "INSERT INTO community_invites(community_id,inviter_id,recipient_id) VALUES($1,$2,$3)",
    )
    .bind(id)
    .bind(user)
    .bind(recipient)
    .execute(&state.db)
    .await
    .map_err(|error| {
        if matches!(error, sqlx::Error::Database(ref database) if database.is_unique_violation()) {
            ApiError::Conflict("Já existe um convite pendente para essa pessoa".into())
        } else {
            ApiError::Internal(error.into())
        }
    })?;
    Ok(Json(json!({"ok": true})))
}

async fn list_community_invites(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let rows = sqlx::query_as::<_, (Uuid, Uuid, String, String)>(
        "SELECT i.id,c.id,c.name,u.display_name FROM community_invites i JOIN communities c ON c.id=i.community_id JOIN users u ON u.id=i.inviter_id WHERE i.recipient_id=$1 AND i.status='pending' AND i.expires_at>now() ORDER BY i.created_at DESC",
    )
    .bind(user)
    .fetch_all(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(Json(json!(rows
        .into_iter()
        .map(|(id, community_id, community_name, inviter)| json!({"id": id, "communityId": community_id, "communityName": community_name, "inviter": inviter}))
        .collect::<Vec<_>>())))
}

async fn accept_community_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let community = sqlx::query_scalar::<_, Uuid>(
        "UPDATE community_invites SET status='accepted',uses=uses+1 WHERE id=$1 AND recipient_id=$2 AND status='pending' AND expires_at>now() RETURNING community_id",
    )
    .bind(id)
    .bind(user)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or(ApiError::Unauthorized)?;
    sqlx::query(
        "INSERT INTO community_members(community_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    )
    .bind(community)
    .bind(user)
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    add_user_to_community_voice_rooms_tx(&mut transaction, community, user).await?;
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(Json(json!({"communityId": community})))
}

async fn accept_invite_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let community = sqlx::query_scalar::<_, Uuid>(
        "UPDATE community_invites SET uses=uses+1,status=CASE WHEN uses+1>=max_uses THEN 'accepted' ELSE status END WHERE token_hash=$1 AND status='pending' AND expires_at>now() AND uses<max_uses RETURNING community_id",
    )
    .bind(token_hash(&token))
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or_else(|| ApiError::Bad("Convite inválido ou expirado".into()))?;
    sqlx::query(
        "INSERT INTO community_members(community_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    )
    .bind(community)
    .bind(user)
    .execute(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    add_user_to_community_voice_rooms_tx(&mut transaction, community, user).await?;
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(Json(json!({"communityId": community})))
}

async fn require_member(db: &PgPool, community: Uuid, user: Uuid) -> Result<(), ApiError> {
    let ok = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2)",
    )
    .bind(community)
    .bind(user)
    .fetch_one(db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    if ok { Ok(()) } else { Err(ApiError::Unauthorized) }
}

async fn add_user_to_community_voice_rooms(
    db: &PgPool,
    community: Uuid,
    user: Uuid,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO room_members(room_id,user_id) SELECT voice_room_id,$2 FROM channels WHERE community_id=$1 AND kind='voice' AND voice_room_id IS NOT NULL ON CONFLICT DO NOTHING",
    )
    .bind(community)
    .bind(user)
    .execute(db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(())
}

async fn add_user_to_community_voice_rooms_tx(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    community: Uuid,
    user: Uuid,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO room_members(room_id,user_id) SELECT voice_room_id,$2 FROM channels WHERE community_id=$1 AND kind='voice' AND voice_room_id IS NOT NULL ON CONFLICT DO NOTHING",
    )
    .bind(community)
    .bind(user)
    .execute(&mut **transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(())
}

async fn list_channels(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    require_member(&state.db, id, user).await?;
    let rows = sqlx::query_as::<_, (Uuid, String, String, Option<Uuid>)>(
        "SELECT id,name,kind,voice_room_id FROM channels WHERE community_id=$1 ORDER BY position,created_at",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(Json(json!(rows
        .into_iter()
        .map(|(id, name, kind, voice_room_id)| json!({"id": id, "name": name, "kind": kind, "voiceRoomId": voice_room_id}))
        .collect::<Vec<_>>())))
}

async fn create_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<NewChannel>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    require_member(&state.db, id, user).await?;
    let name = input.name.trim();
    validate_named_resource(name, 80, "Nome do canal inválido")?;
    if !matches!(input.kind.as_str(), "text" | "voice") {
        return Err(ApiError::Bad("Tipo de canal inválido".into()));
    }
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let voice_room = if input.kind == "voice" {
        let room = sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO rooms(name,owner_id) VALUES($1,$2) RETURNING id",
        )
        .bind(name)
        .bind(user)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        sqlx::query(
            "INSERT INTO room_members(room_id,user_id) SELECT $1,user_id FROM community_members WHERE community_id=$2 ON CONFLICT DO NOTHING",
        )
        .bind(room)
        .bind(id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
        Some(room)
    } else {
        None
    };
    let channel = sqlx::query_as::<_, (Uuid, String, String, Option<Uuid>)>(
        "INSERT INTO channels(community_id,name,kind,voice_room_id,position) VALUES($1,$2,$3,$4,(SELECT COALESCE(max(position),-1)+1 FROM channels WHERE community_id=$1)) RETURNING id,name,kind,voice_room_id",
    )
    .bind(id)
    .bind(name)
    .bind(&input.kind)
    .bind(voice_room)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(Json(json!({
        "id": channel.0,
        "name": channel.1,
        "kind": channel.2,
        "voiceRoomId": channel.3
    })))
}

async fn list_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let community = sqlx::query_scalar::<_, Uuid>(
        "SELECT community_id FROM channels WHERE id=$1 AND kind='text'",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or_else(|| ApiError::Bad("Canal não encontrado".into()))?;
    require_member(&state.db, community, user).await?;
    let rows = sqlx::query_as::<_, (Uuid, String, String, DateTime<Utc>)>(
        "SELECT m.id,u.display_name,m.content,m.created_at FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=$1 ORDER BY m.created_at DESC LIMIT 100",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(Json(json!(rows
        .into_iter()
        .rev()
        .map(|(id, author, content, created_at)| json!({"id": id, "author": author, "content": content, "createdAt": created_at}))
        .collect::<Vec<_>>())))
}

async fn create_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<NewMessage>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let community = sqlx::query_scalar::<_, Uuid>(
        "SELECT community_id FROM channels WHERE id=$1 AND kind='text'",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?
    .ok_or_else(|| ApiError::Bad("Canal não encontrado".into()))?;
    require_member(&state.db, community, user).await?;
    let content = input.content.trim();
    let length = content.chars().count();
    if length == 0 || length > 4_000 {
        return Err(ApiError::Bad("Mensagem inválida".into()));
    }
    let row = sqlx::query_as::<_, (Uuid, String, DateTime<Utc>)>(
        "WITH inserted AS (INSERT INTO messages(channel_id,author_id,content) VALUES($1,$2,$3) RETURNING id,created_at) SELECT inserted.id,u.display_name,inserted.created_at FROM inserted JOIN users u ON u.id=$2",
    )
    .bind(id)
    .bind(user)
    .bind(content)
    .fetch_one(&state.db)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(Json(json!({
        "id": row.0,
        "author": row.1,
        "content": content,
        "createdAt": row.2
    })))
}

async fn create_room(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<NewRoom>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let name = input.name.trim();
    validate_named_resource(name, 100, "Nome da sala inválido")?;
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    let id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO rooms(name,owner_id) VALUES($1,$2) RETURNING id",
    )
    .bind(name)
    .bind(user)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|error| ApiError::Internal(error.into()))?;
    sqlx::query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2)")
        .bind(id)
        .bind(user)
        .execute(&mut *transaction)
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;
    Ok(Json(json!({"id": id})))
}

fn validate_named_resource(value: &str, maximum: usize, message: &str) -> Result<(), ApiError> {
    let length = value.chars().count();
    if length < 2 || length > maximum {
        return Err(ApiError::Bad(message.into()));
    }
    Ok(())
}

async fn turn_credentials(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &state.config)?;
    let username = format!("{}:{}", (Utc::now() + Duration::hours(1)).timestamp(), user);
    let mut mac = Hmac::<Sha1>::new_from_slice(state.config.turn_secret.as_bytes())
        .map_err(|error| ApiError::Internal(anyhow::anyhow!(error.to_string())))?;
    mac.update(username.as_bytes());
    let credential = STANDARD.encode(mac.finalize().into_bytes());
    Ok(Json(json!({
        "iceServers": [
            {"urls": [format!("stun:{}:{}", state.config.turn_host, state.config.turn_port)]},
            {
                "urls": [
                    format!("turn:{}:{}?transport=udp", state.config.turn_host, state.config.turn_port),
                    format!("turn:{}:{}?transport=tcp", state.config.turn_host, state.config.turn_port)
                ],
                "username": username,
                "credential": credential
            }
        ]
    })))
}
