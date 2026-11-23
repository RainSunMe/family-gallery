package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/RainSunMe/family-gallery/internal/config"
	"github.com/RainSunMe/family-gallery/internal/database"
	"github.com/RainSunMe/family-gallery/internal/httpapi"
	"github.com/RainSunMe/family-gallery/internal/storage"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	cfg, err := config.Load()
	if err != nil {
		logger.Error("configuration error", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, err := database.Open(ctx, cfg.DatabasePath)
	if err != nil {
		logger.Error("database error", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	store, err := storage.New(ctx, cfg)
	if err != nil {
		logger.Error("storage error", "error", err)
		os.Exit(1)
	}
	api := httpapi.New(cfg, db, store, logger)
	server := &http.Server{Addr: cfg.Addr, Handler: api.Routes(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 90 * time.Second}
	go api.RunWorker(ctx)
	go func() {
		logger.Info("server started", "addr", cfg.Addr, "storage", "generic-s3", "bucket", cfg.S3Bucket)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "error", err)
			stop()
		}
	}()
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown error", "error", err)
	}
	logger.Info("server stopped")
}
