CREATE TABLE IF NOT EXISTS account_profiles (account_id TEXT PRIMARY KEY REFERENCES accounts(name), nickname TEXT NOT NULL);
