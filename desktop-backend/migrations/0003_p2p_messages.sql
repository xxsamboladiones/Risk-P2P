CREATE TABLE IF NOT EXISTS p2p_messages (
  owner_user_id BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  id TEXT NOT NULL,
  author TEXT NOT NULL CHECK(length(author) BETWEEN 1 AND 80),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id, channel_id, id)
);

CREATE INDEX IF NOT EXISTS p2p_messages_channel_idx
ON p2p_messages(owner_user_id, channel_id, created_at);
