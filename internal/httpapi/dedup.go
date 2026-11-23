package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
)

// maxDedupHashes bounds the pre-check request. A batch of 200 is already far
// more than anyone selects at once.
const maxDedupHashes = 200

// validateContentHash accepts a lowercase hex SHA-256 digest. An empty value is
// allowed and means the client did not compute a hash: the upload then behaves
// exactly as it did before dedup existed.
func validateContentHash(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", true
	}
	if len(value) != 64 || strings.ToLower(value) != value {
		return "", false
	}
	if _, err := hex.DecodeString(value); err != nil {
		return "", false
	}
	return value, true
}

// dedupKeyFor decides what lands in photos.dedup_key. A nil key exempts the row
// from the unique index, which is how "add it anyway" is expressed.
func dedupKeyFor(hash string, allowDuplicate bool) any {
	if hash == "" || allowDuplicate {
		return nil
	}
	return hash
}

// isUniqueViolation reports whether err came from a unique index. modernc sqlite
// phrases it as "constraint failed: UNIQUE constraint failed: table.col", so a
// case-insensitive substring check is enough and avoids driver-specific codes.
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(strings.ToUpper(err.Error()), "UNIQUE CONSTRAINT FAILED")
}

type duplicatePhoto struct {
	ID          string
	Name        string
	Contributor string
	TakenAt     string
	ThumbKey    string
}

