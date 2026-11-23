package httpapi

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/RainSunMe/family-gallery/internal/database"
)

func TestTokenHashChangesWithToken(t *testing.T) {
	if tokenHash("first") == tokenHash("second") {
		t.Fatal("session tokens must not share hashes")
	}
	if tokenHash("first") != tokenHash("first") {
		t.Fatal("hash must be deterministic")
	}
	if len(randomToken()) != 64 {
		t.Fatal("session token must contain 32 random bytes")
	}
}

func TestUniqueName(t *testing.T) {
	used := map[string]int{}
	if got := uniqueName("family.jpg", used); got != "family.jpg" {
		t.Fatalf("unexpected name %q", got)
	}
	if got := uniqueName("family.jpg", used); got != "family (2).jpg" {
		t.Fatalf("unexpected duplicate name %q", got)
	}
	if got := uniqueName("family.jpg", used); got != "family (3).jpg" {
		t.Fatalf("unexpected duplicate name %q", got)
	}
}

func TestValidateUpload(t *testing.T) {
	valid := uploadRequest{Name: "family.jpg", Size: 1024, Mime: "image/jpeg"}
	if _, ok := validateUpload(valid, 200<<20); !ok {
		t.Fatal("valid image should be accepted")
	}
	invalid := valid
	invalid.Size = 0
	if _, ok := validateUpload(invalid, 200<<20); ok {
		t.Fatal("empty file must be rejected")
	}
	invalid = valid
	invalid.Mime = "application/x-msdownload"
	if _, ok := validateUpload(invalid, 200<<20); ok {
		t.Fatal("executable must be rejected")
	}
	invalid = valid
	invalid.Size = 201 << 20
	if _, ok := validateUpload(invalid, 200<<20); ok {
		t.Fatal("oversized file must be rejected")
	}
	if _, ok := validateUpload(invalid, 300<<20); !ok {
		t.Fatal("file within configured limit must be accepted")
	}
}

func TestPlaceholders(t *testing.T) {
	if got := placeholders(3); got != "?,?,?" {
		t.Fatalf("unexpected placeholders %q", got)
	}
}

func TestValidateContentHash(t *testing.T) {
	valid := strings.Repeat("a1", 32)
	if got, ok := validateContentHash(valid); !ok || got != valid {
		t.Fatalf("valid digest rejected: %q %v", got, ok)
	}
	if got, ok := validateContentHash("  " + valid + "  "); !ok || got != valid {
		t.Fatalf("surrounding space should be trimmed: %q %v", got, ok)
	}
	// Empty means "this client did not hash the file", which stays allowed so an
	// older frontend keeps working.
	if got, ok := validateContentHash(""); !ok || got != "" {
		t.Fatalf("empty hash must be accepted but stay empty: %q %v", got, ok)
	}
	for _, bad := range []string{
		strings.Repeat("a", 63),
		strings.Repeat("a", 65),
		strings.ToUpper(valid),
		strings.Repeat("z", 64),
		valid[:63] + "-",
	} {
		if _, ok := validateContentHash(bad); ok {
			t.Fatalf("invalid digest accepted: %q", bad)
		}
	}
}

func TestDedupKeyFor(t *testing.T) {
	hash := strings.Repeat("ab", 32)
	if got := dedupKeyFor(hash, false); got != hash {
		t.Fatalf("normal upload must carry the hash as its dedup key, got %v", got)
	}
	if got := dedupKeyFor(hash, true); got != nil {
		t.Fatalf("allowing a duplicate must exempt the row from the unique index, got %v", got)
	}
	if got := dedupKeyFor("", false); got != nil {
		t.Fatalf("a hashless upload must not take part in the index, got %v", got)
	}
}

func TestFindDuplicate(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, filepath.Join(t.TempDir(), "gallery.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	timestamp := "2026-01-01T00:00:00Z"
	for _, album := range []string{"album-a", "album-b"} {
		if _, err := db.ExecContext(ctx, `INSERT INTO albums(id,name,created_at,updated_at) VALUES(?,?,?,?)`, album, album, timestamp, timestamp); err != nil {
			t.Fatalf("seed album: %v", err)
		}
	}
	hash := strings.Repeat("cd", 32)
	insert := func(id, album, dedupKey string) {
		t.Helper()
		var key any
		if dedupKey != "" {
			key = dedupKey
		}
		_, err := db.ExecContext(ctx,
			`INSERT INTO photos(id,album_id,name,original_key,preview_key,thumb_key,mime,size,content_hash,dedup_key,taken_at,created_at)
			 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
			id, album, id+".jpg", "k/"+id, "p/"+id, "t/"+id, "image/jpeg", 10, hash, key, timestamp, timestamp)
		if err != nil {
			t.Fatalf("seed photo %s: %v", id, err)
		}
	}
	insert("p1", "album-a", hash)

	found, err := findDuplicate(ctx, db, "album-a", hash)
	if err != nil || found == nil || found.ID != "p1" {
		t.Fatalf("expected a hit in album-a, got %+v %v", found, err)
	}
	// The same bytes in a different album are a separate photo on purpose:
	// dedup is scoped per album.
	if found, err := findDuplicate(ctx, db, "album-b", hash); err != nil || found != nil {
		t.Fatalf("album-b must not report a duplicate, got %+v %v", found, err)
	}
	// A soft-deleted photo must not block re-uploading the same bytes.
	if _, err := db.ExecContext(ctx, `UPDATE photos SET deleted_at=? WHERE id='p1'`, timestamp); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	if found, err := findDuplicate(ctx, db, "album-a", hash); err != nil || found != nil {
		t.Fatalf("trashed photo must not be reported as a duplicate, got %+v %v", found, err)
	}
	// Re-inserting after the soft delete must be allowed by the unique index.
	insert("p2", "album-a", hash)
	if found, err := findDuplicate(ctx, db, "album-a", hash); err != nil || found == nil || found.ID != "p2" {
		t.Fatalf("expected the fresh row, got %+v %v", found, err)
	}
}

func TestUniqueIndexRejectsSecondCopy(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, filepath.Join(t.TempDir(), "gallery.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	timestamp := "2026-01-01T00:00:00Z"
	if _, err := db.ExecContext(ctx, `INSERT INTO albums(id,name,created_at,updated_at) VALUES('a','a',?,?)`, timestamp, timestamp); err != nil {
		t.Fatalf("seed album: %v", err)
	}
	hash := strings.Repeat("ef", 32)
	insert := func(id string, key any) error {
		_, err := db.ExecContext(ctx,
			`INSERT INTO photos(id,album_id,name,original_key,preview_key,thumb_key,mime,size,content_hash,dedup_key,taken_at,created_at)
			 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
			id, "a", id, "k/"+id, "p/"+id, "t/"+id, "image/jpeg", 1, hash, key, timestamp, timestamp)
		return err
	}
	if err := insert("first", hash); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	if err := insert("second", hash); !isUniqueViolation(err) {
		t.Fatalf("second identical insert must hit the unique index, got %v", err)
	}
	// "Add anyway" writes a NULL key, which SQLite's UNIQUE index tolerates.
	if err := insert("third", nil); err != nil {
		t.Fatalf("explicit duplicate must be allowed: %v", err)
	}
	if err := insert("fourth", nil); err != nil {
		t.Fatalf("a second explicit duplicate must also be allowed: %v", err)
	}
}
