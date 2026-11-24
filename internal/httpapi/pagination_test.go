package httpapi

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/RainSunMe/family-gallery/internal/database"
)

// A page boundary used to swallow one photo: the query fetches limit+1 rows to
// learn whether more exist, and the cursor was taken from that extra probe row.
// The next page then resumed strictly after it, so the probe row was never
// served. With 250 photos and pages of 50 the user was silently missing four.
func TestPhotoPaginationLosesNoRow(t *testing.T) {
	ctx := context.Background()
	db, err := database.Open(ctx, filepath.Join(t.TempDir(), "gallery.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, `INSERT INTO albums(id,name,created_at,updated_at) VALUES('a','a','t','t')`); err != nil {
		t.Fatalf("seed album: %v", err)
	}
	// Timestamps repeat on purpose: a burst of uploads shares the same second,
	// which is exactly when the tie-break on id has to carry the cursor.
	const total = 250
	for index := 0; index < total; index++ {
		id := "p" + pad(index)
		taken := "2026-01-01T00:00:0" + string(rune('0'+index%3)) + "Z"
		if _, err := db.ExecContext(ctx,
			`INSERT INTO photos(id,album_id,name,original_key,preview_key,thumb_key,mime,size,taken_at,created_at)
			 VALUES(?,?,?,?,?,?,?,?,?,?)`,
			id, "a", id, "k/"+id, "p/"+id, "t/"+id, "image/jpeg", 1, taken, taken); err != nil {
			t.Fatalf("seed photo %s: %v", id, err)
		}
	}

	const limit = 40
	seen := map[string]bool{}
	cursor := ""
	for page := 0; page < 20; page++ {
		query := `SELECT p.id,p.album_id,p.name,p.mime,p.size,p.width,p.height,p.taken_at,p.thumb_key,p.contributor
		          FROM photos p WHERE p.deleted_at IS NULL`
		args := []any{}
		if cursor != "" {
			query += ` AND (p.taken_at<? OR (p.taken_at=? AND p.id<?))`
			args = append(args, splitCursorTaken(cursor), splitCursorTaken(cursor), splitCursorID(cursor))
		}
		query += ` ORDER BY p.taken_at DESC,p.id DESC LIMIT ?`
		args = append(args, limit+1)
		rows, err := db.QueryContext(ctx, query, args...)
		if err != nil {
			t.Fatalf("query page %d: %v", page, err)
		}
		photos, _, next, err := collectPhotoPage(rows, limit)
		rows.Close()
		if err != nil {
			t.Fatalf("collect page %d: %v", page, err)
		}
		for _, photo := range photos {
			if seen[photo.ID] {
				t.Fatalf("photo %s was served twice", photo.ID)
			}
			seen[photo.ID] = true
		}
		cursor = next
		if cursor == "" {
			break
		}
	}
	if len(seen) != total {
		t.Fatalf("expected all %d photos to be reachable, got %d", total, len(seen))
	}
}

func pad(value int) string {
	out := []byte("000")
	for position := 2; value > 0 && position >= 0; position-- {
		out[position] = byte('0' + value%10)
		value /= 10
	}
	return string(out)
}

func splitCursorTaken(cursor string) string {
	for index := 0; index < len(cursor); index++ {
		if cursor[index] == '|' {
			return cursor[:index]
		}
	}
	return cursor
}

func splitCursorID(cursor string) string {
	for index := 0; index < len(cursor); index++ {
		if cursor[index] == '|' {
			return cursor[index+1:]
		}
	}
	return ""
}