// findDuplicate returns the photo already holding these bytes in this album, or
// nil when there is none. Soft-deleted rows are ignored: a photo in the trash
// must not block uploading the same file again.
func findDuplicate(ctx context.Context, db *sql.DB, albumID, hash string) (*duplicatePhoto, error) {
	if hash == "" || albumID == "" {
		return nil, nil
	}
	var item duplicatePhoto
	err := db.QueryRowContext(ctx,
		`SELECT id,name,contributor,taken_at,thumb_key FROM photos
		 WHERE album_id=? AND content_hash=? AND deleted_at IS NULL
		 ORDER BY created_at LIMIT 1`, albumID, hash).
		Scan(&item.ID, &item.Name, &item.Contributor, &item.TakenAt, &item.ThumbKey)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

// legacyCount reports how many photos in this album predate dedup and therefore
// cannot be matched. The UI shows it so the limitation is never hidden.
func legacyCount(ctx context.Context, db *sql.DB, albumID string) int {
	var count int
	_ = db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM photos WHERE album_id=? AND deleted_at IS NULL AND content_hash=''`, albumID).
		Scan(&count)
	return count
}

func (a *API) checkDuplicates(w http.ResponseWriter, r *http.Request) {
	var input struct {
		AlbumID string   `json:"album_id"`
		Hashes  []string `json:"hashes"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	var exists int
	if err := a.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM albums WHERE id=? AND deleted_at IS NULL`, input.AlbumID).Scan(&exists); err != nil || exists == 0 {
		writeError(w, http.StatusNotFound, "ALBUM_NOT_FOUND", T(r)("target_album_missing"))
		return
	}
	wanted := make([]string, 0, len(input.Hashes))
	seen := make(map[string]bool, len(input.Hashes))
	for _, raw := range input.Hashes {
		hash, ok := validateContentHash(raw)
		if !ok || hash == "" {
			writeError(w, http.StatusBadRequest, "INVALID_HASH", T(r)("invalid_hash"))
			return
		}
		if seen[hash] {
			continue
		}
		seen[hash] = true
		wanted = append(wanted, hash)
	}
	if len(wanted) > maxDedupHashes {
		writeError(w, http.StatusBadRequest, "TOO_MANY_HASHES", T(r)("too_many_hashes"))
		return
	}
	duplicates := make(map[string]any)
	fresh := make([]string, 0, len(wanted))
	if !a.cfg.DedupEnabled || len(wanted) == 0 {
		// Dedup off: everything is new, and there is nothing to warn about.
		writeJSON(w, http.StatusOK, map[string]any{"duplicates": duplicates, "new": wanted, "legacy_photos": 0})
		return
	}
	args := make([]any, 0, len(wanted)+1)
	args = append(args, input.AlbumID)
	for _, hash := range wanted {
		args = append(args, hash)
	}
	rows, err := a.db.QueryContext(r.Context(),
		`SELECT content_hash,id,name,contributor,taken_at,thumb_key FROM photos
		 WHERE album_id=? AND deleted_at IS NULL AND content_hash IN (`+placeholders(len(wanted))+`)`, args...)
	if err != nil {
		a.internal(w, err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var hash string
		var item duplicatePhoto
		if err := rows.Scan(&hash, &item.ID, &item.Name, &item.Contributor, &item.TakenAt, &item.ThumbKey); err != nil {
			a.internal(w, err)
			return
		}
		if _, done := duplicates[hash]; done {
			continue
		}
		thumbURL, _ := a.store.SignRead(r.Context(), item.ThumbKey, "")
		duplicates[hash] = map[string]any{
			"id": item.ID, "name": item.Name, "contributor": item.Contributor,
			"taken_at": item.TakenAt, "thumb_url": thumbURL,
		}
	}
	for _, hash := range wanted {
		if _, hit := duplicates[hash]; !hit {
			fresh = append(fresh, hash)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"duplicates":    duplicates,
		"new":           fresh,
		"legacy_photos": legacyCount(r.Context(), a.db, input.AlbumID),
	})
}

// duplicateResponse tells the client which photo already holds these bytes.
func (a *API) duplicateResponse(w http.ResponseWriter, r *http.Request, found *duplicatePhoto) {
	thumbURL, _ := a.store.SignRead(r.Context(), found.ThumbKey, "")
	writeJSON(w, http.StatusConflict, map[string]any{
		"error": map[string]string{"code": "DUPLICATE_PHOTO", "message": T(r)("duplicate_photo")},
		"existing": map[string]any{
			"id": found.ID, "name": found.Name, "contributor": found.Contributor,
			"taken_at": found.TakenAt, "thumb_url": thumbURL,
		},
	})
}

// backfillHashes fills content_hash for photos uploaded before dedup existed.
// It is opt-in through DEDUP_BACKFILL because it reads every original back out
// of the bucket. Rows are processed in small batches so a restart resumes
// instead of starting over.
func (a *API) backfillHashes(ctx context.Context) {
	const batch = 20
	for {
		if ctx.Err() != nil {
			return
		}
		rows, err := a.db.QueryContext(ctx,
			`SELECT id,album_id,original_key FROM photos WHERE content_hash='' AND deleted_at IS NULL LIMIT ?`, batch)
		if err != nil {
			a.log.Warn("dedup backfill query failed", "error", err)
			return
		}
		type pending struct{ id, albumID, key string }
		items := make([]pending, 0, batch)
		for rows.Next() {
			var item pending
			if err := rows.Scan(&item.id, &item.albumID, &item.key); err != nil {
				rows.Close()
				a.log.Warn("dedup backfill scan failed", "error", err)
				return
			}
			items = append(items, item)
		}
		rows.Close()
		if len(items) == 0 {
			a.log.Info("dedup backfill finished")
			return
		}
		for _, item := range items {
			if ctx.Err() != nil {
				return
			}
			hash, err := a.hashObject(ctx, item.key)
			if err != nil {
				a.log.Warn("dedup backfill could not read original", "photo", item.id, "error", err)
				// Mark it so the row is not retried forever: an unreadable
				// original means it can never be deduplicated anyway.
				_, _ = a.db.ExecContext(ctx, `UPDATE photos SET content_hash='-' WHERE id=?`, item.id)
				continue
			}
			// Existing duplicates in the same album stay as they are; only the
			// first one keeps the unique key.
			if _, err := a.db.ExecContext(ctx, `UPDATE photos SET content_hash=?,dedup_key=? WHERE id=?`, hash, hash, item.id); err != nil && isUniqueViolation(err) {
				_, _ = a.db.ExecContext(ctx, `UPDATE photos SET content_hash=?,dedup_key=NULL WHERE id=?`, hash, item.id)
			}
		}
	}
}

func (a *API) hashObject(ctx context.Context, key string) (string, error) {
	body, err := a.store.Get(ctx, key)
	if err != nil {
		return "", err
	}
	defer body.Close()
	sum := sha256.New()
	if _, err := io.Copy(sum, body); err != nil {
		return "", err
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}
