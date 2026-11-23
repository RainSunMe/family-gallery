package database

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

func Open(ctx context.Context, path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.ExecContext(ctx, schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE albums ADD COLUMN cover_photo_id TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
		db.Close()
		return nil, fmt.Errorf("migrate album cover: %w", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE photos ADD COLUMN contributor TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
		db.Close()
		return nil, fmt.Errorf("migrate photo contributor: %w", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE upload_sessions ADD COLUMN contributor TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
		db.Close()
		return nil, fmt.Errorf("migrate upload contributor: %w", err)
	}
	// Dedup: content_hash is the SHA-256 of the original bytes. dedup_key carries
	// the uniqueness so that content_hash stays a plain record. A NULL dedup_key
	// means "the user explicitly asked to add this duplicate"; SQLite allows many
	// NULLs in a UNIQUE index, so those rows never collide.
	for _, statement := range []string{
		`ALTER TABLE photos ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE photos ADD COLUMN dedup_key TEXT`,
		`ALTER TABLE upload_sessions ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE upload_sessions ADD COLUMN allow_duplicate INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE submission_items ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			db.Close()
			return nil, fmt.Errorf("migrate dedup column: %w", err)
		}
	}
	// Soft-deleted rows drop out of the index, so a photo in the trash never
	// blocks uploading the same bytes again.
	for _, statement := range []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS photos_album_dedup ON photos(album_id, dedup_key) WHERE dedup_key IS NOT NULL AND deleted_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS photos_content_hash ON photos(content_hash) WHERE content_hash <> ''`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			db.Close()
			return nil, fmt.Errorf("migrate dedup index: %w", err)
		}
	}
	return db, nil
}

const schema = `
CREATE TABLE IF NOT EXISTS albums (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 cover_key TEXT NOT NULL DEFAULT '', cover_photo_id TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS photos (
 id TEXT PRIMARY KEY, album_id TEXT NOT NULL REFERENCES albums(id), name TEXT NOT NULL,
 original_key TEXT NOT NULL UNIQUE, preview_key TEXT NOT NULL, thumb_key TEXT NOT NULL,
 mime TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
 contributor TEXT NOT NULL DEFAULT '', taken_at TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS photos_album_taken ON photos(album_id, deleted_at, taken_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
 id TEXT PRIMARY KEY, album_id TEXT NOT NULL REFERENCES albums(id), token_hash TEXT NOT NULL UNIQUE,
 created_by TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL, view_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS collections (
 id TEXT PRIMARY KEY, album_id TEXT NOT NULL REFERENCES albums(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active', expires_at TEXT,
 batch_limit INTEGER NOT NULL DEFAULT 20, allow_message INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_sessions (
 token_hash TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id), display_name TEXT NOT NULL,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS submission_items (
 id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id), session_hash TEXT NOT NULL,
 contributor TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
 original_key TEXT NOT NULL UNIQUE, preview_key TEXT NOT NULL, thumb_key TEXT NOT NULL,
 mime TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
 photo_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, imported_at TEXT
);
CREATE INDEX IF NOT EXISTS submissions_collection ON submission_items(collection_id, status, created_at DESC);
CREATE TABLE IF NOT EXISTS download_jobs (
 id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, owner_hash TEXT NOT NULL,
 mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', photo_ids TEXT NOT NULL DEFAULT '[]',
 progress INTEGER NOT NULL DEFAULT 0, file_count INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0,
 error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS download_packages (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES download_jobs(id), part_no INTEGER NOT NULL,
 object_key TEXT NOT NULL, size INTEGER NOT NULL, file_count INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_sessions (
 id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, actor_hash TEXT NOT NULL,
 original_key TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL,
 width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '',
 contributor TEXT NOT NULL DEFAULT '',
 cos_upload_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON download_jobs(status, created_at);
`

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
