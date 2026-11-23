package httpapi

import (
	"archive/zip"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/RainSunMe/family-gallery/internal/i18n"
)

func (a *API) createDownload(w http.ResponseWriter, r *http.Request) {
	var input struct {
		AlbumID  string   `json:"album_id"`
		PhotoIDs []string `json:"photo_ids"`
		Mode     string   `json:"mode"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	p := principal(r)
	scopeID := input.AlbumID
	if p.Role == "share" {
		var albumID string
		if err := a.db.QueryRowContext(r.Context(), `SELECT album_id FROM shares WHERE id=?`, p.ScopeID).Scan(&albumID); err != nil {
			writeError(w, http.StatusNotFound, "LINK_UNAVAILABLE", T(r)("link_unavailable"))
			return
		}
		if input.AlbumID != "" && input.AlbumID != albumID {
			writeError(w, http.StatusForbidden, "FORBIDDEN", T(r)("download_forbidden"))
			return
		}
		scopeID = albumID
	}
	if scopeID == "" {
		writeError(w, http.StatusBadRequest, "ALBUM_REQUIRED", T(r)("album_required"))
		return
	}
	if input.Mode != "batch" {
		input.Mode = "single"
	}
	ids := make([]string, 0)
	args := []any{scopeID}
	where := `album_id=? AND deleted_at IS NULL`
	if len(input.PhotoIDs) > 0 {
		where += ` AND id IN (` + placeholders(len(input.PhotoIDs)) + `)`
		for _, id := range input.PhotoIDs {
			args = append(args, id)
		}
	}
	rows, err := a.db.QueryContext(r.Context(), `SELECT id FROM photos WHERE `+where, args...)
	if err != nil {
		a.internal(w, err)
		return
	}
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	if len(ids) == 0 {
		writeError(w, http.StatusBadRequest, "NO_FILES", T(r)("no_downloadable"))
		return
	}
	encoded, _ := json.Marshal(ids)
	id := newID()
	_, err = a.db.ExecContext(r.Context(), `INSERT INTO download_jobs(id,scope_type,scope_id,owner_hash,mode,photo_ids,created_at) VALUES(?,?,?,?,?,?,?)`, id, "album", scopeID, p.Hash, input.Mode, string(encoded), now())
	if err != nil {
		a.internal(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": id, "status": "queued"})
}
func (a *API) getDownload(w http.ResponseWriter, r *http.Request) {
	job, ok := a.downloadJob(r, chi.URLParam(r, "jobID"))
	if !ok {
		writeError(w, http.StatusNotFound, "DOWNLOAD_NOT_FOUND", T(r)("download_not_found"))
		return
	}
	writeJSON(w, http.StatusOK, job)
}
func (a *API) downloadJob(r *http.Request, id string) (map[string]any, bool) {
	var status, mode, scope, owner, created, errorMessage string
	var progress int
	var expires sql.NullString
	err := a.db.QueryRowContext(r.Context(), `SELECT status,mode,scope_id,owner_hash,progress,error,created_at,expires_at FROM download_jobs WHERE id=?`, id).Scan(&status, &mode, &scope, &owner, &progress, &errorMessage, &created, &expires)
	if err != nil {
		return nil, false
	}
	p := principal(r)
	if owner != p.Hash && p.Role != "admin" {
		if p.Role != "share" {
			return nil, false
		}
		var shareAlbum string
		_ = a.db.QueryRowContext(r.Context(), `SELECT album_id FROM shares WHERE id=?`, p.ScopeID).Scan(&shareAlbum)
		if shareAlbum != scope {
			return nil, false
		}
	}
	packages := make([]map[string]any, 0)
	rows, _ := a.db.QueryContext(r.Context(), `SELECT id,part_no,size,file_count FROM download_packages WHERE job_id=? ORDER BY part_no`, id)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var packageID string
			var size int64
			var part, count int
			_ = rows.Scan(&packageID, &part, &size, &count)
			packages = append(packages, map[string]any{"id": packageID, "part": part, "size": size, "file_count": count})
		}
	}
	return map[string]any{"id": id, "status": status, "mode": mode, "progress": progress, "error": errorMessage, "created_at": created, "expires_at": expires.String, "packages": packages}, true
}
func (a *API) cancelDownload(w http.ResponseWriter, r *http.Request) {
	_, err := a.db.ExecContext(r.Context(), `UPDATE download_jobs SET status='cancelled' WHERE id=? AND owner_hash=? AND status IN ('queued','running')`, chi.URLParam(r, "jobID"), principal(r).Hash)
	if err != nil {
		a.internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (a *API) signDownload(w http.ResponseWriter, r *http.Request) {
	jobID := chi.URLParam(r, "jobID")
	job, ok := a.downloadJob(r, jobID)
	if !ok || job["status"] != "succeeded" {
		writeError(w, http.StatusNotFound, "DOWNLOAD_NOT_READY", T(r)("download_not_ready"))
		return
	}
	var input struct {
		PackageID string `json:"package_id"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	var key string
	if err := a.db.QueryRowContext(r.Context(), `SELECT object_key FROM download_packages WHERE id=? AND job_id=?`, input.PackageID, jobID).Scan(&key); err != nil {
		writeError(w, http.StatusNotFound, "PACKAGE_NOT_FOUND", T(r)("package_not_found"))
		return
	}
	url, err := a.store.SignRead(r.Context(), key, "gallery.zip")
	if err != nil {
		a.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

func (a *API) RunWorker(ctx context.Context) {
	// Backfill runs once at startup and is opt-in: it reads every original back
	// out of the bucket, so it must never surprise an operator.
	if a.cfg.DedupBackfill {
		go a.backfillHashes(ctx)
	}
	ticker := time.NewTicker(a.cfg.WorkerInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for {
				jobID, err := a.claimJob(ctx)
				if err != nil {
					break
				}
				a.processDownload(ctx, jobID)
			}
			a.cleanupJobs(ctx)
			a.purgeTrash(ctx)
		}
	}
}
func (a *API) claimJob(ctx context.Context) (string, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var id string
	err = tx.QueryRowContext(ctx, `SELECT id FROM download_jobs WHERE status='queued' ORDER BY created_at LIMIT 1`).Scan(&id)
	if err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE download_jobs SET status='running',progress=0 WHERE id=? AND status='queued'`, id); err != nil {
		return "", err
	}
	return id, tx.Commit()
}

type downloadFile struct {
	id, name, key string
	size          int64
}

func (a *API) processDownload(ctx context.Context, jobID string) {
	var raw, mode string
	_ = a.db.QueryRowContext(ctx, `SELECT photo_ids,mode FROM download_jobs WHERE id=?`, jobID).Scan(&raw, &mode)
	var ids []string
	_ = json.Unmarshal([]byte(raw), &ids)
	files := make([]downloadFile, 0, len(ids))
	for _, id := range ids {
		var item downloadFile
		err := a.db.QueryRowContext(ctx, `SELECT id,name,original_key,size FROM photos WHERE id=? AND deleted_at IS NULL`, id).Scan(&item.id, &item.name, &item.key, &item.size)
		if err == nil {
			files = append(files, item)
		}
	}
	if len(files) == 0 {
		a.finishJobError(ctx, jobID, i18n.T(i18n.EN, "no_downloadable"))
		return
	}
	part := 1
	index := 0
	total := len(files)
	for index < len(files) {
		if a.jobCancelled(ctx, jobID) {
			return
		}
		key := fmt.Sprintf("exports/%s/part-%03d.zip", jobID, part)
		temporary, err := os.CreateTemp("", "gallery-export-*.zip")
		if err != nil {
			a.finishJobError(ctx, jobID, "failed to create temporary download file")
			return
		}
		archive := zip.NewWriter(temporary)
		var currentSize int64
		count := 0
		used := make(map[string]int)
		var writeErr error
		for index < len(files) {
			file := files[index]
			if mode == "batch" && count > 0 && currentSize+file.size > a.cfg.DownloadPartSize {
				break
			}
			if a.jobCancelled(ctx, jobID) {
				_ = archive.Close()
				_ = temporary.Close()
				_ = os.Remove(temporary.Name())
				return
			}
			body, err := a.store.Get(ctx, file.key)
			if err != nil {
				writeErr = err
				break
			}
			entry, err := archive.CreateHeader(&zip.FileHeader{Name: uniqueName(file.name, used), Method: zip.Store, Modified: time.Now()})
			if err == nil {
				_, err = io.Copy(entry, body)
			}
			closeErr := body.Close()
			if err == nil {
				err = closeErr
			}
			if err != nil {
				writeErr = err
				break
			}
			currentSize += file.size
			count++
			index++
			_, _ = a.db.ExecContext(ctx, `UPDATE download_jobs SET progress=? WHERE id=?`, index*90/total, jobID)
		}
		if closeErr := archive.Close(); writeErr == nil {
			writeErr = closeErr
		}
		if writeErr == nil {
			_, writeErr = temporary.Seek(0, io.SeekStart)
		}
		packageSize, statErr := temporary.Stat()
		if statErr != nil {
			writeErr = statErr
		} else if writeErr == nil {
			writeErr = a.store.Put(ctx, key, temporary, packageSize.Size())
		}
		_ = temporary.Close()
		_ = os.Remove(temporary.Name())
		if writeErr != nil {
			a.finishJobError(ctx, jobID, "failed to build the download archive")
			return
		}
		if _, err = a.db.ExecContext(ctx, `INSERT INTO download_packages(id,job_id,part_no,object_key,size,file_count,created_at) VALUES(?,?,?,?,?,?,?)`, newID(), jobID, part, key, packageSize.Size(), count, now()); err != nil {
			a.finishJobError(ctx, jobID, "failed to persist the download job")
			return
		}
		part++
	}
	expires := time.Now().Add(a.cfg.DownloadRetention).UTC().Format(time.RFC3339)
	_, _ = a.db.ExecContext(ctx, `UPDATE download_jobs SET status='succeeded',progress=100,expires_at=? WHERE id=?`, expires, jobID)
}
func (a *API) jobCancelled(ctx context.Context, id string) bool {
	var status string
	_ = a.db.QueryRowContext(ctx, `SELECT status FROM download_jobs WHERE id=?`, id).Scan(&status)
	return status == "cancelled" || ctx.Err() != nil
}
func (a *API) finishJobError(ctx context.Context, id, message string) {
	_, _ = a.db.ExecContext(ctx, `UPDATE download_jobs SET status='failed',error=? WHERE id=?`, message, id)
}
func (a *API) cleanupJobs(ctx context.Context) {
	rows, err := a.db.QueryContext(ctx, `SELECT object_key FROM download_packages WHERE job_id IN (SELECT id FROM download_jobs WHERE expires_at IS NOT NULL AND expires_at<?)`, now())
	if err != nil {
		return
	}
	keys := make([]string, 0)
	for rows.Next() {
		var key string
		_ = rows.Scan(&key)
		keys = append(keys, key)
	}
	rows.Close()
	for _, key := range keys {
		_ = a.store.Delete(ctx, key)
	}
	_, _ = a.db.ExecContext(ctx, `DELETE FROM download_packages WHERE job_id IN (SELECT id FROM download_jobs WHERE expires_at IS NOT NULL AND expires_at<?)`, now())
	_, _ = a.db.ExecContext(ctx, `DELETE FROM download_jobs WHERE expires_at IS NOT NULL AND expires_at<?`, now())
}
func placeholders(count int) string { return strings.TrimSuffix(strings.Repeat("?,", count), ",") }
func uniqueName(name string, used map[string]int) string {
	used[name]++
	if used[name] == 1 {
		return name
	}
	return fmt.Sprintf("%s (%d)%s", strings.TrimSuffix(name, extension(name)), used[name], extension(name))
}
func extension(name string) string {
	index := strings.LastIndex(name, ".")
	if index < 0 {
		return ""
	}
	return name[index:]
}
