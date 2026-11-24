package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The service worker must never inherit the one-year immutable cache that
// `serveSPA` applies to everything under web/dist: an installed client would
// keep the old worker, and with it the old bundle filenames, until the cache
// expired. This is the regression that the release runbook warns about.
func TestServeUncachedRevalidates(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sw.js")
	if err := os.WriteFile(path, []byte("self.addEventListener('fetch', () => {});"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	api := &API{}
	recorder := httptest.NewRecorder()
	api.serveUncached(path, "text/javascript; charset=utf-8").
		ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/sw.js", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected status %d", recorder.Code)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("service worker must revalidate, got %q", got)
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/javascript") {
		t.Fatalf("a worker is only accepted with a JavaScript type, got %q", got)
	}
	// Without this header a root scope would be rejected by the browser.
	if got := recorder.Header().Get("Service-Worker-Allowed"); got != "/" {
		t.Fatalf("expected root service-worker scope, got %q", got)
	}
}

func TestServeUncachedMissingFile(t *testing.T) {
	api := &API{}
	recorder := httptest.NewRecorder()
	api.serveUncached(filepath.Join(t.TempDir(), "missing.js"), "text/javascript").
		ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/sw.js", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("a missing worker must 404 rather than serve the SPA, got %d", recorder.Code)
	}
}

// `serveSPA` still owns /api/, and it must not fall back to index.html for it.
func TestServeSPAKeepsAPI404(t *testing.T) {
	api := &API{}
	recorder := httptest.NewRecorder()
	api.serveSPA(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/nope", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unmatched API route should be 404, got %d", recorder.Code)
	}
	if body := recorder.Body.String(); strings.Contains(body, "<!doctype html>") {
		t.Fatal("unmatched API route must not return the SPA shell")
	}
}
