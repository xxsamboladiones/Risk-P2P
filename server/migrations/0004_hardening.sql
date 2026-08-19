-- Backfill room membership for existing room owners and community voice channels.
INSERT INTO room_members(room_id, user_id)
SELECT id, owner_id FROM rooms
ON CONFLICT DO NOTHING;

INSERT INTO room_members(room_id, user_id)
SELECT c.voice_room_id, m.user_id
FROM channels c
JOIN community_members m ON m.community_id = c.community_id
WHERE c.kind = 'voice' AND c.voice_room_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Revoke duplicate direct pending invites before enforcing uniqueness.
WITH ranked AS (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY community_id, recipient_id
            ORDER BY created_at DESC, id DESC
        ) AS position
    FROM community_invites
    WHERE recipient_id IS NOT NULL AND status = 'pending'
)
UPDATE community_invites
SET status = 'revoked'
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

-- Prevent multiple direct pending invites for the same user/community pair.
CREATE UNIQUE INDEX IF NOT EXISTS community_invites_pending_recipient_unique
ON community_invites(community_id, recipient_id)
WHERE recipient_id IS NOT NULL AND status = 'pending';

CREATE INDEX IF NOT EXISTS sessions_refresh_active_idx
ON sessions(refresh_token_hash, expires_at)
WHERE revoked_at IS NULL;
