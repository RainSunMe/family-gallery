package httpapi

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

func (a *API) createCollection(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name         string `json:"name"`
		Description  string `json:"description"`
		AlbumID      string `json:"album_id"`
		ExpiryDays   int    `json:"expiry_days"`
		BatchLimit   int    `json:"batch_limit"`
		AllowMessage bool   `json:"allow_message"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if input.Name == "" || len([]rune(input.Name)) > 40 || input.BatchLimit < 1 || input.BatchLimit > 100 {
		writeError(w, http.StatusBadRequest, "INVALID_COLLECTION", T(r)("invalid_collection"))
		return
	}
	var exists int
	if err := a.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM albums WHERE id=? AND deleted_at IS NULL`, input.AlbumID).Scan(&exists); err != nil || exists == 0 {
		writeError(w, http.StatusNotFound, "ALBUM_NOT_FOUND", T(r)("target_album_missing"))
		return
	}
	id := newID()
	var expiry any
	if input.ExpiryDays > 0 {
		if input.ExpiryDays > 365 {
			writeError(w, http.StatusBadRequest, "INVALID_EXPIRY", T(r)("expiry_too_long"))
			return
		}
		expiry = time.Now().Add(time.Duration(input.ExpiryDays) * 24 * time.Hour).UTC().Format(time.RFC3339)
	}
	allow := 0
	if input.AllowMessage {
		allow = 1
	}
	_, err := a.db.ExecContext(r.Context(), `INSERT INTO collections(id,album_id,name,description,token_hash,expires_at,batch_limit,allow_message,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, input.AlbumID, input.Name, input.Description, id, expiry, input.BatchLimit, allow, principal(r).Hash, now())
	if err != nil {
		a.internal(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "url": a.cfg.PublicURL + "/guest/collect/" + id})
}
func (a *API) listCollections(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT id,name,description,album_id,status,expires_at,batch_limit,allow_message,created_at FROM collections ORDER BY created_at DESC`)
	if err != nil {
		a.internal(w, err)
		return
	}
	defer rows.Close()
	type collectionRow struct {
		id, name, description, albumID, status, created string
		expires                                         sql.NullString
		limit, allow                                    int
	}
	collectionRows := make([]collectionRow, 0)
	for rows.Next() {
		var row collectionRow
		if err := rows.Scan(&row.id, &row.name, &row.description, &row.albumID, &row.status, &row.expires, &row.limit, &row.allow, &row.created); err != nil {
			a.internal(w, err)
			return
		}
		collectionRows = append(collectionRows, row)
	}
	rows.Close()
	items := make([]map[string]any, 0, len(collectionRows))
	for _, row := range collectionRows {
		items = append(items, a.collectionSummary(r, row.id, row.name, row.description, row.albumID, row.status, row.expires, row.limit, row.allow, row.created))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
func (a *API) getCollection(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "collectionID")
	var name, description, albumID, status, created string
	var expires sql.NullString
	var limit, allow int
	if err := a.db.QueryRowContext(r.Context(), `SELECT name,description,album_id,status,expires_at,batch_limit,allow_message,created_at FROM collections WHERE id=?`, id).Scan(&name, &description, &albumID, &status, &expires, &limit, &allow, &created); err != nil {
		writeError(w, http.StatusNotFound, "COLLECTION_NOT_FOUND", T(r)("collection_not_found"))
		return
	}
	writeJSON(w, http.StatusOK, a.collectionSummary(r, id, name, description, albumID, status, expires, limit, allow, created))
}
func (a *API) collectionSummary(r *http.Request, id, name, description, albumID, status string, expires sql.NullString, limit, allow int, created string) map[string]any {
	var total, pending, imported int
	_ = a.db.QueryRowContext(r.Context(), `SELECT COUNT(*),COALESCE(SUM(status='pending'),0),COALESCE(SUM(status='imported'),0) FROM submission_items WHERE collection_id=?`, id).Scan(&total, &pending, &imported)
	rows, _ := a.db.QueryContext(r.Context(), `SELECT contributor,COUNT(*) FROM submission_items WHERE collection_id=? GROUP BY contributor ORDER BY COUNT(*) DESC`, id)
	contributors := make([]map[string]any, 0)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var name string
			var count int
			_ = rows.Scan(&name, &count)
			contributors = append(contributors, map[string]any{"name": name, "count": count})
		}
		rows.Close()
		rows = nil
	}
	photos := make([]map[string]any, 0)
	photoRows, _ := a.db.QueryContext(r.Context(), `SELECT id,name,mime,size,width,height,thumb_key,contributor,status,created_at,message FROM submission_items WHERE collection_id=? ORDER BY created_at DESC`, id)
	if photoRows != nil {
		defer photoRows.Close()
		for photoRows.Next() {
			var itemID, name, mime, thumb, contributor, status, created, message string
			var size int64
			var width, height int
			_ = photoRows.Scan(&itemID, &name, &mime, &size, &width, &height, &thumb, &contributor, &status, &created, &message)
			url, _ := a.store.SignRead(r.Context(), thumb, "")
			photos = append(photos, map[string]any{"id": itemID, "name": name, "mime": mime, "size": size, "width": width, "height": height, "url": url, "contributor": contributor, "status": status, "created_at": created, "message": message})
		}
	}
	return map[string]any{"id": id, "name": name, "description": description, "album_id": albumID, "status": status, "expires_at": expires.String, "batch_limit": limit, "allow_message": allow == 1, "created_at": created, "photo_count": total, "pending_count": pending, "imported_count": imported, "contributors": contributors, "photos": photos, "invite_url": a.cfg.PublicURL + "/guest/collect/" + id}
}
func (a *API) closeCollection(w http.ResponseWriter, r *http.Request) {
	result, err := a.db.ExecContext(r.Context(), `UPDATE collections SET status='ended' WHERE id=?`, chi.URLParam(r, "collectionID"))
	if err != nil {
		a.internal(w, err)
		return
	}
	if n, _ := result.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "COLLECTION_NOT_FOUND", T(r)("collection_not_found"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ended"})
}
func (a *API) guestCollection(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var name, description string
	var expires sql.NullString
	var limit int
	var allow bool
	if err := a.db.QueryRowContext(r.Context(), `SELECT name,description,expires_at,batch_limit,allow_message FROM collections WHERE id=?`, p.ScopeID).Scan(&name, &description, &expires, &limit, &allow); err != nil {
		writeError(w, http.StatusNotFound, "COLLECTION_NOT_FOUND", T(r)("collection_not_found"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": p.ScopeID, "name": name, "description": description, "expires_at": expires.String, "batch_limit": limit, "allow_message": allow, "display_name": p.Name})
}
func (a *API) signCollectionRead(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ItemID  string `json:"item_id"`
		Variant string `json:"variant"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	column := "original_key"
	if input.Variant == "thumb" {
		column = "thumb_key"
	} else if input.Variant == "preview" {
		column = "preview_key"
	}
	var key string
	if err := a.db.QueryRowContext(r.Context(), `SELECT `+column+` FROM submission_items WHERE id=? AND collection_id=?`, input.ItemID, chi.URLParam(r, "collectionID")).Scan(&key); err != nil {
		writeError(w, http.StatusNotFound, "PHOTO_NOT_FOUND", T(r)("photo_not_found"))
		return
	}
	url, err := a.store.SignRead(r.Context(), key, "")
	if err != nil {
		a.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}
func (a *API) importCollection(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ItemIDs []string `json:"item_ids"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	collectionID := chi.URLParam(r, "collectionID")
	var albumID string
	if err := a.db.QueryRowContext(r.Context(), `SELECT album_id FROM collections WHERE id=?`, collectionID).Scan(&albumID); err != nil {
		writeError(w, http.StatusNotFound, "COLLECTION_NOT_FOUND", T(r)("collection_not_found"))
		return
	}
	rows, err := a.db.QueryContext(r.Context(), `SELECT id,name,original_key,preview_key,thumb_key,mime,size,width,height,contributor FROM submission_items WHERE collection_id=? AND status='pending'`, collectionID)
	if err != nil {
		a.internal(w, err)
		return
	}
	defer rows.Close()
	type importItem struct {
		id, name, key, preview, thumb, mime, contributor string
		size                                              int64
		width, height                                     int
	}
	pendingItems := make([]importItem, 0)
	for rows.Next() {
		var item importItem
		if err := rows.Scan(&item.id, &item.name, &item.key, &item.preview, &item.thumb, &item.mime, &item.size, &item.width, &item.height, &item.contributor); err != nil {
			a.internal(w, err)
			return
		}
		pendingItems = append(pendingItems, item)
	}
	rows.Close()
	wanted := make(map[string]bool)
	for _, id := range input.ItemIDs {
		wanted[id] = true
	}
	imported, failed := 0, 0
	for _, item := range pendingItems {
		id, name, key, preview, thumb, mime := item.id, item.name, item.key, item.preview, item.thumb, item.mime
		size, width, height := item.size, item.width, item.height
		if len(wanted) > 0 && !wanted[id] {
			continue
		}
		photoID := newID()
		dest := "photos/originals/" + photoID + "/original"
		destPreview := "photos/previews/" + photoID + ".webp"
		destThumb := "photos/thumbs/" + photoID + ".webp"
		if err := a.store.Copy(r.Context(), key, dest); err != nil {
			failed++
			continue
		}
		if err := a.store.Copy(r.Context(), preview, destPreview); err != nil {
			failed++
			continue
		}
		if err := a.store.Copy(r.Context(), thumb, destThumb); err != nil {
			failed++
			continue
		}
		timestamp := now()
		tx, err := a.db.BeginTx(r.Context(), nil)
		if err != nil {
			a.internal(w, err)
			return
		}
		_, err = tx.ExecContext(r.Context(), `INSERT INTO photos(id,album_id,name,original_key,preview_key,thumb_key,mime,size,width,height,contributor,taken_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, photoID, albumID, name, dest, destPreview, destThumb, mime, size, width, height, item.contributor, timestamp, timestamp)
		if err == nil {
			_, err = tx.ExecContext(r.Context(), `UPDATE submission_items SET status='imported',photo_id=?,imported_at=? WHERE id=? AND status='pending'`, photoID, timestamp, id)
		}
		if err == nil {
			_, err = tx.ExecContext(r.Context(), `UPDATE albums SET updated_at=? WHERE id=?`, timestamp, albumID)
		}
		if err != nil {
			tx.Rollback()
			failed++
			continue
		}
		if err := tx.Commit(); err != nil {
			failed++
			continue
		}
		imported++
	}
	writeJSON(w, http.StatusOK, map[string]int{"imported": imported, "failed": failed})
}

func (a *API) createShare(w http.ResponseWriter, r *http.Request) {
	var input struct {
		AlbumID    string `json:"album_id"`
		ExpiryDays int    `json:"expiry_days"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	var exists int
	if err := a.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM albums WHERE id=? AND deleted_at IS NULL`, input.AlbumID).Scan(&exists); err != nil || exists == 0 {
		writeError(w, http.StatusNotFound, "ALBUM_NOT_FOUND", T(r)("album_not_found"))
		return
	}
	if input.ExpiryDays < 0 || input.ExpiryDays > 365 {
		writeError(w, http.StatusBadRequest, "INVALID_EXPIRY", T(r)("invalid_expiry"))
		return
	}
	id := randomToken()
	var expiry any
	if input.ExpiryDays > 0 {
		expiry = time.Now().Add(time.Duration(input.ExpiryDays) * 24 * time.Hour).UTC().Format(time.RFC3339)
	}
	_, err := a.db.ExecContext(r.Context(), `INSERT INTO shares(id,album_id,token_hash,created_by,expires_at,created_at) VALUES(?,?,?,?,?,?)`, id, input.AlbumID, id, principal(r).Hash, expiry, now())
	if err != nil {
		a.internal(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "url": a.cfg.PublicURL + "/guest/share/" + id})
}
func (a *API) listShares(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT s.id,s.album_id,a.name,
	 COALESCE(NULLIF(a.cover_key,''),(SELECT p.thumb_key FROM photos p WHERE p.album_id=a.id AND p.deleted_at IS NULL ORDER BY p.taken_at DESC,p.id DESC LIMIT 1)),
	 (SELECT COUNT(*) FROM photos p WHERE p.album_id=a.id AND p.deleted_at IS NULL),s.expires_at,s.created_at,s.view_count
	 FROM shares s JOIN albums a ON a.id=s.album_id WHERE s.revoked_at IS NULL ORDER BY s.created_at DESC`)
	if err != nil {
		a.internal(w, err)
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var id, albumID, name, created string
		var cover, expires sql.NullString
		var views, photoCount int
		if err := rows.Scan(&id, &albumID, &name, &cover, &photoCount, &expires, &created, &views); err != nil {
			a.internal(w, err)
			return
		}
		coverURL := ""
		if cover.Valid && cover.String != "" {
			coverURL, _ = a.store.SignRead(r.Context(), cover.String, "")
		}
		items = append(items, map[string]any{"id": id, "album_id": albumID, "album_name": name, "album_cover_url": coverURL, "photo_count": photoCount, "expires_at": expires.String, "created_at": created, "view_count": views, "url": a.cfg.PublicURL + "/guest/share/" + id})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
func (a *API) revokeShare(w http.ResponseWriter, r *http.Request) {
	var createdBy string
	err := a.db.QueryRowContext(r.Context(), `SELECT created_by FROM shares WHERE id=?`, chi.URLParam(r, "shareID")).Scan(&createdBy)
	if err != nil {
		writeError(w, http.StatusNotFound, "SHARE_NOT_FOUND", T(r)("share_not_found"))
		return
	}
	if principal(r).Role != "admin" && createdBy != principal(r).Hash {
		writeError(w, http.StatusForbidden, "FORBIDDEN", T(r)("revoke_own_share"))
		return
	}
	_, err = a.db.ExecContext(r.Context(), `UPDATE shares SET revoked_at=? WHERE id=?`, now(), chi.URLParam(r, "shareID"))
	if err != nil {
		a.internal(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (a *API) guestAlbum(w http.ResponseWriter, r *http.Request) {
	var albumID string
	if err := a.db.QueryRowContext(r.Context(), `SELECT album_id FROM shares WHERE id=?`, principal(r).ScopeID).Scan(&albumID); err != nil {
		writeError(w, http.StatusNotFound, "LINK_UNAVAILABLE", T(r)("link_unavailable"))
		return
	}
	_, _ = a.db.ExecContext(r.Context(), `UPDATE shares SET view_count=view_count+1 WHERE id=?`, principal(r).ScopeID)
	album, ok := a.albumByID(r, albumID, true)
	if !ok {
		writeError(w, http.StatusNotFound, "ALBUM_NOT_FOUND", T(r)("album_not_found"))
		return
	}
	writeJSON(w, http.StatusOK, album)
}
