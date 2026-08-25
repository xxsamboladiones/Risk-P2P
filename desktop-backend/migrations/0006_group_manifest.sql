ALTER TABLE p2p_groups ADD COLUMN manifest_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE p2p_groups ADD COLUMN removed_peer_ids_json TEXT NOT NULL DEFAULT '[]';
