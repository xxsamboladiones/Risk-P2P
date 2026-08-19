CREATE TABLE friend_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(sender_id, recipient_id),
    CHECK(sender_id <> recipient_id)
);
CREATE TABLE friendships (
    user_a uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(user_a,user_b),
    CHECK(user_a < user_b)
);
CREATE TABLE communities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(100) NOT NULL,
    owner_id uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE community_members (
    community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(community_id,user_id)
);
CREATE TABLE channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name varchar(80) NOT NULL,
    kind varchar(10) NOT NULL CHECK(kind IN ('text','voice')),
    voice_room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
    position integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content varchar(4000) NOT NULL CHECK(length(trim(content)) > 0),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX friend_requests_recipient_idx ON friend_requests(recipient_id,status);
CREATE INDEX community_members_user_idx ON community_members(user_id);
CREATE INDEX channels_community_idx ON channels(community_id,position);
CREATE INDEX messages_channel_created_idx ON messages(channel_id,created_at DESC);
