package httpapi

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

type Album struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	CoverURL     string `json:"cover_url"`
	CoverPhotoID string `json:"cover_photo_id"`
	PhotoCount   int    `json:"photo_count"`
	Shared       bool   `json:"shared"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
	// Earliest and latest capture time across the album; empty when it has no photos.
	TakenFrom string `json:"taken_from"`
	TakenTo   string `json:"taken_to"`
}
type Photo struct {
	ID          string `json:"id"`
	AlbumID     string `json:"album_id"`
	Name        string `json:"name"`
	Mime        string `json:"mime"`
	Size        int64  `json:"size"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	TakenAt     string `json:"taken_at"`
	Contributor string `json:"contributor,omitempty"`
	Status      string `json:"status,omitempty"`
}

func (a *API) listAlbums(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT a.id,a.name,a.description,
	 COALESCE(NULLIF(a.cover_key,''),(SELECT p.thumb_key FROM photos p WHERE p.album_id=a.id AND p.deleted_at IS NULL ORDER BY p.taken_at DESC,p.id DESC LIMIT 1)),
	 COALESCE(a.cover_photo_id,''),a.created_at,a.updated_at,
	 (SELECT COUNT(*) FROM photos p WHERE p.album_id=a.id AND p.deleted_at IS NULL),
	 EXISTS(SELECT 1 FROM shares s WHERE s.album_id=a.id AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>?)),
	 COALESCE((SELECT MIN(p.taken_at) FROM photos p WHERE p.album_id=a.id AND p.deleted_at IS NULL),''),
	 COALESCE((SELECT MAX(p.taken_at) FROM photos p WHERE p.album_id=a.id AND p.deleted_at IS NULL),'')
	 FROM albums a WHERE a.deleted_at IS NULL ORDER BY a.updated_at DESC`, now())
	if err != nil {
		a.internal(w, err)
		return
	}
	defer rows.Close()
	albums := make([]Album, 0)
	for rows.Next() {
		var item Album
		var cover sql.NullString
		if err := rows.Scan(&item.ID, &item.Name, &item.Description, &cover, &item.CoverPhotoID, &item.CreatedAt, &item.UpdatedAt, &item.PhotoCount, &item.Shared, &item.TakenFrom, &item.TakenTo); err != nil {
			a.internal(w, err)
			return
		}
		if cover.Valid && cover.String != "" {
			item.CoverURL, _ = a.store.SignRead(r.Context(), cover.String, "")
		}
		albums = append(albums, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": albums})
}
func (a *API) createAlbum(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if input.Name == "" || len([]rune(input.Name)) > 40 || len([]rune(input.Description)) > 120 {
		writeError(w, http.StatusBadRequest, "INVALID_ALBUM", T(r)("album_invalid"))
		return
	}
	id := newID()
	timestamp := now()
	_, err := a.db.ExecContext(r.Context(), `INSERT INTO albums(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)`, id, input.Name, input.Description, timestamp, timestamp)
	if err != nil {
		a.internal(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, Album{ID: id, Name: input.Name, Description: input.Description, CreatedAt: timestamp, UpdatedAt: timestamp})
}
func (a *API) getAlbum(w http.ResponseWriter, r *http.Request) {
	album, ok := a.albumByID(r, chi.URLParam(r, "albumID"), principal(r).Role == "share")
	if !ok {
		writeError(w, http.StatusNotFound, "ALBUM_NOT_FOUND", T(r)("album_not_found"))
		return
	}
	writeJSON(w, http.StatusOK, album)
}
func (a *API) albumByID(r *http.Request, id string, shared bool) (Album, bool) {
	var item Album
	var cover sql.NullString
	err := a.db.QueryRowContext(r.Context(), `SELECT a.id,a.name,a.description,
	 COALESCE(NULLIF(a.cover_key,''),(SELECT p.thumb_key FROM photos p WHERE p.album_id=a.id AND p.deleted_at IS NULL ORDER BY p.taken_at DESC,p.id DESC LIMIT 1)),
	 COALESCE(a.cover_photo_id,''),a.created_at,a.updated_at,
	 (SELECT COUNT(*) FROM photos p WHERE p.album_id=a.id AND p.deleted_at IS NULL),
	 EXISTS(SELECT 1 FROM shares s WHERE s.album_id=a.id AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>?)),
	 COALESCE((SELECT MIN(p.taken_at) FROM photos p WHERE p.album_id=a.id AND p.deleted_at IS NULL),''),
	 COALESCE((SELECT MAX(p.taken_at) FROM photos p WHERE p.album_id=a.id AND p.deleted_at IS NULL),'')
	 FROM albums a WHERE a.id=? AND a.deleted_at IS NULL`, now(), id).Scan(&item.ID, &item.Name, &item.Description, &cover, &item.CoverPhotoID, &item.CreatedAt, &item.UpdatedAt, &item.PhotoCount, &item.Shared, &item.TakenFrom, &item.TakenTo)
	if err != nil {
		return Album{}, false
	}
	if cover.Valid && cover.String != "" {
		item.CoverURL, _ = a.store.SignRead(r.Context(), cover.String, "")
	}
	return item, true
}
func (a *API) updateAlbum(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len([]rune(input.Name)) > 40 {
		writeError(w, http.StatusBadRequest, "INVALID_ALBUM", T(r)("album_invalid"))
		return
	}
	_, err := a.db.ExecContext(r.Context(), `UPDATE albums SET name=?,description=?,updated_at=? WHERE id=? AND deleted_at IS NULL`, input.Name, strings.TrimSpace(input.Description), now(), chi.URLParam(r, "albumID"))
	if err != nil {
		a.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"updated": true})
}
func (a *API) setAlbumCover(w http.ResponseWriter, r *http.Request) {
	var input struct {
		PhotoID string `json:"photo_id"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	albumID := chi.URLParam(r, "albumID")
	var thumbKey string
	if err := a.db.QueryRowContext(r.Context(), `SELECT thumb_key FROM photos WHERE id=? AND album_id=? AND deleted_at IS NULL`, input.PhotoID, albumID).Scan(&thumbKey); err != nil {
		writeError(w, http.StatusNotFound, "PHOTO_NOT_FOUND", T(r)("photo_not_owned"))
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `UPDATE albums SET cover_key=?,cover_photo_id=?,updated_at=? WHERE id=? AND deleted_at IS NULL`, thumbKey, input.PhotoID, now(), albumID); err != nil {
		a.internal(w, err)
		return
	}
	album, ok := a.albumByID(r, albumID, false)
	if !ok {
		writeError(w, http.StatusNotFound, "ALBUM_NOT_FOUND", T(r)("album_not_found"))
		return
	}
	writeJSON(w, http.StatusOK, album)
}
func (a *API) listPhotos(w http.ResponseWriter, r *http.Request) {
	albumID := chi.URLParam(r, "albumID")
	if albumID == "" {
		albumID = r.URL.Query().Get("album_id")
	}
	if principal(r).Role == "share" {
		var shareAlbum string
		if err := a.db.QueryRowContext(r.Context(), `SELECT album_id FROM shares WHERE id=?`, principal(r).ScopeID).Scan(&shareAlbum); err != nil {
			writeError(w, http.StatusNotFound, "LINK_UNAVAILABLE", T(r)("link_unavailable"))
			return
		}
		if albumID != "" && albumID != shareAlbum {
			writeError(w, http.StatusForbidden, "FORBIDDEN", T(r)("forbidden"))
			return
		}
		albumID = shareAlbum
	}
	limit := 60
	where := `p.deleted_at IS NULL`
	args := []any{}
	if albumID != "" {
		where += ` AND p.album_id=?`
		args = append(args, albumID)
	}
	if mime := r.URL.Query().Get("type"); mime == "photo" {
		where += ` AND p.mime LIKE 'image/%'`
	} else if mime == "video" {
		where += ` AND p.mime LIKE 'video/%'`
	}
	if search := strings.TrimSpace(r.URL.Query().Get("q")); search != "" {
		where += ` AND p.name LIKE ?`
		args = append(args, "%"+search+"%")
	}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		parts := strings.SplitN(cursor, "|", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			writeError(w, http.StatusBadRequest, "INVALID_CURSOR", T(r)("invalid_cursor"))
			return
		}
		where += ` AND (p.taken_at<? OR (p.taken_at=? AND p.id<?))`
		args = append(args, parts[0], parts[0], parts[1])
	}
	args = append(args, limit+1)
	rows, err := a.db.QueryContext(r.Context(), `SELECT p.id,p.album_id,p.name,p.mime,p.size,p.width,p.height,p.taken_at,p.thumb_key,p.contributor FROM photos p WHERE `+where+` ORDER BY p.taken_at DESC,p.id DESC LIMIT ?`, args...)
	if err != nil {
		a.internal(w, err)
		return
	}
	defer rows.Close()
	photos, keys, next, err := collectPhotoPage(rows, limit)
	if err != nil {
		a.internal(w, err)
		return
	}
	urls := make(map[string]string, len(photos))
	for index, item := range photos {
		url, _ := a.store.SignRead(r.Context(), keys[index], "")
		urls[item.ID] = url
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": photos, "urls": urls, "next_cursor": next})
}

