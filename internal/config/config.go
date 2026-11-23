package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds every runtime setting of the application.
// Defaults are production-oriented; local development must opt in explicitly.
type Config struct {
	Addr             string
	PublicURL        string
	DatabasePath     string
	FamilyPassword   string
	AdminPassword    string
	SessionSecret    string
	SiteName         string
	SiteTagline      string
	SiteDescription  string
	DefaultLanguage  string
	S3Endpoint       string
	S3PublicEndpoint string
	S3Region         string
	S3Bucket         string
	S3AccessKey      string
	S3SecretKey      string
	S3UsePathStyle   bool
	Production       bool

	ReadSignTTL        time.Duration
	UploadSignTTL      time.Duration
	FamilySessionTTL   time.Duration
	AdminSessionTTL    time.Duration
	MultipartPartSize  int64
	MaxUploadSize      int64
	DownloadPartSize   int64
	DownloadRetention  time.Duration
	WorkerInterval     time.Duration
	CollectionLinkTTL  time.Duration
	LoginMaxAttempts   int
	LoginBlockDuration time.Duration

	// DedupEnabled gates the duplicate-photo check. When false the upload API
	// ignores content_hash and behaves like before.
	DedupEnabled bool
	// DedupBackfill hashes existing photos on startup. Off by default: it reads
	// every original back out of the bucket.
	DedupBackfill bool
}

