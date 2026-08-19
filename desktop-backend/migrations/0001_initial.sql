PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id BLOB PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 2 AND 80),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id BLOB PRIMARY KEY NOT NULL,
  sender_id BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  created_at INTEGER NOT NULL,
  UNIQUE(sender_id, recipient_id)
);

CREATE TABLE IF NOT EXISTS friendships (
  user_a BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_a, user_b),
  CHECK(user_a <> user_b)
);

CREATE TABLE IF NOT EXISTS rooms (
  id BLOB PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 100),
  owner_id BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id BLOB NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(room_id, user_id)
);

CREATE TABLE IF NOT EXISTS communities (
  id BLOB PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 100),
  owner_id BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS community_members (
  community_id BLOB NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(community_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id BLOB PRIMARY KEY NOT NULL,
  community_id BLOB NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 80),
  kind TEXT NOT NULL CHECK(kind IN ('text','voice')),
  voice_room_id BLOB REFERENCES rooms(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id BLOB PRIMARY KEY NOT NULL,
  channel_id BLOB NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 4000),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS friend_requests_recipient_idx ON friend_requests(recipient_id, status);
CREATE INDEX IF NOT EXISTS friendships_user_a_idx ON friendships(user_a);
CREATE INDEX IF NOT EXISTS friendships_user_b_idx ON friendships(user_b);
CREATE INDEX IF NOT EXISTS community_members_user_idx ON community_members(user_id);
CREATE INDEX IF NOT EXISTS channels_community_idx ON channels(community_id, position);
CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members(user_id);
