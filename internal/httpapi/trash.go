package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

const maxTrashBatch = 500

// trashPhotos soft-deletes the given photos and returns the batch id plus the
// album ids that lost their cover. Everything visible is filtered by
// deleted_at already, so marking the rows is enough to hide them.
func (a *API) trashPhotos(w http.ResponseWriter, r *http.Request) {
	var input struct {
		IDs []string `json:"ids"`
		// By is the name the client keeps in localStorage. It is a label for the
		// trash list, never an identity: the server cannot verify it.
		By string `json:"by"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if len(input.IDs) == 0 || len(input.IDs) > maxTrashBatch {
		writeError(w, http.StatusBadRequest, "INVALID_SELECTION", T(r)("invalid_selection"))
		return
	}
	batch := newID()
	trashed, err := a.softDeletePhotos(r.Context(), input.IDs, cleanContributor(input.By), batch)
	if err != nil {
		a.internal(w, err)
		return
	}
	// Old download packages still hold the bytes of what was just deleted. They
	// must go, otherwise a deleted private photo stays downloadable.
	a.invalidateDownloadJobs(r.Context(), input.IDs)
	writeJSON(w, http.StatusOK, map[string]any{"trashed": trashed, "batch": batch})
}

func (a *API) softDeletePhotos(ctx context.Context, ids []string, actor, batch string) (int, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	timestamp := now()
	args := []any{timestamp, actor, batch}
	for _, id := range ids {
		args = append(args, id)
	}
	result, err := tx.ExecContext(ctx,
		`UPDATE photos SET deleted_at=?,deleted_by=?,trash_batch=?
		 WHERE id IN (`+placeholders(len(ids))+`) AND deleted_at IS NULL`, args...)
	if err != nil {
		return 0, err
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		return 0, tx.Commit()
	}
	// A deleted photo must not stay the album cover: clearing both fields lets
	// the existing "newest remaining photo" fallback take over.
	albumArgs := make([]any, 0, len(ids))
	for _, id := range ids {
		albumArgs = append(albumArgs, id)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE albums SET cover_key='',cover_photo_id='',updated_at=?
		 WHERE cover_photo_id IN (`+placeholders(len(ids))+`)`, append([]any{timestamp}, albumArgs...)...); err != nil {
		return 0, err
	}
	return int(affected), tx.Commit()
}

// invalidateDownloadJobs drops any packaging job that referenced one of these
// photos, together with its archive. The rows are short-lived anyway, and the
// alternative (rewriting an existing ZIP) is not possible.
func (a *API) invalidateDownloadJobs(ctx context.Context, ids []string) {
	target := make(map[string]bool, len(ids))
	for _, id := range ids {
		target[id] = true
	}
	rows, err := a.db.QueryContext(ctx, `SELECT id,photo_ids FROM download_jobs`)
	if err != nil {
		a.log.Warn("trash: could not scan download jobs", "error", err)
		return
	}
	type victim struct{ id, raw string }
	affected := make([]victim, 0)
	for rows.Next() {
		var id, raw string
		if err := rows.Scan(&id, &raw); err != nil {
			continue
		}
		var photoIDs []string
		if json.Unmarshal([]byte(raw), &photoIDs) != nil {
			continue
		}
		for _, photoID := range photoIDs {
			if target[photoID] {
				affected = append(affected, victim{id: id, raw: raw})
				break
			}
		}
	}
	rows.Close()
	for _, job := range affected {
		pkgRows, err := a.db.QueryContext(ctx, `SELECT object_key FROM download_packages WHERE job_id=?`, job.id)
		if err != nil {
			continue
		}
		keys := make([]string, 0)
		for pkgRows.Next() {
			var key string
			if pkgRows.Scan(&key) == nil {
				keys = append(keys, key)
			}
		}
		pkgRows.Close()
		for _, key := range keys {
			// A failed delete leaves an unreferenced object, which is better than
			// leaving a live package containing deleted photos.
			if err := a.store.Delete(ctx, key); err != nil {
				a.log.Warn("trash: could not delete package object", "key", key, "error", err)
			}
		}
		_, _ = a.db.ExecContext(ctx, `DELETE FROM download_packages WHERE job_id=?`, job.id)
		_, _ = a.db.ExecContext(ctx, `DELETE FROM download_jobs WHERE id=?`, job.id)
	}
}