func Load() (Config, error) {
	if file := os.Getenv("APP_ENV_FILE"); file != "" {
		if err := loadFile(file); err != nil {
			return Config{}, err
		}
	}
	get := func(key, fallback string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return fallback
	}
	pathStyle, _ := strconv.ParseBool(get("S3_USE_PATH_STYLE", "true"))
	cfg := Config{
		Addr:             get("APP_ADDR", ":8080"),
		PublicURL:        strings.TrimRight(get("APP_PUBLIC_URL", "http://localhost:8080"), "/"),
		DatabasePath:     get("DATABASE_PATH", "./data/gallery.db"),
		FamilyPassword:   os.Getenv("FAMILY_PASSWORD"),
		AdminPassword:    os.Getenv("ADMIN_PASSWORD"),
		SessionSecret:    os.Getenv("SESSION_SECRET"),
		SiteName:         get("SITE_NAME", "Family Gallery"),
		SiteTagline:      get("SITE_TAGLINE", "PRIVATE FAMILY PHOTOS"),
		SiteDescription:  get("SITE_DESCRIPTION", "A self-hosted family photo album"),
		DefaultLanguage:  language(get("DEFAULT_LANGUAGE", "en")),
		S3Endpoint:       strings.TrimRight(os.Getenv("S3_ENDPOINT"), "/"),
		S3PublicEndpoint: strings.TrimRight(get("S3_PUBLIC_ENDPOINT", os.Getenv("S3_ENDPOINT")), "/"),
		S3Region:         get("S3_REGION", "garage"),
		S3Bucket:         os.Getenv("S3_BUCKET"),
		S3AccessKey:      os.Getenv("S3_ACCESS_KEY"),
		S3SecretKey:      os.Getenv("S3_SECRET_KEY"),
		S3UsePathStyle:   pathStyle,
		Production:       get("APP_ENV", "production") == "production",

		ReadSignTTL:        duration(get, "SIGNED_READ_TTL", 5*time.Minute),
		UploadSignTTL:      duration(get, "SIGNED_UPLOAD_TTL", 15*time.Minute),
		FamilySessionTTL:   duration(get, "FAMILY_SESSION_TTL", 30*24*time.Hour),
		AdminSessionTTL:    duration(get, "ADMIN_SESSION_TTL", 12*time.Hour),
		MultipartPartSize:  size(get, "MULTIPART_PART_SIZE", 8<<20),
		MaxUploadSize:      size(get, "MAX_UPLOAD_SIZE", 200<<20),
		DownloadPartSize:   size(get, "DOWNLOAD_PART_SIZE", 500<<20),
		DownloadRetention:  duration(get, "DOWNLOAD_RETENTION", 24*time.Hour),
		WorkerInterval:     duration(get, "WORKER_INTERVAL", 2*time.Second),
		CollectionLinkTTL:  duration(get, "COLLECTION_SESSION_TTL", 7*24*time.Hour),
		LoginMaxAttempts:   integer(get, "LOGIN_MAX_ATTEMPTS", 10),
		LoginBlockDuration: duration(get, "LOGIN_BLOCK_DURATION", 5*time.Minute),
		DedupEnabled:       boolean(get, "DEDUP_ENABLED", true),
		DedupBackfill:      boolean(get, "DEDUP_BACKFILL", false),
	}
	if cfg.FamilyPassword == "" || cfg.AdminPassword == "" {
		return Config{}, errors.New("FAMILY_PASSWORD and ADMIN_PASSWORD must be set")
	}
	if cfg.FamilyPassword == cfg.AdminPassword {
		return Config{}, errors.New("family and admin passwords must differ")
	}
	if cfg.Production && (cfg.FamilyPassword == "family" || cfg.AdminPassword == "admin") {
		return Config{}, errors.New("production requires non-default family and admin passwords")
	}
	if len(cfg.SessionSecret) < 32 {
		return Config{}, errors.New("SESSION_SECRET must be at least 32 characters")
	}
	if len([]rune(cfg.SiteName)) > 40 || len([]rune(cfg.SiteTagline)) > 60 || len([]rune(cfg.SiteDescription)) > 160 {
		return Config{}, errors.New("SITE_NAME, SITE_TAGLINE and SITE_DESCRIPTION are too long")
	}
	if cfg.S3Endpoint == "" || cfg.S3PublicEndpoint == "" || cfg.S3Bucket == "" || cfg.S3AccessKey == "" || cfg.S3SecretKey == "" {
		return Config{}, errors.New("S3 endpoint, public endpoint, bucket and credentials are required")
	}
	if cfg.Production && (!strings.HasPrefix(cfg.PublicURL, "https://") || !strings.HasPrefix(cfg.S3PublicEndpoint, "https://")) {
		return Config{}, errors.New("production public URLs must use HTTPS")
	}
	if cfg.MultipartPartSize < 5<<20 {
		return Config{}, errors.New("MULTIPART_PART_SIZE must be at least 5 MiB (S3 minimum part size)")
	}
	if cfg.MaxUploadSize < cfg.MultipartPartSize {
		return Config{}, errors.New("MAX_UPLOAD_SIZE must not be smaller than MULTIPART_PART_SIZE")
	}
	return cfg, nil
}

func duration(get func(string, string) string, key string, fallback time.Duration) time.Duration {
	value, err := time.ParseDuration(get(key, ""))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func size(get func(string, string) string, key string, fallback int64) int64 {
	value, err := strconv.ParseInt(get(key, ""), 10, 64)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func integer(get func(string, string) string, key string, fallback int) int {
	value, err := strconv.Atoi(get(key, ""))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

// boolean treats an unparsable or absent value as the fallback, so a typo in
// .env never silently flips a safety-relevant switch.
func boolean(get func(string, string) string, key string, fallback bool) bool {
	raw := strings.TrimSpace(get(key, ""))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return fallback
	}
	return value
}

// SupportedLanguage reports whether the given language tag is supported.
func SupportedLanguage(tag string) bool {
	switch strings.ToLower(strings.TrimSpace(tag)) {
	case "en", "zh", "zh-cn":
		return true
	}
	return false
}

func language(tag string) string {
	value := strings.ToLower(strings.TrimSpace(tag))
	if value == "zh-cn" {
		value = "zh"
	}
	if !SupportedLanguage(value) {
		return "en"
	}
	return value
}

func loadFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open APP_ENV_FILE: %w", err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if os.Getenv(key) != "" {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), "\"'")
		if err := os.Setenv(key, value); err != nil {
			return err
		}
	}
	return scanner.Err()
}
