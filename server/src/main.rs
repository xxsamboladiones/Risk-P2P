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
use std::env;
use tower_http::{cors::CorsLayer, limit::RequestBodyLimitLayer, trace::TraceLayer};
use uuid::Uuid;

#[derive(Clone)]
struct Config {
    jwt: String,
    turn_host: String,
    turn_port: u16,
    turn_secret: String,
    refresh_days: i64,
    cookie_secure: bool,
}
#[derive(Clone)]
struct AppState {
    db: PgPool,
    config: Config,
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
    #[error("Erro interno")]
    Internal(#[from] anyhow::Error),
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::Bad(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(json!({"message":self.to_string()}))).into_response()
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let db = PgPoolOptions::new()
        .max_connections(20)
        .connect(&env::var("DATABASE_URL")?)
        .await?;
    sqlx::migrate!().run(&db).await?;
    let state = AppState {
        db,
        config: Config {
            jwt: env::var("JWT_SECRET")?,
            turn_host: env::var("TURN_HOST").unwrap_or("localhost".into()),
            turn_port: env::var("TURN_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3478),
            turn_secret: env::var("TURN_SECRET")?,
            refresh_days: env::var("REFRESH_TOKEN_TTL_DAYS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30),
            cookie_secure: env::var("COOKIE_SECURE")
                .map(|v| v == "true")
                .unwrap_or(false),
        },
    };
    let app = Router::new()
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }))
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
                .allow_origin(
                    env::var("WEB_ORIGIN")
                        .unwrap_or_else(|_| "http://localhost:5173".into())
                        .parse::<HeaderValue>()?,
                )
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

async fn register(
    State(s): State<AppState>,
    Json(i): Json<Register>,
) -> Result<AuthResponse, ApiError> {
    if i.password.len() < 8 || i.display_name.trim().len() < 2 {
        return Err(ApiError::Bad("Nome ou senha inválidos".into()));
    }
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(i.password.as_bytes(), &salt)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .to_string();
    let id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO users(display_name,email,password_hash)VALUES($1,lower($2),$3)RETURNING id",
    )
    .bind(i.display_name.trim())
    .bind(i.email.trim())
    .bind(hash)
    .fetch_one(&s.db)
    .await
    .map_err(|e| {
        if matches!(e,sqlx::Error::Database(ref d)if d.is_unique_violation()) {
            ApiError::Conflict("Este e-mail já está cadastrado".into())
        } else {
            ApiError::Internal(e.into())
        }
    })?;
    create_session(&s, id).await
}
async fn login(State(s): State<AppState>, Json(i): Json<Login>) -> Result<AuthResponse, ApiError> {
    let row = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id,password_hash FROM users WHERE email=lower($1)",
    )
    .bind(i.email.trim())
    .fetch_optional(&s.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?
    .ok_or(ApiError::Unauthorized)?;
    Argon2::default()
        .verify_password(
            i.password.as_bytes(),
            &PasswordHash::new(&row.1).map_err(|_| ApiError::Unauthorized)?,
        )
        .map_err(|_| ApiError::Unauthorized)?;
    create_session(&s, row.0).await
}
async fn create_session(s: &AppState, user_id: Uuid) -> Result<AuthResponse, ApiError> {
    let (token, hash, expires) = new_refresh(&s.config);
    sqlx::query("INSERT INTO sessions(user_id,refresh_token_hash,expires_at)VALUES($1,$2,$3)")
        .bind(user_id)
        .bind(hash)
        .bind(expires)
        .execute(&s.db)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    auth_response(&s.config, user_id, token)
}
async fn refresh(State(s): State<AppState>, headers: HeaderMap) -> Result<AuthResponse, ApiError> {
    let token = cookie(&headers, "refresh_token").ok_or(ApiError::Unauthorized)?;
    let hash = token_hash(&token);
    let mut tx =
        s.db.begin()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
    let session = sqlx::query_as::<_, (Uuid, Uuid, DateTime<Utc>, Option<DateTime<Utc>>)>("SELECT id,user_id,expires_at,revoked_at FROM sessions WHERE refresh_token_hash=$1 FOR UPDATE")
        .bind(hash).fetch_optional(&mut *tx).await.map_err(|e| ApiError::Internal(e.into()))?
        .ok_or(ApiError::Unauthorized)?;
    if session.3.is_some() || session.2 <= Utc::now() {
        tx.commit()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
        return Err(ApiError::Unauthorized);
    }
    sqlx::query("UPDATE sessions SET revoked_at=now() WHERE id=$1")
        .bind(session.0)
        .execute(&mut *tx)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    let (new_token, new_hash, expires) = new_refresh(&s.config);
    sqlx::query("INSERT INTO sessions(user_id,refresh_token_hash,expires_at)VALUES($1,$2,$3)")
        .bind(session.1)
        .bind(new_hash)
        .bind(expires)
        .execute(&mut *tx)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    tx.commit()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    auth_response(&s.config, session.1, new_token)
}
async fn logout(
    State(s): State<AppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<Value>), ApiError> {
    if let Some(token) = cookie(&headers, "refresh_token") {
        sqlx::query("UPDATE sessions SET revoked_at=now() WHERE refresh_token_hash=$1 AND revoked_at IS NULL").bind(token_hash(&token)).execute(&s.db).await.map_err(|e| ApiError::Internal(e.into()))?;
    }
    let mut response = HeaderMap::new();
    response.insert(
        header::SET_COOKIE,
        HeaderValue::from_static("refresh_token=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0"),
    );
    Ok((response, Json(json!({"ok":true}))))
}
async fn me(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let user = bearer(&headers, &s.config)?;
    let row = sqlx::query_as::<_, (Uuid, String, String)>(
        "SELECT id,display_name,email FROM users WHERE id=$1",
    )
    .bind(user)
    .fetch_optional(&s.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?
    .ok_or(ApiError::Unauthorized)?;
    Ok(Json(json!({"id":row.0,"displayName":row.1,"email":row.2})))
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
fn auth_response(
    config: &Config,
    user_id: Uuid,
    refresh_token: String,
) -> Result<AuthResponse, ApiError> {
    let secure = if config.cookie_secure { "; Secure" } else { "" };
    let cookie = format!(
        "refresh_token={refresh_token}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age={}{}",
        config.refresh_days * 86_400,
        secure
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|e| ApiError::Internal(e.into()))?,
    );
    Ok((
        headers,
        Json(TokenResponse {
            access_token: issue(config, user_id)?,
        }),
    ))
}
fn issue(c: &Config, id: Uuid) -> Result<String, ApiError> {
    encode(
        &Header::default(),
        &Claims {
            sub: id,
            exp: (Utc::now() + Duration::minutes(15)).timestamp() as usize,
            kind: "access".into(),
            jti: Uuid::new_v4(),
        },
        &EncodingKey::from_secret(c.jwt.as_bytes()),
    )
    .map_err(|e| ApiError::Internal(e.into()))
}
fn bearer(h: &HeaderMap, c: &Config) -> Result<Uuid, ApiError> {
    let t = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized)?;
    Ok(decode::<Claims>(
        t,
        &DecodingKey::from_secret(c.jwt.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| ApiError::Unauthorized)?
    .claims
    .sub)
}
async fn list_friends(State(s): State<AppState>, h: HeaderMap) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    let friends = sqlx::query_as::<_, (Uuid, String)>("SELECT u.id,u.display_name FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END WHERE f.user_a=$1 OR f.user_b=$1 ORDER BY lower(u.display_name)").bind(user).fetch_all(&s.db).await.map_err(|e| ApiError::Internal(e.into()))?;
    let pending = sqlx::query_as::<_, (Uuid, Uuid, String)>("SELECT r.id,u.id,u.display_name FROM friend_requests r JOIN users u ON u.id=r.sender_id WHERE r.recipient_id=$1 AND r.status='pending' ORDER BY r.created_at DESC").bind(user).fetch_all(&s.db).await.map_err(|e| ApiError::Internal(e.into()))?;
    Ok(Json(
        json!({"friends":friends.into_iter().map(|(id,display_name)|json!({"id":id,"displayName":display_name})).collect::<Vec<_>>(),"pending":pending.into_iter().map(|(request_id,id,display_name)|json!({"requestId":request_id,"id":id,"displayName":display_name})).collect::<Vec<_>>()}),
    ))
}
async fn send_friend_request(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(i): Json<FriendRequestInput>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    let recipient = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email=lower($1)")
        .bind(i.email.trim())
        .fetch_optional(&s.db)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?
        .ok_or_else(|| ApiError::Bad("Usuário não encontrado".into()))?;
    if recipient == user {
        return Err(ApiError::Bad("Você não pode adicionar a si mesmo".into()));
    }
    let already = sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM friendships WHERE (user_a=LEAST($1,$2) AND user_b=GREATEST($1,$2)))").bind(user).bind(recipient).fetch_one(&s.db).await.map_err(|e|ApiError::Internal(e.into()))?;
    if already {
        return Err(ApiError::Conflict("Vocês já são amigos".into()));
    }
    sqlx::query("INSERT INTO friend_requests(sender_id,recipient_id)VALUES($1,$2) ON CONFLICT(sender_id,recipient_id) DO UPDATE SET status='pending',created_at=now()").bind(user).bind(recipient).execute(&s.db).await.map_err(|e|ApiError::Internal(e.into()))?;
    Ok(Json(json!({"ok":true})))
}
async fn accept_friend_request(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    let mut tx =
        s.db.begin()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
    let sender=sqlx::query_scalar::<_,Uuid>("UPDATE friend_requests SET status='accepted' WHERE id=$1 AND recipient_id=$2 AND status='pending' RETURNING sender_id").bind(id).bind(user).fetch_optional(&mut *tx).await.map_err(|e|ApiError::Internal(e.into()))?.ok_or(ApiError::Unauthorized)?;
    sqlx::query("INSERT INTO friendships(user_a,user_b)VALUES(LEAST($1,$2),GREATEST($1,$2)) ON CONFLICT DO NOTHING").bind(user).bind(sender).execute(&mut *tx).await.map_err(|e|ApiError::Internal(e.into()))?;
    tx.commit()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    Ok(Json(json!({"ok":true})))
}
async fn list_communities(
    State(s): State<AppState>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    let rows=sqlx::query_as::<_,(Uuid,String)>("SELECT c.id,c.name FROM communities c JOIN community_members m ON m.community_id=c.id WHERE m.user_id=$1 ORDER BY c.created_at").bind(user).fetch_all(&s.db).await.map_err(|e|ApiError::Internal(e.into()))?;
    Ok(Json(json!(rows
        .into_iter()
        .map(|(id, name)| json!({"id":id,"name":name}))
        .collect::<Vec<_>>())))
}
async fn create_community(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(i): Json<NewCommunity>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    if i.name.trim().len() < 2 {
        return Err(ApiError::Bad("Nome do grupo muito curto".into()));
    }
    let mut tx =
        s.db.begin()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
    let id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO communities(name,owner_id)VALUES($1,$2)RETURNING id",
    )
    .bind(i.name.trim())
    .bind(user)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    sqlx::query("INSERT INTO community_members(community_id,user_id)VALUES($1,$2)")
        .bind(id)
        .bind(user)
        .execute(&mut *tx)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    sqlx::query("INSERT INTO channels(community_id,name,kind,position)VALUES($1,'geral','text',0)")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    let room = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO rooms(name,owner_id)VALUES('Geral',$1)RETURNING id",
    )
    .bind(user)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    sqlx::query("INSERT INTO channels(community_id,name,kind,voice_room_id,position)VALUES($1,'Geral','voice',$2,1)").bind(id).bind(room).execute(&mut *tx).await.map_err(|e|ApiError::Internal(e.into()))?;
    tx.commit()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    Ok(Json(json!({"id":id,"name":i.name.trim()})))
}
async fn add_community_member(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<NewMember>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    let owner = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM communities WHERE id=$1 AND owner_id=$2)",
    )
    .bind(id)
    .bind(user)
    .fetch_one(&s.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    if !owner {
        return Err(ApiError::Unauthorized);
    }
    let friend=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM friendships WHERE user_a=LEAST($1,$2) AND user_b=GREATEST($1,$2))").bind(user).bind(i.user_id).fetch_one(&s.db).await.map_err(|e|ApiError::Internal(e.into()))?;
    if !friend {
        return Err(ApiError::Bad(
            "Adicione essa pessoa como amiga primeiro".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO community_members(community_id,user_id)VALUES($1,$2)ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(i.user_id)
    .execute(&s.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    Ok(Json(json!({"ok":true})))
}

async fn create_community_invite(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<NewCommunityInvite>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    let allowed = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2)",
    )
    .bind(id)
    .bind(user)
    .fetch_one(&s.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    if !allowed {
        return Err(ApiError::Unauthorized);
    }
    if i.create_link.unwrap_or(false) {
        let mut bytes = [0_u8; 24];
        OsRng.fill_bytes(&mut bytes);
        let token = URL_SAFE_NO_PAD.encode(bytes);
        sqlx::query("INSERT INTO community_invites(community_id,inviter_id,token_hash,max_uses) VALUES($1,$2,$3,100)")
            .bind(id).bind(user).bind(token_hash(&token)).execute(&s.db).await
            .map_err(|e| ApiError::Internal(e.into()))?;
        return Ok(Json(json!({"token":token,"expiresInDays":7})));
    }
    let email = i.email.as_deref().unwrap_or("").trim();
    let recipient = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email=lower($1)")
        .bind(email)
        .fetch_optional(&s.db)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?
        .ok_or_else(|| ApiError::Bad("Usuário não encontrado".into()))?;
    if recipient == user {
        return Err(ApiError::Bad("Você já está no grupo".into()));
    }
    let member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2)",
    )
    .bind(id)
    .bind(recipient)
    .fetch_one(&s.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    if member {
        return Err(ApiError::Conflict("Essa pessoa já está no grupo".into()));
    }
    sqlx::query(
        "INSERT INTO community_invites(community_id,inviter_id,recipient_id) VALUES($1,$2,$3)",
    )
    .bind(id)
    .bind(user)
    .bind(recipient)
    .execute(&s.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    Ok(Json(json!({"ok":true})))
}

async fn list_community_invites(
    State(s): State<AppState>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    let rows = sqlx::query_as::<_, (Uuid, Uuid, String, String)>("SELECT i.id,c.id,c.name,u.display_name FROM community_invites i JOIN communities c ON c.id=i.community_id JOIN users u ON u.id=i.inviter_id WHERE i.recipient_id=$1 AND i.status='pending' AND i.expires_at>now() ORDER BY i.created_at DESC")
        .bind(user).fetch_all(&s.db).await.map_err(|e| ApiError::Internal(e.into()))?;
    Ok(Json(json!(rows.into_iter().map(|(id,community_id,community_name,inviter)|json!({"id":id,"communityId":community_id,"communityName":community_name,"inviter":inviter})).collect::<Vec<_>>())))
}

async fn accept_community_invite(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    let mut tx =
        s.db.begin()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
    let community = sqlx::query_scalar::<_, Uuid>("UPDATE community_invites SET status='accepted',uses=uses+1 WHERE id=$1 AND recipient_id=$2 AND status='pending' AND expires_at>now() RETURNING community_id")
        .bind(id).bind(user).fetch_optional(&mut *tx).await.map_err(|e| ApiError::Internal(e.into()))?.ok_or(ApiError::Unauthorized)?;
    sqlx::query(
        "INSERT INTO community_members(community_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    )
    .bind(community)
    .bind(user)
    .execute(&mut *tx)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    tx.commit()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    Ok(Json(json!({"communityId":community})))
}

async fn accept_invite_link(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(token): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    let mut tx =
        s.db.begin()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
    let community = sqlx::query_scalar::<_, Uuid>("UPDATE community_invites SET uses=uses+1,status=CASE WHEN uses+1>=max_uses THEN 'accepted' ELSE status END WHERE token_hash=$1 AND status='pending' AND expires_at>now() AND uses<max_uses RETURNING community_id")
        .bind(token_hash(&token)).fetch_optional(&mut *tx).await.map_err(|e| ApiError::Internal(e.into()))?.ok_or_else(|| ApiError::Bad("Convite inválido ou expirado".into()))?;
    sqlx::query(
        "INSERT INTO community_members(community_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    )
    .bind(community)
    .bind(user)
    .execute(&mut *tx)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    tx.commit()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    Ok(Json(json!({"communityId":community})))
}
async fn require_member(db: &PgPool, community: Uuid, user: Uuid) -> Result<(), ApiError> {
    let ok = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2)",
    )
    .bind(community)
    .bind(user)
    .fetch_one(db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?;
    if ok {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}
async fn list_channels(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    require_member(&s.db, id, user).await?;
    let rows=sqlx::query_as::<_,(Uuid,String,String,Option<Uuid>)>("SELECT id,name,kind,voice_room_id FROM channels WHERE community_id=$1 ORDER BY position,created_at").bind(id).fetch_all(&s.db).await.map_err(|e|ApiError::Internal(e.into()))?;
    Ok(Json(json!(rows.into_iter().map(|(id,name,kind,voice_room_id)|json!({"id":id,"name":name,"kind":kind,"voiceRoomId":voice_room_id})).collect::<Vec<_>>())))
}
async fn create_channel(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<NewChannel>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    require_member(&s.db, id, user).await?;
    if !matches!(i.kind.as_str(), "text" | "voice") {
        return Err(ApiError::Bad("Tipo de canal inválido".into()));
    }
    let mut tx =
        s.db.begin()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
    let voice_room = if i.kind == "voice" {
        Some(
            sqlx::query_scalar::<_, Uuid>(
                "INSERT INTO rooms(name,owner_id)VALUES($1,$2)RETURNING id",
            )
            .bind(i.name.trim())
            .bind(user)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| ApiError::Internal(e.into()))?,
        )
    } else {
        None
    };
    let channel=sqlx::query_as::<_,(Uuid,String,String,Option<Uuid>)>("INSERT INTO channels(community_id,name,kind,voice_room_id,position)VALUES($1,$2,$3,$4,(SELECT COALESCE(max(position),-1)+1 FROM channels WHERE community_id=$1))RETURNING id,name,kind,voice_room_id").bind(id).bind(i.name.trim()).bind(&i.kind).bind(voice_room).fetch_one(&mut *tx).await.map_err(|e|ApiError::Internal(e.into()))?;
    tx.commit()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    Ok(Json(
        json!({"id":channel.0,"name":channel.1,"kind":channel.2,"voiceRoomId":channel.3}),
    ))
}
async fn list_messages(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    let community = sqlx::query_scalar::<_, Uuid>(
        "SELECT community_id FROM channels WHERE id=$1 AND kind='text'",
    )
    .bind(id)
    .fetch_optional(&s.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?
    .ok_or_else(|| ApiError::Bad("Canal não encontrado".into()))?;
    require_member(&s.db, community, user).await?;
    let rows=sqlx::query_as::<_,(Uuid,String,String,DateTime<Utc>)>("SELECT m.id,u.display_name,m.content,m.created_at FROM messages m JOIN users u ON u.id=m.author_id WHERE m.channel_id=$1 ORDER BY m.created_at DESC LIMIT 100").bind(id).fetch_all(&s.db).await.map_err(|e|ApiError::Internal(e.into()))?;
    Ok(Json(json!(rows.into_iter().rev().map(|(id,author,content,created_at)|json!({"id":id,"author":author,"content":content,"createdAt":created_at})).collect::<Vec<_>>())))
}
async fn create_message(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(i): Json<NewMessage>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    let community = sqlx::query_scalar::<_, Uuid>(
        "SELECT community_id FROM channels WHERE id=$1 AND kind='text'",
    )
    .bind(id)
    .fetch_optional(&s.db)
    .await
    .map_err(|e| ApiError::Internal(e.into()))?
    .ok_or_else(|| ApiError::Bad("Canal não encontrado".into()))?;
    require_member(&s.db, community, user).await?;
    let content = i.content.trim();
    if content.is_empty() || content.len() > 4000 {
        return Err(ApiError::Bad("Mensagem inválida".into()));
    }
    let row=sqlx::query_as::<_,(Uuid,String,DateTime<Utc>)>("WITH inserted AS (INSERT INTO messages(channel_id,author_id,content)VALUES($1,$2,$3)RETURNING id,created_at) SELECT inserted.id,u.display_name,inserted.created_at FROM inserted JOIN users u ON u.id=$2").bind(id).bind(user).bind(content).fetch_one(&s.db).await.map_err(|e|ApiError::Internal(e.into()))?;
    Ok(Json(
        json!({"id":row.0,"author":row.1,"content":content,"createdAt":row.2}),
    ))
}
async fn create_room(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(i): Json<NewRoom>,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    let id =
        sqlx::query_scalar::<_, Uuid>("INSERT INTO rooms(name,owner_id)VALUES($1,$2)RETURNING id")
            .bind(i.name.trim())
            .bind(user)
            .fetch_one(&s.db)
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
    Ok(Json(json!({"id":id})))
}
async fn turn_credentials(
    State(s): State<AppState>,
    h: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = bearer(&h, &s.config)?;
    let username = format!("{}:{}", (Utc::now() + Duration::hours(1)).timestamp(), user);
    let mut mac = Hmac::<Sha1>::new_from_slice(s.config.turn_secret.as_bytes())
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    mac.update(username.as_bytes());
    let credential = STANDARD.encode(mac.finalize().into_bytes());
    Ok(Json(
        json!({"iceServers":[{"urls":[format!("stun:{}:{}",s.config.turn_host,s.config.turn_port)]},{"urls":[format!("turn:{}:{}?transport=udp",s.config.turn_host,s.config.turn_port),format!("turn:{}:{}?transport=tcp",s.config.turn_host,s.config.turn_port)],"username":username,"credential":credential}]}),
    ))
}
