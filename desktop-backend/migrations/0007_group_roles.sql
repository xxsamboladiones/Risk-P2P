ALTER TABLE p2p_groups ADD COLUMN administrator_peer_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE p2p_groups ADD COLUMN removed_members_json TEXT NOT NULL DEFAULT '[]';
