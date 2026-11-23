package httpapi

import "net/http"

// configureStorageCORS applies the exact application origin, never a wildcard.
// The S3 credentials stay on the server; browsers only receive object-scoped URLs.
func (a *API) configureStorageCORS(w http.ResponseWriter, r *http.Request) {
	if err := a.store.ConfigureCORS(r.Context(), a.cfg.PublicURL); err != nil {
		a.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"configured": true, "origin": a.cfg.PublicURL})
}
