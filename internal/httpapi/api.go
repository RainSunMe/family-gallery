package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/RainSunMe/family-gallery/internal/config"
	"github.com/RainSunMe/family-gallery/internal/i18n"
	"github.com/RainSunMe/family-gallery/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
)

type API struct {
	cfg      config.Config
	db       *sql.DB
	store    *storage.Store
	log      *slog.Logger
	attempts sync.Map
}

type Principal struct{ Role, Hash, ScopeID, Name string }
type contextKey string

const principalKey contextKey = "principal"
const languageKey contextKey = "language"

// lang resolves the response language for a request: explicit ?lang= wins,
// then the Accept-Language header, then the configured default.
func lang(r *http.Request) i18n.Lang {
	if value, ok := r.Context().Value(languageKey).(i18n.Lang); ok {
		return value
	}
	return i18n.EN
}

func (a *API) withLanguage(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resolved := a.cfg.DefaultLanguage
		if query := r.URL.Query().Get("lang"); query != "" {
			resolved = string(i18n.Parse(query))
		} else if header := r.Header.Get("Accept-Language"); header != "" {
			resolved = string(i18n.FromAcceptLanguage(header, i18n.Parse(a.cfg.DefaultLanguage)))
		}
		ctx := context.WithValue(r.Context(), languageKey, i18n.Parse(resolved))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func New(cfg config.Config, db *sql.DB, store *storage.Store, logger *slog.Logger) *API {
	return &API{cfg: cfg, db: db, store: store, log: logger}
}

func (a *API) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.RealIP, middleware.Recoverer, a.securityHeaders, a.withLanguage)
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "storage": "s3"})
	})
	r.Get("/api/v1/config", a.publicConfig)
	r.Post("/api/v1/auth/login", a.login)
	r.Post("/api/v1/auth/logout", a.logout)
	r.Get("/api/v1/auth/session", a.session)
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(a.familyAuth)
		r.Get("/albums", a.listAlbums)
		r.Post("/albums", a.createAlbum)
		r.Get("/albums/{albumID}", a.getAlbum)
		r.Patch("/albums/{albumID}", a.requireAdmin(a.updateAlbum))
		r.Delete("/albums/{albumID}", a.requireAdmin(a.trashAlbum))
		r.Put("/albums/{albumID}/cover", a.setAlbumCover)
		r.Get("/albums/{albumID}/photos", a.listPhotos)
		r.Get("/photos", a.listPhotos)
		r.Post("/media/sign-read", a.signRead)
		r.Post("/photos/trash", a.trashPhotos)
		r.Get("/trash", a.listTrash)
		r.Post("/trash/restore", a.restorePhotos)
		r.Delete("/trash", a.requireAdmin(a.emptyTrash))
		r.Post("/uploads", a.createUpload)
		r.Post("/uploads/check", a.checkDuplicates)
		r.Post("/uploads/{uploadID}/parts/sign", a.signUploadPart)
		r.Post("/uploads/{uploadID}/complete", a.completeUpload)
		r.Delete("/uploads/{uploadID}", a.abortUpload)
		r.Put("/storage/cors", a.requireAdmin(a.configureStorageCORS))
		r.Get("/collections", a.listCollections)
		r.Post("/collections", a.createCollection)
		r.Get("/collections/{collectionID}", a.getCollection)
		r.Post("/collections/{collectionID}/close", a.requireAdmin(a.closeCollection))
		r.Post("/collections/{collectionID}/sign-read", a.signCollectionRead)
		r.Post("/collections/{collectionID}/imports", a.requireAdmin(a.importCollection))
		r.Get("/shares", a.listShares)
		r.Post("/shares", a.createShare)
		r.Delete("/shares/{shareID}", a.revokeShare)
		r.Post("/downloads", a.createDownload)
		r.Get("/downloads/{jobID}", a.getDownload)
		r.Post("/downloads/{jobID}/cancel", a.cancelDownload)
		r.Post("/downloads/{jobID}/sign", a.signDownload)
	})
	r.Post("/api/v1/guest/collections/{token}/session", a.guestCollectionSession)
	r.Route("/api/v1/guest/collections", func(r chi.Router) {
		r.Use(a.collectionAuth)
		r.Get("/current", a.guestCollection)
		r.Get("/submissions", a.guestSubmissions)
		r.Post("/uploads", a.createGuestUpload)
		r.Post("/uploads/{uploadID}/parts/sign", a.signGuestPart)
		r.Post("/uploads/{uploadID}/complete", a.completeGuestUpload)
	})
	r.Route("/api/v1/guest/shares/{token}", func(r chi.Router) {
		r.Use(a.shareAuth)
		r.Get("/album", a.guestAlbum)
		r.Get("/photos", a.listPhotos)
		r.Post("/media/sign-read", a.signRead)
		r.Post("/downloads", a.createDownload)
		r.Get("/downloads/{jobID}", a.getDownload)
		r.Post("/downloads/{jobID}/sign", a.signDownload)
	})
	r.NotFound(a.serveSPA)
	static := func(prefix, directory, cacheControl string) {
		handler := http.StripPrefix(prefix, http.FileServer(http.Dir(directory)))
		r.Handle(prefix+"/*", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !a.cfg.Production {
				w.Header().Set("Cache-Control", "no-store")
			} else if cacheControl != "" {
				w.Header().Set("Cache-Control", cacheControl)
			}
			handler.ServeHTTP(w, r)
		}))
	}
	static("/assets", "./web/dist/assets", "public, max-age=31536000, immutable")
	static("/fonts", "./web/dist/fonts", "public, max-age=604800")
	static("/media", "./web/dist/media", "public, max-age=604800")
	static("/photos", "./web/dist/photos", "public, max-age=86400")
	r.Get("/favicon.svg", func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, "./web/dist/favicon.svg") })
	return r
}

