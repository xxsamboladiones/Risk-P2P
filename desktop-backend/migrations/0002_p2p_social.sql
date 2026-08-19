CREATE TABLE IF NOT EXISTS p2p_friends (
  owner_user_id BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
  public_key_json TEXT NOT NULL,
  avatar TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY(owner_user_id, peer_id)
);

CREATE TABLE IF NOT EXISTS p2p_groups (
  owner_user_id BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  avatar TEXT,
  channels_json TEXT NOT NULL,
  members_json TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(owner_user_id, group_id)
);

CREATE INDEX IF NOT EXISTS p2p_friends_owner_idx ON p2p_friends(owner_user_id, added_at);
CREATE INDEX IF NOT EXISTS p2p_groups_owner_idx ON p2p_groups(owner_user_id, joined_at);
