CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(name), p256dh TEXT NOT NULL, auth TEXT NOT NULL, session TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE, generation TEXT NOT NULL, created INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS push_subscriptions_account ON push_subscriptions(account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS push_subscriptions_session ON push_subscriptions(session);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS push_vapid_keys (id INTEGER PRIMARY KEY CHECK (id = 1), public_key TEXT NOT NULL, private_jwk TEXT NOT NULL);
