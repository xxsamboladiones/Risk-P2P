CREATE TABLE p2p_chat_events (
  owner_user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  id TEXT NOT NULL,
  target_message_id TEXT NOT NULL,
  actor_peer_id TEXT NOT NULL,
  action TEXT NOT NULL,
  content TEXT,
  reference_message_id TEXT,
  emoji TEXT,
  timestamp INTEGER NOT NULL,
  signature TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, channel_id, id),
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_p2p_chat_events_channel_timestamp
  ON p2p_chat_events(owner_user_id, channel_id, timestamp);

CREATE INDEX idx_p2p_chat_events_target
  ON p2p_chat_events(owner_user_id, channel_id, target_message_id);
