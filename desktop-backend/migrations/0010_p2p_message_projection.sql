ALTER TABLE p2p_messages ADD COLUMN reply_to_id TEXT;
ALTER TABLE p2p_messages ADD COLUMN edited_content TEXT;
ALTER TABLE p2p_messages ADD COLUMN edited_at TEXT;
ALTER TABLE p2p_messages ADD COLUMN deleted_at TEXT;
ALTER TABLE p2p_messages ADD COLUMN pinned_at TEXT;
ALTER TABLE p2p_messages ADD COLUMN pinned_by_peer_id TEXT;
ALTER TABLE p2p_messages ADD COLUMN reactions_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX idx_p2p_chat_events_channel_target_timestamp
  ON p2p_chat_events(owner_user_id, channel_id, target_message_id, timestamp, id);