func (a *API) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		// 'wasm-unsafe-eval' is what allows the HEIC decoder to compile its
		// WebAssembly module. It is deliberately narrow: it permits WebAssembly
		// compilation but not eval() of JavaScript source, so it does not widen
		// the XSS surface the way 'unsafe-eval' would.
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' http: https: data: blob:; media-src 'self' http: https: blob:; connect-src 'self' http: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("Origin") != "" && r.Header.Get("Origin") != a.cfg.PublicURL {
			writeError(w, http.StatusForbidden, "ORIGIN_REJECTED", T(r)("origin_rejected"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *API) publicConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"name":          a.cfg.SiteName,
		"tagline":       a.cfg.SiteTagline,
		"description":   a.cfg.SiteDescription,
		"defaultLocale": a.cfg.DefaultLanguage,
		"locales":       []string{"en", "zh"},
		"environment":   map[string]bool{"production": a.cfg.Production},
	})
}
func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	ip := clientIP(r.RemoteAddr)
	if a.blocked(ip) {
		writeError(w, http.StatusTooManyRequests, "TOO_MANY_ATTEMPTS", T(r)("too_many_attempts"))
		return
	}
	role := ""
	if subtle.ConstantTimeCompare([]byte(input.Password), []byte(a.cfg.AdminPassword)) == 1 {
		role = "admin"
	} else if subtle.ConstantTimeCompare([]byte(input.Password), []byte(a.cfg.FamilyPassword)) == 1 {
		role = "family"
	}
	if role == "" {
		a.fail(ip)
		writeError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", T(r)("invalid_credentials"))
		return
	}
	a.attempts.Delete(ip)
	token := randomToken()
	ttl := a.cfg.FamilySessionTTL
	if role == "admin" {
		ttl = a.cfg.AdminSessionTTL
	}
	hash := tokenHash(token)
	_, err := a.db.ExecContext(r.Context(), `INSERT INTO sessions(token_hash,role,expires_at,created_at) VALUES(?,?,?,?)`, hash, role, time.Now().Add(ttl).UTC().Format(time.RFC3339), time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		a.internal(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "cg_session", Value: token, Path: "/api", HttpOnly: true, Secure: a.cfg.Production, SameSite: http.SameSiteLaxMode, MaxAge: int(ttl.Seconds())})
	writeJSON(w, http.StatusOK, map[string]any{"role": role, "expires_at": time.Now().Add(ttl).UTC()})
}
func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie("cg_session"); err == nil {
		_, _ = a.db.ExecContext(r.Context(), `DELETE FROM sessions WHERE token_hash=?`, tokenHash(cookie.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: "cg_session", Value: "", Path: "/api", HttpOnly: true, Secure: a.cfg.Production, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	w.WriteHeader(http.StatusNoContent)
}
func (a *API) session(w http.ResponseWriter, r *http.Request) {
	p, ok := a.familyPrincipal(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", T(r)("unauthenticated"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"role": p.Role})
}

func (a *API) familyAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := a.familyPrincipal(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", T(r)("unauthenticated"))
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey, p)))
	})
}
func (a *API) familyPrincipal(r *http.Request) (Principal, bool) {
	cookie, err := r.Cookie("cg_session")
	if err != nil {
		return Principal{}, false
	}
	var p Principal
	p.Hash = tokenHash(cookie.Value)
	var expires string
	err = a.db.QueryRowContext(r.Context(), `SELECT role,expires_at FROM sessions WHERE token_hash=?`, p.Hash).Scan(&p.Role, &expires)
	if err != nil {
		return Principal{}, false
	}
	t, err := time.Parse(time.RFC3339, expires)
	if err != nil || time.Now().After(t) {
		return Principal{}, false
	}
	return p, true
}
func (a *API) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if principal(r).Role != "admin" {
			writeError(w, http.StatusForbidden, "ADMIN_REQUIRED", T(r)("admin_required"))
			return
		}
		next(w, r)
	}
}
func (a *API) collectionAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("cg_collect")
		if err != nil {
			writeError(w, http.StatusUnauthorized, "COLLECTION_SESSION_REQUIRED", T(r)("session_required"))
			return
		}
		var p Principal
		p.Role = "collect"
		p.Hash = tokenHash(cookie.Value)
		var expires string
		err = a.db.QueryRowContext(r.Context(), `SELECT collection_id,display_name,expires_at FROM collection_sessions WHERE token_hash=?`, p.Hash).Scan(&p.ScopeID, &p.Name, &expires)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "COLLECTION_SESSION_REQUIRED", T(r)("reopen_invite"))
			return
		}
		expiry, _ := time.Parse(time.RFC3339, expires)
		if time.Now().After(expiry) {
			writeError(w, http.StatusUnauthorized, "COLLECTION_EXPIRED", T(r)("collection_expired"))
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey, p)))
	})
}
func (a *API) shareAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var id string
		var expiry, revoked sql.NullString
		err := a.db.QueryRowContext(r.Context(), `SELECT id,expires_at,revoked_at FROM shares WHERE id=?`, chi.URLParam(r, "token")).Scan(&id, &expiry, &revoked)
		if err != nil || revoked.Valid || expired(expiry) {
			writeError(w, http.StatusNotFound, "LINK_UNAVAILABLE", T(r)("link_unavailable"))
			return
		}
		p := Principal{Role: "share", Hash: tokenHash(chi.URLParam(r, "token")), ScopeID: id}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey, p)))
	})
}
func principal(r *http.Request) Principal {
	p, _ := r.Context().Value(principalKey).(Principal)
	return p
}