func (a *API) listTrash(w http.ResponseWriter, r *http.Request) {
	limit := 60
	args := []any{}
	where := `p.deleted_at IS NOT NULL`
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		parts := strings.SplitN(cursor, "|", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			writeError(w, http.StatusBadRequest, "INVALID_CURSOR", T(r)("invalid_cursor"))
			return
		}
		where += ` AND (p.deleted_at<? OR (p.deleted_at=? AND p.id<?))`
		args = append(args, parts[0], parts[0], parts[1])
	}
	args = append(args, limit+1)
	rows, err := a.db.QueryContext(r.Context(),
		`SELECT p.id,p.album_id,p.name,p.size,p.width,p.height,p.deleted_at,p.deleted_by,p.contributor,p.thumb_key,
		        COALESCE(a.name,''),COALESCE(a.deleted_at,'')
		 FROM photos p LEFT JOIN albums a ON a.id=p.album_id
		 WHERE `+where+` ORDER BY p.deleted_at DESC,p.id DESC LIMIT ?`, args...)
	if err != nil {
		a.internal(w, err)
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0, limit)
	var lastDeleted, lastID string
	for rows.Next() {
		var id, albumID, name, deletedAt, deletedBy, contributor, thumbKey, albumName, albumDeleted string
		var size int64
		var width, height int
		if err := rows.Scan(&id, &albumID, &name, &size, &width, &height, &deletedAt, &deletedBy, &contributor, &thumbKey, &albumName, &albumDeleted); err != nil {
			a.internal(w, err)
			return
		}
		lastDeleted, lastID = deletedAt, id
		if len(items) >= limit {
			continue
		}
		url, _ := a.store.SignRead(r.Context(), thumbKey, "")
		items = append(items, map[string]any{
			"id": id, "album_id": albumID, "album_name": albumName, "album_deleted": albumDeleted != "",
			"name": name, "size": size, "width": width, "height": height,
			"contributor": contributor, "deleted_by": deletedBy, "deleted_at": deletedAt, "thumb_url": url,
		})
	}
	next := ""
	if len(items) == limit {
		next = lastDeleted + "|" + lastID
	}
	var totalBytes int64
	var count int
	_ = a.db.QueryRowContext(r.Context(), `SELECT COUNT(*),COALESCE(SUM(size),0) FROM photos WHERE deleted_at IS NOT NULL`).Scan(&count, &totalBytes)
	var oldest sql.NullString
	_ = a.db.QueryRowContext(r.Context(), `SELECT MIN(deleted_at) FROM photos WHERE deleted_at IS NOT NULL`).Scan(&oldest)
	retention := a.cfg.TrashRetention
	expires := ""
	if retention > 0 && oldest.Valid && oldest.String != "" {
		if deleted, err := time.Parse(time.RFC3339Nano, oldest.String); err == nil {
			expires = deleted.Add(retention).UTC().Format(time.RFC3339)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items, "next_cursor": next, "total_count": count, "total_bytes": totalBytes,
		"retention_days": int(retention.Hours() / 24), "expires_at": expires,
	})
}

