CREATE TABLE IF NOT EXISTS accounts (name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, expires TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms(expires);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