// collectPhotoPage reads at most `limit` photos and works out the next cursor.
//
// The query fetches limit+1 rows so the caller can tell "last page" from "more to
// come" without a second count query. The cursor must therefore come from the
// last row actually *returned*: taking it from the extra probe row made the next
// page resume past that row, so one photo vanished at every page boundary.
func collectPhotoPage(rows *sql.Rows, limit int) ([]Photo, []string, string, error) {
	photos := make([]Photo, 0, limit)
	keys := make([]string, 0, limit)
	lastTaken := ""
	lastID := ""
	for rows.Next() {
		var item Photo
		var key string
		if err := rows.Scan(&item.ID, &item.AlbumID, &item.Name, &item.Mime, &item.Size, &item.Width, &item.Height, &item.TakenAt, &key, &item.Contributor); err != nil {
			return nil, nil, "", err
		}
		if len(photos) >= limit {
			// The probe row only proves there is another page.
			continue
		}
		photos = append(photos, item)
		keys = append(keys, key)
		lastTaken = item.TakenAt
		lastID = item.ID
	}
	next := ""
	if len(photos) == limit {
		next = lastTaken + "|" + lastID
	}
	return photos, keys, next, rows.Err()
}

func (a *API) signRead(w http.ResponseWriter, r *http.Request) {
	var input struct {
		PhotoID  string `json:"photo_id"`
		Variant  string `json:"variant"`
		Download bool   `json:"download"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	var key, name string
	var err error
	if principal(r).Role == "share" {
		err = a.db.QueryRowContext(r.Context(), `SELECT p.original_key,p.name FROM photos p JOIN shares s ON s.album_id=p.album_id WHERE p.id=? AND s.id=? AND p.deleted_at IS NULL`, input.PhotoID, principal(r).ScopeID).Scan(&key, &name)
	} else {
		err = a.db.QueryRowContext(r.Context(), `SELECT original_key,name FROM photos WHERE id=? AND deleted_at IS NULL`, input.PhotoID).Scan(&key, &name)
	}
	if err != nil {
		writeError(w, http.StatusNotFound, "PHOTO_NOT_FOUND", T(r)("photo_not_found"))
		return
	}
	if input.Variant == "thumb" || input.Variant == "preview" {
		err = a.db.QueryRowContext(r.Context(), `SELECT `+input.Variant+`_key FROM photos WHERE id=?`, input.PhotoID).Scan(&key)
		if err != nil {
			a.internal(w, err)
			return
		}
	}
	url, err := a.store.SignRead(r.Context(), key, func() string {
		if input.Download {
			return name
		}
		return ""
	}())
	if err != nil {
		a.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url, "expires_at": time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339)})
}
