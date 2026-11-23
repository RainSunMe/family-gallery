package httpapi

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/go-chi/chi/v5"
)

type uploadRequest struct {
	AlbumID     string `json:"album_id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	Mime        string `json:"mime"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	Message     string `json:"message"`
	Contributor string `json:"contributor"`
	// ContentHash is the SHA-256 of the original bytes, computed in the browser.
	// Empty means "skip the duplicate check", which keeps older clients working.
	ContentHash string `json:"content_hash"`
	// AllowDuplicate lets the user add a photo the album already contains.
	AllowDuplicate bool `json:"allow_duplicate"`
	// TakenAt is the EXIF capture time as an RFC3339 UTC string, read from the
	// file in the browser. Empty means the file had none and the upload time is
	// used instead.
	TakenAt string `json:"taken_at"`
}

// cleanTakenAt validates a client-supplied capture time. It must be RFC3339 and
// plausible: a timestamp far in the future would sort above every other photo,
// and one before photography existed is certainly wrong. An unusable value is
// dropped rather than rejected, because the file itself is still fine.
func cleanTakenAt(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return ""
	}
	now := time.Now().UTC()
	if parsed.Before(time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)) || parsed.After(now.Add(24*time.Hour)) {
		return ""
	}
	return parsed.UTC().Format(time.RFC3339Nano)
}

// cleanContributor trims and caps the client-supplied uploader name. The name is
// only a label shown in the UI, never an authenticating identity.
func cleanContributor(value string) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > 100 {
		runes = runes[:100]
	}
	return string(runes)
}

