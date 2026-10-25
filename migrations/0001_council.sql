PRAGMA foreign_keys = ON;
CREATE TABLE users (id TEXT PRIMARY KEY, login TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE sessions (hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE INDEX session_expiry ON sessions(expires_at);
CREATE TABLE oauth_states (
  hash TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('openrouter')),
  owner_id TEXT, session_hash TEXT NOT NULL, verifier TEXT NOT NULL,
  callback TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_expiry ON oauth_states(expires_at);
CREATE TABLE connections (owner_id TEXT PRIMARY KEY REFERENCES users(id), credential TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
  models TEXT NOT NULL CHECK(json_valid(models) AND json_array_length(models) BETWEEN 1 AND 8),
  version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(id, owner_id)
);
CREATE INDEX conversation_owner ON conversations(owner_id, updated_at DESC);
CREATE TABLE turns (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  sequence INTEGER NOT NULL, idempotency_key TEXT NOT NULL, prompt TEXT NOT NULL,
  search INTEGER NOT NULL CHECK(search IN (0,1)), created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, sequence), UNIQUE(conversation_id, idempotency_key),
  UNIQUE(id, conversation_id, owner_id),
  FOREIGN KEY(conversation_id, owner_id) REFERENCES conversations(id, owner_id) ON DELETE CASCADE
);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, conversation_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  model_id TEXT NOT NULL, number INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','complete','stopped','interrupted','error')),
  text TEXT NOT NULL DEFAULT '', citations TEXT NOT NULL DEFAULT '[]', usage TEXT,
  error TEXT, provider_id TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  lease_until INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0,
  UNIQUE(turn_id, model_id, number), UNIQUE(turn_id, model_id, idempotency_key),
  FOREIGN KEY(turn_id, conversation_id, owner_id) REFERENCES turns(id, conversation_id, owner_id) ON DELETE CASCADE
);
CREATE INDEX active_attempts ON attempts(owner_id, status, lease_until);
CREATE INDEX attempts_conversation ON attempts(conversation_id, turn_id, model_id, number);
CREATE TRIGGER pin_attempt_model BEFORE INSERT ON attempts
WHEN NOT EXISTS (SELECT 1 FROM conversations c, json_each(c.models) m WHERE c.id=NEW.conversation_id AND c.owner_id=NEW.owner_id AND m.value=NEW.model_id)
BEGIN SELECT RAISE(ABORT, 'model_not_pinned'); END;
CREATE TABLE catalog_cache (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, fetched_at INTEGER NOT NULL);
