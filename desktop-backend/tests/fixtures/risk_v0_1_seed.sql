-- Snapshot representativo criado por Risk 0.1 após as migrações 0001..0005.
-- IDs são BLOB UUIDs de 16 bytes, como os gravados pelo sidecar real.
INSERT INTO users(id,display_name,email,password_hash,created_at) VALUES
  (x'00000000000040008000000000000001','Usuário legado','legacy@risk.local','legacy-password-hash',1700000000000),
  (x'00000000000040008000000000000002','Amigo legado','friend@risk.local','legacy-password-hash',1700000000001);

INSERT INTO app_state(key,value) VALUES('current_user_id','00000000-0000-4000-8000-000000000001');
INSERT INTO friendships(user_a,user_b,created_at) VALUES
  (x'00000000000040008000000000000001',x'00000000000040008000000000000002',1700000000100);

INSERT INTO rooms(id,name,owner_id,created_at) VALUES
  (x'00000000000040008000000000000010','Voz legado',x'00000000000040008000000000000001',1700000000200);
INSERT INTO room_members(room_id,user_id,joined_at) VALUES
  (x'00000000000040008000000000000010',x'00000000000040008000000000000001',1700000000201);
INSERT INTO communities(id,name,owner_id,created_at) VALUES
  (x'00000000000040008000000000000020','Clã legado',x'00000000000040008000000000000001',1700000000300);
INSERT INTO community_members(community_id,user_id,joined_at) VALUES
  (x'00000000000040008000000000000020',x'00000000000040008000000000000001',1700000000301);
INSERT INTO channels(id,community_id,name,kind,voice_room_id,position,created_at) VALUES
  (x'00000000000040008000000000000021',x'00000000000040008000000000000020','geral','text',NULL,0,1700000000400),
  (x'00000000000040008000000000000022',x'00000000000040008000000000000020','Geral','voice',x'00000000000040008000000000000010',1,1700000000401);
INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES
  (x'00000000000040008000000000000030',x'00000000000040008000000000000021',x'00000000000040008000000000000001','Mensagem local 0.1',1700000000500);

INSERT INTO p2p_friends(owner_user_id,peer_id,display_name,public_key_json,avatar,added_at) VALUES
  (x'00000000000040008000000000000001','peer_friend_legacy','Amigo P2P','{"kty":"EC","crv":"P-256","x":"legacy-x","y":"legacy-y"}',NULL,1700000000600);
INSERT INTO p2p_groups(owner_user_id,group_id,name,avatar,channels_json,members_json,joined_at,owner_peer_id,membership_version) VALUES
  (x'00000000000040008000000000000001','group_legacy_0001','Grupo P2P legado',NULL,
   '[{"id":"channel_legacy_text","name":"geral","kind":"text"},{"id":"channel_legacy_voice","name":"Geral","kind":"voice","voiceRoomId":"voice_legacy_room"}]',
   '[{"peerId":"peer_owner_legacy","displayName":"Usuário legado","publicKey":{"kty":"EC","crv":"P-256","x":"owner-x","y":"owner-y"}},{"peerId":"peer_friend_legacy","displayName":"Amigo P2P","publicKey":{"kty":"EC","crv":"P-256","x":"legacy-x","y":"legacy-y"}}]',
   1700000000700,'peer_owner_legacy',3);
INSERT INTO p2p_messages(owner_user_id,channel_id,id,author,content,created_at,author_peer_id,signature) VALUES
  (x'00000000000040008000000000000001','channel_legacy_text','message_legacy_0001','Usuário legado','Mensagem P2P 0.1','2023-11-14T22:13:20.000Z','peer_owner_legacy','legacy_signature');
