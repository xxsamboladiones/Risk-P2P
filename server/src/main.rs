use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{Duration, Utc};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{collections::HashMap, env, sync::Arc};
use tokio::sync::{mpsc, RwLock};
use tower_http::{
    cors::{Any, CorsLayer},
    limit::RequestBodyLimitLayer,
    trace::TraceLayer,
};
use uuid::Uuid;

#[derive(Clone)]
struct Config {
    jwt: String,
    turn_host: String,
    turn_port: u16,
    turn_secret: String,
}
#[derive(Clone)]
struct AppState {
    db: PgPool,
    config: Config,
    peers: Arc<RwLock<HashMap<Uuid, Peer>>>,
}
#[derive(Clone)]
struct Peer {
    name: String,
    room: Option<Uuid>,
    state: Value,
    tx: mpsc::UnboundedSender<Message>,
}
#[derive(Serialize, Deserialize)]
struct Claims {
    sub: Uuid,
    exp: usize,
    kind: String,
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
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
        },
        peers: Default::default(),
    };
    let app = Router::new()
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }))
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/rooms", post(create_room))
        .route("/rtc/credentials", get(turn_credentials))
        .route("/ws", get(ws_upgrade))
        .layer(RequestBodyLimitLayer::new(64 * 1024))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
                .allow_methods(Any),
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
) -> Result<Json<TokenResponse>, ApiError> {
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
    Ok(Json(TokenResponse {
        access_token: issue(&s.config, id)?,
    }))
}
async fn login(
    State(s): State<AppState>,
    Json(i): Json<Login>,
) -> Result<Json<TokenResponse>, ApiError> {
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
    Ok(Json(TokenResponse {
        access_token: issue(&s.config, row.0)?,
    }))
}
fn issue(c: &Config, id: Uuid) -> Result<String, ApiError> {
    encode(
        &Header::default(),
        &Claims {
            sub: id,
            exp: (Utc::now() + Duration::minutes(15)).timestamp() as usize,
            kind: "access".into(),
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

async fn ws_upgrade(ws: WebSocketUpgrade, State(s): State<AppState>) -> impl IntoResponse {
    ws.max_message_size(64 * 1024)
        .on_upgrade(move |socket| websocket(socket, s))
}
async fn websocket(socket: WebSocket, s: AppState) {
    let id = Uuid::new_v4();
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if sink.send(m).await.is_err() {
                break;
            }
        }
    });
    let mut authed = false;
    while let Some(Ok(Message::Text(text))) = stream.next().await {
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            send_error(&tx, "invalid-json", "Mensagem inválida");
            continue;
        };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "authenticate" {
            let Some(token) = v.get("token").and_then(Value::as_str) else {
                continue;
            };
            if let Ok(data) = decode::<Claims>(
                token,
                &DecodingKey::from_secret(s.config.jwt.as_bytes()),
                &Validation::default(),
            ) {
                if let Ok(name) =
                    sqlx::query_scalar::<_, String>("SELECT display_name FROM users WHERE id=$1")
                        .bind(data.claims.sub)
                        .fetch_one(&s.db)
                        .await
                {
                    s.peers.write().await.insert(
                        id,
                        Peer {
                            name,
                            room: None,
                            state: json!({"microphone":true,"camera":false,"screenShare":false}),
                            tx: tx.clone(),
                        },
                    );
                    authed = true;
                    let _ = tx.send(msg(
                        json!({"type":"authenticated","peerId":id,"userId":data.claims.sub}),
                    ));
                }
            } else {
                send_error(&tx, "unauthorized", "Token inválido")
            }
            continue;
        }
        if !authed {
            send_error(&tx, "unauthorized", "Autentique primeiro");
            continue;
        }
        handle(id, v, &s).await
    }
    leave(id, &s).await;
    s.peers.write().await.remove(&id);
    writer.abort()
}
async fn handle(id: Uuid, v: Value, s: &AppState) {
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "heartbeat" {
        if let Some(p) = s.peers.read().await.get(&id) {
            let _ = p.tx.send(msg(json!({"type":"pong"})));
        }
        return;
    }
    let room = v
        .get("roomId")
        .and_then(Value::as_str)
        .and_then(|x| Uuid::parse_str(x).ok());
    match kind {
        "join-room" => {
            let Some(room) = room else { return };
            let exists =
                sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM rooms WHERE id=$1)")
                    .bind(room)
                    .fetch_one(&s.db)
                    .await
                    .unwrap_or(false);
            if !exists {
                return;
            }
            let mut peers = s.peers.write().await;
            let list: Vec<Value> = peers
                .iter()
                .filter(|(pid, p)| **pid != id && p.room == Some(room))
                .map(|(pid, p)| json!({"peerId":pid,"displayName":p.name,"state":p.state.clone()}))
                .collect();
            if list.len() >= 5 {
                if let Some(p) = peers.get(&id) {
                    send_error(&p.tx, "room-full", "Limite P2P de 6 pessoas atingido")
                }
                return;
            }
            if let Some(me) = peers.get_mut(&id) {
                me.room = Some(room);
                let _ = me.tx.send(msg(
                    json!({"type":"room-joined","roomId":room,"peers":list}),
                ));
            }
            let name = peers.get(&id).map(|p| p.name.clone()).unwrap_or_default();
            let state = peers
                .get(&id)
                .map(|p| p.state.clone())
                .unwrap_or_else(|| json!({}));
            broadcast(
                &peers,
                room,
                Some(id),
                json!({"type":"peer-joined","roomId":room,"peerId":id,"displayName":name,"state":state}),
            )
        }
        "leave-room" => leave(id, s).await,
        "offer" | "answer" | "ice-candidate" => {
            let Some(room) = room else { return };
            let target = v
                .get("targetPeerId")
                .and_then(Value::as_str)
                .and_then(|x| Uuid::parse_str(x).ok());
            let peers = s.peers.read().await;
            if peers.get(&id).and_then(|p| p.room) != Some(room) {
                return;
            }
            if let Some(target) = target.and_then(|x| peers.get(&x)) {
                if target.room == Some(room) {
                    let mut out = v;
                    out["fromPeerId"] = json!(id);
                    let _ = target.tx.send(msg(out));
                }
            }
        }
        "peer-state" => {
            let Some(room) = room else { return };
            let state = v.get("state").cloned().unwrap_or(json!({}));
            let mut peers = s.peers.write().await;
            if peers.get(&id).and_then(|p| p.room) == Some(room) {
                if let Some(peer) = peers.get_mut(&id) {
                    peer.state = state.clone();
                }
                broadcast(
                    &peers,
                    room,
                    Some(id),
                    json!({"type":"peer-state","roomId":room,"peerId":id,"state":state}),
                )
            }
        }
        _ => {}
    }
}
async fn leave(id: Uuid, s: &AppState) {
    let mut peers = s.peers.write().await;
    if let Some(room) = peers.get(&id).and_then(|p| p.room) {
        if let Some(me) = peers.get_mut(&id) {
            me.room = None
        }
        broadcast(
            &peers,
            room,
            Some(id),
            json!({"type":"peer-left","roomId":room,"peerId":id}),
        )
    }
}
fn broadcast(peers: &HashMap<Uuid, Peer>, room: Uuid, except: Option<Uuid>, v: Value) {
    for (id, p) in peers {
        if Some(*id) != except && p.room == Some(room) {
            let _ = p.tx.send(msg(v.clone()));
        }
    }
}
fn msg(v: Value) -> Message {
    Message::Text(v.to_string().into())
}
fn send_error(tx: &mpsc::UnboundedSender<Message>, code: &str, message: &str) {
    let _ = tx.send(msg(json!({"type":"error","code":code,"message":message})));
}