func (a *API) restorePhotos(w http.ResponseWriter, r *http.Request) {
	var input struct {
		IDs []string `json:"ids"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if len(input.IDs) == 0 || len(input.IDs) > maxTrashBatch {
		writeError(w, http.StatusBadRequest, "INVALID_SELECTION", T(r)("invalid_selection"))
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.internal(w, err)
		return
	}
	defer tx.Rollback()
	timestamp := now()
	// Restoring a photo whose album was deleted would leave it invisible, so the
	// album comes back with it. Telling an elderly relative to "restore the album
	// first" is not a real option.
	albumRows, err := tx.QueryContext(r.Context(),
		`SELECT DISTINCT album_id FROM photos WHERE id IN (`+placeholders(len(input.IDs))+`) AND deleted_at IS NOT NULL`, toArgs(input.IDs)...)
	if err != nil {
		a.internal(w, err)
		return
	}
	albumIDs := make([]string, 0)
	for albumRows.Next() {
		var albumID string
		if albumRows.Scan(&albumID) == nil {
			albumIDs = append(albumIDs, albumID)
		}
	}
	albumRows.Close()
	albumsRestored := 0
	for _, albumID := range albumIDs {
		result, err := tx.ExecContext(r.Context(), `UPDATE albums SET deleted_at=NULL,updated_at=? WHERE id=? AND deleted_at IS NOT NULL`, timestamp, albumID)
		if err != nil {
			a.internal(w, err)
			return
		}
		if n, _ := result.RowsAffected(); n > 0 {
			albumsRestored++
		}
	}
	args := make([]any, len(input.IDs))
	for i, id := range input.IDs {
		args[i] = id
	}
	result, err := tx.ExecContext(r.Context(),
		`UPDATE photos SET deleted_at=NULL,deleted_by='',trash_batch=''
		 WHERE id IN (`+placeholders(len(input.IDs))+`) AND deleted_at IS NOT NULL`, args...)
	if err != nil {
		a.internal(w, err)
		return
	}
	restored, _ := result.RowsAffected()
	if err := tx.Commit(); err != nil {
		a.internal(w, err)
		return
	}
	// A restored row can now collide with the dedup index if the same bytes were
	// uploaded while it sat in the trash. Clearing dedup_key keeps both photos,
	// which is exactly what "add it anyway" does.
	a.releaseRestoredDedupKeys(r.Context(), input.IDs)
	writeJSON(w, http.StatusOK, map[string]any{"restored": int(restored), "albums_restored": albumsRestored})
}

func (a *API) releaseRestoredDedupKeys(ctx context.Context, ids []string) {
	for _, id := range ids {
		var albumID, hash string
		var dedupKey sql.NullString
		err := a.db.QueryRowContext(ctx, `SELECT album_id,content_hash,dedup_key FROM photos WHERE id=? AND deleted_at IS NULL`, id).
			Scan(&albumID, &hash, &dedupKey)
		if err != nil || !dedupKey.Valid || hash == "" {
			continue
		}
		found, err := findDuplicate(ctx, a.db, albumID, hash)
		if err != nil || found == nil || found.ID == id {
			continue
		}
		_, _ = a.db.ExecContext(ctx, `UPDATE photos SET dedup_key=NULL WHERE id=?`, id)
	}
}

// purgePhotos removes photos permanently: object storage first, then the row.
// Reversing that order would leave objects nobody can ever find again.
func (a *API) purgePhotos(ctx context.Context, ids []string) (int, []string) {
	if len(ids) == 0 {
		return 0, nil
	}
	rows, err := a.db.QueryContext(ctx,
		`SELECT id,original_key,preview_key,thumb_key FROM photos
		 WHERE id IN (`+placeholders(len(ids))+`) AND deleted_at IS NOT NULL`, toArgs(ids)...)
	if err != nil {
		a.log.Warn("purge: could not read photos", "error", err)
		return 0, ids
	}
	type victim struct{ id, original, preview, thumb string }
	victims := make([]victim, 0, len(ids))
	for rows.Next() {
		var item victim
		if rows.Scan(&item.id, &item.original, &item.preview, &item.thumb) == nil {
			victims = append(victims, item)
		}
	}
	rows.Close()
	removed := 0
	failed := make([]string, 0)
	for _, item := range victims {
		// A missing object is fine; any other error means we must keep the row and
		// try again later, because the row is the only pointer to the object.
		ok := true
		for _, key := range []string{item.original, item.preview, item.thumb} {
			if key == "" {
				continue
			}
			if err := a.store.Delete(ctx, key); err != nil && !isNotFound(err) {
				a.log.Warn("purge: could not delete object", "key", key, "error", err)
				ok = false
				break
			}
		}
		if !ok {
			failed = append(failed, item.id)
			continue
		}
		if _, err := a.db.ExecContext(ctx, `DELETE FROM photos WHERE id=?`, item.id); err != nil {
			failed = append(failed, item.id)
			continue
		}
		removed++
	}
	return removed, failed
}

func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "nosuchkey") || strings.Contains(message, "not found") || strings.Contains(message, "statuscode: 404")
}

func (a *API) emptyTrash(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT id FROM photos WHERE deleted_at IS NOT NULL`)
	if err != nil {
		a.internal(w, err)
		return
	}
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	removed, failed := a.purgePhotos(r.Context(), ids)
	writeJSON(w, http.StatusOK, map[string]any{"purged": removed, "failed": len(failed)})
}

