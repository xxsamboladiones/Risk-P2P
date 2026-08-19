CREATE TABLE community_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    inviter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id uuid REFERENCES users(id) ON DELETE CASCADE,
    token_hash varchar(64) UNIQUE,
    status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
    max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
    uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (recipient_id IS NOT NULL OR token_hash IS NOT NULL)
);
CREATE INDEX community_invites_recipient_idx ON community_invites(recipient_id,status);
CREATE INDEX community_invites_community_idx ON community_invites(community_id,status);