func (a *API) blocked(ip string) bool {
	value, ok := a.attempts.Load(ip)
	if !ok {
		return false
	}
	entry := value.(*loginAttempts)
	entry.Lock()
	defer entry.Unlock()
	return entry.Count >= a.cfg.LoginMaxAttempts && time.Since(entry.Last) < a.cfg.LoginBlockDuration
}
func (a *API) fail(ip string) {
	value, _ := a.attempts.LoadOrStore(ip, &loginAttempts{})
	entry := value.(*loginAttempts)
	entry.Lock()
	defer entry.Unlock()
	if time.Since(entry.Last) > a.cfg.LoginBlockDuration {
		entry.Count = 0
	}
	entry.Count++
	entry.Last = time.Now()
}

type loginAttempts struct {
	sync.Mutex
	Count int
	Last  time.Time
}

func clientIP(addr string) string {
	if host, _, err := strings.Cut(addr, ":"); err {
		return host
	}
	return addr
}
func expired(value sql.NullString) bool {
	if !value.Valid || value.String == "" {
		return false
	}
	t, err := time.Parse(time.RFC3339, value.String)
	return err == nil && time.Now().After(t)
}
func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func randomToken() string {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	return hex.EncodeToString(value)
}
func newID() string { return uuid.NewString() }
func now() string   { return time.Now().UTC().Format(time.RFC3339) }
func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

// T resolves a translated message for the request language.
func T(r *http.Request) func(string) string {
	return func(key string) string { return i18n.T(lang(r), key) }
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message}})
}
func (a *API) internal(w http.ResponseWriter, err error) {
	a.log.Error("request failed", "error", err)
	writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", i18n.T(i18n.EN, "internal_error"))
}
func decodeJSON(w http.ResponseWriter, r *http.Request, output any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", T(r)("invalid_request"))
		return false
	}
	return true
}
func (a *API) serveSPA(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, http.StatusNotFound, "NOT_FOUND", T(r)("not_found"))
		return
	}
	path := filepath.Clean(r.URL.Path)
	if path == "." || path == "/" {
		path = "/index.html"
	}
	if path != "/index.html" {
		candidate := filepath.Join("./web/dist", strings.TrimPrefix(path, "/"))
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			if a.cfg.Production {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-store")
			}
			http.ServeFile(w, r, candidate)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, "./web/dist/index.html")
}