// trashAlbum soft-deletes an album together with every photo it holds, in one
// batch so a single restore brings the whole thing back.
func (a *API) trashAlbum(w http.ResponseWriter, r *http.Request) {
	albumID := chi.URLParam(r, "albumID")
	var by string
	if input, err := decodeOptional(r); err == nil {
		by = cleanContributor(input)
	}
	var exists int
	if err := a.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM albums WHERE id=? AND deleted_at IS NULL`, albumID).Scan(&exists); err != nil || exists == 0 {
		writeError(w, http.StatusNotFound, "ALBUM_NOT_FOUND", T(r)("album_not_found"))
		return
	}
	batch := newID()
	timestamp := now()
	photoIDs := make([]string, 0)
	rows, err := a.db.QueryContext(r.Context(), `SELECT id FROM photos WHERE album_id=? AND deleted_at IS NULL`, albumID)
	if err != nil {
		a.internal(w, err)
		return
	}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			photoIDs = append(photoIDs, id)
		}
	}
	rows.Close()
	if _, err := a.db.ExecContext(r.Context(), `UPDATE albums SET deleted_at=?,updated_at=? WHERE id=?`, timestamp, timestamp, albumID); err != nil {
		a.internal(w, err)
		return
	}
	// Shares of a deleted album must stop working immediately.
	_, _ = a.db.ExecContext(r.Context(), `UPDATE shares SET revoked_at=? WHERE album_id=? AND revoked_at IS NULL`, timestamp, albumID)
	_, _ = a.db.ExecContext(r.Context(), `UPDATE collections SET status='ended' WHERE album_id=? AND status='active'`, albumID)
	if len(photoIDs) > 0 {
		if _, err := a.softDeletePhotos(r.Context(), photoIDs, by, batch); err != nil {
			a.internal(w, err)
			return
		}
		a.invalidateDownloadJobs(r.Context(), photoIDs)
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "photos": len(photoIDs), "batch": batch})
}

// purgeTrash removes photos whose retention window has passed.
func (a *API) purgeTrash(ctx context.Context) {
	if a.cfg.TrashRetention <= 0 {
		return
	}
	cutoff := time.Now().Add(-a.cfg.TrashRetention).UTC().Format(time.RFC3339Nano)
	rows, err := a.db.QueryContext(ctx, `SELECT id FROM photos WHERE deleted_at IS NOT NULL AND deleted_at<? LIMIT 200`, cutoff)
	if err != nil {
		a.log.Warn("trash cleanup: query failed", "error", err)
		return
	}
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	if len(ids) == 0 {
		return
	}
	removed, failed := a.purgePhotos(ctx, ids)
	a.log.Info("trash cleanup", "purged", removed, "failed", len(failed))
}

func toArgs(ids []string) []any {
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return args
}

// decodeOptional reads an optional JSON body. DELETE requests often carry none,
// and a missing body must not fail the call.
func decodeOptional(r *http.Request) (string, error) {
	if r.Body == nil {
		return "", nil
	}
	var input struct {
		By string `json:"by"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		return "", err
	}
	return input.By, nil
}