func validateUpload(input uploadRequest, maxSize int64) (string, bool) {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len([]rune(input.Name)) > 180 || input.Size <= 0 || input.Size > maxSize || input.Width < 0 || input.Height < 0 {
		return "", false
	}
	mime := strings.ToLower(input.Mime)
	allowed := map[string]bool{"image/jpeg": true, "image/png": true, "image/webp": true, "image/gif": true, "image/heic": true, "image/heif": true, "video/mp4": true}
	if !allowed[mime] {
		return "", false
	}
	return mime, true
}
func (a *API) createUpload(w http.ResponseWriter, r *http.Request) {
	var input uploadRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	mime, ok := validateUpload(input, a.cfg.MaxUploadSize)
	if !ok {
		writeError(w, http.StatusBadRequest, "INVALID_FILE", T(r)("invalid_file"))
		return
	}
	hash, ok := validateContentHash(input.ContentHash)
	if !ok {
		writeError(w, http.StatusBadRequest, "INVALID_HASH", T(r)("invalid_hash"))
		return
	}
	var exists int
	if err := a.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM albums WHERE id=? AND deleted_at IS NULL`, input.AlbumID).Scan(&exists); err != nil || exists == 0 {
		writeError(w, http.StatusNotFound, "ALBUM_NOT_FOUND", T(r)("target_album_missing"))
		return
	}
	// Catch duplicates before any bytes move: the browser has already hashed
	// the file, so rejecting here costs nothing.
	if a.cfg.DedupEnabled && hash != "" && !input.AllowDuplicate {
		found, err := findDuplicate(r.Context(), a.db, input.AlbumID, hash)
		if err != nil {
			a.internal(w, err)
			return
		}
		if found != nil {
			a.duplicateResponse(w, r, found)
			return
		}
	}
	id := newID()
	key := "photos/originals/" + id + "/original"
	p := principal(r)
	allow := 0
	if input.AllowDuplicate {
		allow = 1
	}
	_, err := a.db.ExecContext(r.Context(), `INSERT INTO upload_sessions(id,scope_type,scope_id,actor_hash,original_key,name,size,mime,width,height,contributor,content_hash,allow_duplicate,taken_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, "album", input.AlbumID, p.Hash, key, input.Name, input.Size, mime, input.Width, input.Height, cleanContributor(input.Contributor), hash, allow, cleanTakenAt(input.TakenAt), now())
	if err != nil {
		a.internal(w, err)
		return
	}
	a.respondUpload(w, r, id, key, mime, input.Size)
}
func (a *API) respondUpload(w http.ResponseWriter, r *http.Request, id, key, mime string, size int64) {
	url, err := a.store.SignUpload(r.Context(), key, mime)
	if err != nil {
		a.internal(w, err)
		return
	}
	thumbURL, _ := a.store.SignUpload(r.Context(), strings.Replace(key, "/originals/", "/thumbs/", 1)+".webp", "image/webp")
	previewURL, _ := a.store.SignUpload(r.Context(), strings.Replace(key, "/originals/", "/previews/", 1)+".webp", "image/webp")
	uploadID := ""
	if size > a.cfg.MultipartPartSize {
		uploadID, err = a.store.StartMultipart(r.Context(), key, mime)
		if err != nil {
			a.internal(w, err)
			return
		}
		_, _ = a.db.ExecContext(r.Context(), `UPDATE upload_sessions SET cos_upload_id=? WHERE id=?`, uploadID, id)
		url = ""
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "key": key, "url": url, "thumb_url": thumbURL, "preview_url": previewURL, "multipart_upload_id": uploadID, "part_size": a.cfg.MultipartPartSize})
}
func (a *API) uploadForActor(r *http.Request, id string) (string, string, string, string, string, int64, error) {
	var scope, scopeID, key, uploadID, mime string
	var size int64
	err := a.db.QueryRowContext(r.Context(), `SELECT scope_type,scope_id,original_key,cos_upload_id,mime,size FROM upload_sessions WHERE id=? AND actor_hash=? AND status='pending'`, id, principal(r).Hash).Scan(&scope, &scopeID, &key, &uploadID, &mime, &size)
	return scope, scopeID, key, uploadID, mime, size, err
}
func (a *API) signUploadPart(w http.ResponseWriter, r *http.Request) {
	a.signPart(w, r, chi.URLParam(r, "uploadID"))
}
func (a *API) signGuestPart(w http.ResponseWriter, r *http.Request) {
	a.signPart(w, r, chi.URLParam(r, "uploadID"))
}
func (a *API) signPart(w http.ResponseWriter, r *http.Request, id string) {
	_, _, key, uploadID, _, _, err := a.uploadForActor(r, id)
	if err != nil || uploadID == "" {
		writeError(w, http.StatusNotFound, "UPLOAD_NOT_FOUND", T(r)("upload_not_found"))
		return
	}
	var input struct {
		PartNumber int32 `json:"part_number"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.PartNumber < 1 || input.PartNumber > 10000 {
		writeError(w, http.StatusBadRequest, "INVALID_PART", T(r)("invalid_part"))
		return
	}
	url, err := a.store.SignPart(r.Context(), key, uploadID, input.PartNumber)
	if err != nil {
		a.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}
func (a *API) completeUpload(w http.ResponseWriter, r *http.Request) {
	a.completeFamilyUpload(w, r, chi.URLParam(r, "uploadID"))
}
func (a *API) completeFamilyUpload(w http.ResponseWriter, r *http.Request, id string) {
	_, albumID, key, uploadID, _, size, err := a.uploadForActor(r, id)
	if err != nil {
		writeError(w, http.StatusConflict, "UPLOAD_NOT_FOUND", T(r)("upload_finished"))
		return
	}
	if !a.finishMultipart(w, r, key, uploadID) {
		return
	}
	if err := a.store.Head(r.Context(), key, size); err != nil {
		writeError(w, http.StatusBadRequest, "OBJECT_NOT_READY", T(r)("object_not_ready"))
		return
	}
	var input uploadRequest
	var allowDuplicate int
	if err := a.db.QueryRowContext(r.Context(), `SELECT name,mime,width,height,contributor,content_hash,allow_duplicate,taken_at FROM upload_sessions WHERE id=?`, id).Scan(&input.Name, &input.Mime, &input.Width, &input.Height, &input.Contributor, &input.ContentHash, &allowDuplicate, &input.TakenAt); err != nil {
		a.internal(w, err)
		return
	}
	thumbKey := strings.Replace(key, "/originals/", "/thumbs/", 1) + ".webp"
	previewKey := strings.Replace(key, "/originals/", "/previews/", 1) + ".webp"
	for _, derivedKey := range []string{thumbKey, previewKey} {
		if err := a.store.Head(r.Context(), derivedKey, -1); err != nil {
			writeError(w, http.StatusBadRequest, "DERIVATIVE_NOT_READY", T(r)("derivative_not_ready"))
			return
		}
	}
	photoID := newID()
	timestamp := now()
	// Sort by when the photo was taken, falling back to when it arrived.
	takenAt := input.TakenAt
	if takenAt == "" {
		takenAt = timestamp
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.internal(w, err)
		return
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(r.Context(), `INSERT INTO photos(id,album_id,name,original_key,preview_key,thumb_key,mime,size,width,height,contributor,content_hash,dedup_key,taken_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, photoID, albumID, input.Name, key, previewKey, thumbKey, input.Mime, size, input.Width, input.Height, input.Contributor, input.ContentHash, dedupKeyFor(input.ContentHash, allowDuplicate == 1), takenAt, timestamp)
	if err != nil {
		// A concurrent upload of the same bytes won the race between the
		// pre-check and this insert. Report it as the same duplicate error so
		// the client offers "add anyway" instead of a generic failure.
		if isUniqueViolation(err) {
			tx.Rollback()
			_, _ = a.db.ExecContext(r.Context(), `UPDATE upload_sessions SET status='aborted' WHERE id=?`, id)
			if found, findErr := findDuplicate(r.Context(), a.db, albumID, input.ContentHash); findErr == nil && found != nil {
				a.duplicateResponse(w, r, found)
				return
			}
			writeError(w, http.StatusConflict, "DUPLICATE_PHOTO", T(r)("duplicate_photo"))
			return
		}
		a.internal(w, err)
		return
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE albums SET cover_key=CASE WHEN cover_key='' THEN ? ELSE cover_key END,updated_at=? WHERE id=?`, thumbKey, timestamp, albumID); err != nil {
		a.internal(w, err)
		return
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE upload_sessions SET status='completed' WHERE id=? AND status='pending'`, id); err != nil {
		a.internal(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		a.internal(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": photoID, "status": "ready"})
}
func (a *API) finishMultipart(w http.ResponseWriter, r *http.Request, key, uploadID string) bool {
	if uploadID == "" {
		return true
	}
	var input struct {
		Parts []types.CompletedPart `json:"parts"`
	}
	if !decodeJSON(w, r, &input) {
		return false
	}
	if len(input.Parts) == 0 {
		writeError(w, http.StatusBadRequest, "PARTS_REQUIRED", T(r)("parts_required"))
		return false
	}
	if err := a.store.CompleteMultipart(r.Context(), key, uploadID, input.Parts); err != nil {
		a.log.Warn("complete multipart failed", "error", err)
		writeError(w, http.StatusBadRequest, "MULTIPART_INCOMPLETE", T(r)("multipart_incomplete"))
		return false
	}
	return true
}
func (a *API) abortUpload(w http.ResponseWriter, r *http.Request) {
	_, _, key, uploadID, _, _, err := a.uploadForActor(r, chi.URLParam(r, "uploadID"))
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if uploadID != "" {
		_ = a.store.AbortMultipart(r.Context(), key, uploadID)
	}
	_, _ = a.db.ExecContext(r.Context(), `UPDATE upload_sessions SET status='aborted' WHERE id=?`, chi.URLParam(r, "uploadID"))
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) guestCollectionSession(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	var input struct {
		DisplayName string `json:"display_name"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if input.DisplayName == "" || len([]rune(input.DisplayName)) > 24 {
		writeError(w, http.StatusBadRequest, "INVALID_NAME", T(r)("invalid_name"))
		return
	}
	var collectionID string
	var expires sql.NullString
	var status string
	err := a.db.QueryRowContext(r.Context(), `SELECT id,status,expires_at FROM collections WHERE id=?`, token).Scan(&collectionID, &status, &expires)
	if err != nil || status != "active" || expired(expires) {
		writeError(w, http.StatusNotFound, "COLLECTION_UNAVAILABLE", T(r)("collection_unavailable"))
		return
	}
	session := randomToken()
	expiry := time.Now().Add(a.cfg.CollectionLinkTTL)
	if expires.Valid {
		if t, _ := time.Parse(time.RFC3339, expires.String); t.Before(expiry) {
			expiry = t
		}
	}
	_, err = a.db.ExecContext(r.Context(), `INSERT INTO collection_sessions(token_hash,collection_id,display_name,expires_at,created_at) VALUES(?,?,?,?,?)`, tokenHash(session), collectionID, input.DisplayName, expiry.UTC().Format(time.RFC3339), now())
	if err != nil {
		a.internal(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "cg_collect", Value: session, Path: "/api/v1/guest/collections", HttpOnly: true, Secure: a.cfg.Production, SameSite: http.SameSiteLaxMode, MaxAge: int(a.cfg.CollectionLinkTTL.Seconds())})
	writeJSON(w, http.StatusOK, map[string]string{"display_name": input.DisplayName, "collection_id": collectionID})
}
func (a *API) createGuestUpload(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var status string
	var expires sql.NullString
	var limit int
	if err := a.db.QueryRowContext(r.Context(), `SELECT status,expires_at,batch_limit FROM collections WHERE id=?`, p.ScopeID).Scan(&status, &expires, &limit); err != nil || status != "active" || expired(expires) {
		writeError(w, http.StatusForbidden, "COLLECTION_CLOSED", T(r)("collection_closed"))
		return
	}
	var input uploadRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	mime, ok := validateUpload(input, a.cfg.MaxUploadSize)
	if !ok {
		writeError(w, http.StatusBadRequest, "INVALID_FILE", T(r)("invalid_file_limit"))
		return
	}
	// Guests cannot see the family library, so blocking on a duplicate here
	// would only confuse them. The hash is recorded and the check happens when
	// the organizer imports the submission.
	hash, ok := validateContentHash(input.ContentHash)
	if !ok {
		writeError(w, http.StatusBadRequest, "INVALID_HASH", T(r)("invalid_hash"))
		return
	}
	var pending int
	_ = a.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM upload_sessions WHERE actor_hash=? AND status='pending'`, p.Hash).Scan(&pending)
	if pending >= limit {
		writeError(w, http.StatusTooManyRequests, "BATCH_LIMIT", T(r)("batch_limit"))
		return
	}
	id := newID()
	key := "collections/" + p.ScopeID + "/originals/" + id + "/original"
	_, err := a.db.ExecContext(r.Context(), `INSERT INTO upload_sessions(id,scope_type,scope_id,actor_hash,original_key,name,size,mime,width,height,message,content_hash,taken_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, "collection", p.ScopeID, p.Hash, key, input.Name, input.Size, mime, input.Width, input.Height, strings.TrimSpace(input.Message), hash, cleanTakenAt(input.TakenAt), now())
	if err != nil {
		a.internal(w, err)
		return
	}
	a.respondUpload(w, r, id, key, mime, input.Size)
}
func (a *API) completeGuestUpload(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	id := chi.URLParam(r, "uploadID")
	_, collectionID, key, uploadID, _, size, err := a.uploadForActor(r, id)
	if err != nil {
		writeError(w, http.StatusConflict, "UPLOAD_NOT_FOUND", T(r)("upload_finished"))
		return
	}
	var status string
	var expires sql.NullString
	_ = a.db.QueryRowContext(r.Context(), `SELECT status,expires_at FROM collections WHERE id=?`, collectionID).Scan(&status, &expires)
	if status != "active" || expired(expires) {
		writeError(w, http.StatusForbidden, "COLLECTION_CLOSED", T(r)("collection_closed"))
		return
	}
	if !a.finishMultipart(w, r, key, uploadID) {
		return
	}
	if err := a.store.Head(r.Context(), key, size); err != nil {
		writeError(w, http.StatusBadRequest, "OBJECT_NOT_READY", T(r)("object_not_ready"))
		return
	}
	var input uploadRequest
	if err := a.db.QueryRowContext(r.Context(), `SELECT name,mime,width,height,message,content_hash,taken_at FROM upload_sessions WHERE id=?`, id).Scan(&input.Name, &input.Mime, &input.Width, &input.Height, &input.Message, &input.ContentHash, &input.TakenAt); err != nil {
		a.internal(w, err)
		return
	}
	thumbKey := strings.Replace(key, "/originals/", "/thumbs/", 1) + ".webp"
	previewKey := strings.Replace(key, "/originals/", "/previews/", 1) + ".webp"
	for _, derivedKey := range []string{thumbKey, previewKey} {
		if err := a.store.Head(r.Context(), derivedKey, -1); err != nil {
			writeError(w, http.StatusBadRequest, "DERIVATIVE_NOT_READY", T(r)("derivative_not_ready"))
			return
		}
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.internal(w, err)
		return
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO submission_items(id,collection_id,session_hash,contributor,message,name,original_key,preview_key,thumb_key,mime,size,width,height,content_hash,taken_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, collectionID, p.Hash, p.Name, input.Message, input.Name, key, previewKey, thumbKey, input.Mime, size, input.Width, input.Height, input.ContentHash, input.TakenAt, now()); err != nil {
		a.internal(w, err)
		return
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE upload_sessions SET status='completed' WHERE id=?`, id); err != nil {
		a.internal(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		a.internal(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": id, "status": "pending"})
}
func (a *API) guestSubmissions(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT id,name,mime,size,width,height,thumb_key,status,created_at FROM submission_items WHERE collection_id=? AND session_hash=? ORDER BY created_at DESC`, principal(r).ScopeID, principal(r).Hash)
	if err != nil {
		a.internal(w, err)
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var id, name, mime, thumb, status, created string
		var size int64
		var width, height int
		if err := rows.Scan(&id, &name, &mime, &size, &width, &height, &thumb, &status, &created); err != nil {
			a.internal(w, err)
			return
		}
		url, _ := a.store.SignRead(r.Context(), thumb, "")
		items = append(items, map[string]any{"id": id, "name": name, "mime": mime, "size": size, "width": width, "height": height, "url": url, "status": status, "created_at": created})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
