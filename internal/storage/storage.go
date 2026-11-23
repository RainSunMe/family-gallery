package storage

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/RainSunMe/family-gallery/internal/config"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type Store struct {
	client    *s3.Client
	presign   *s3.PresignClient
	bucket    string
	readTTL   time.Duration
	uploadTTL time.Duration
}

func New(ctx context.Context, cfg config.Config) (*Store, error) {
	load := func(endpoint string) (aws.Config, error) {
		return awsconfig.LoadDefaultConfig(ctx,
			awsconfig.WithRegion(cfg.S3Region),
			awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.S3AccessKey, cfg.S3SecretKey, "")),
			awsconfig.WithBaseEndpoint(endpoint),
			awsconfig.WithRequestChecksumCalculation(aws.RequestChecksumCalculationWhenRequired),
			awsconfig.WithResponseChecksumValidation(aws.ResponseChecksumValidationWhenRequired),
		)
	}
	internal, err := load(cfg.S3Endpoint)
	if err != nil {
		return nil, err
	}
	public, err := load(cfg.S3PublicEndpoint)
	if err != nil {
		return nil, err
	}
	client := s3.NewFromConfig(internal, func(o *s3.Options) { o.UsePathStyle = cfg.S3UsePathStyle })
	publicClient := s3.NewFromConfig(public, func(o *s3.Options) { o.UsePathStyle = cfg.S3UsePathStyle })
	return &Store{client: client, presign: s3.NewPresignClient(publicClient), bucket: cfg.S3Bucket, readTTL: cfg.ReadSignTTL, uploadTTL: cfg.UploadSignTTL}, nil
}

func (s *Store) SignRead(ctx context.Context, key string, downloadName string) (string, error) {
	input := &s3.GetObjectInput{Bucket: &s.bucket, Key: &key}
	if downloadName != "" {
		input.ResponseContentDisposition = aws.String(`attachment; filename="` + safeDisposition(downloadName) + `"`)
	}
	req, err := s.presign.PresignGetObject(ctx, input, s3.WithPresignExpires(s.readTTL))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

func (s *Store) SignUpload(ctx context.Context, key, mime string) (string, error) {
	req, err := s.presign.PresignPutObject(ctx, &s3.PutObjectInput{Bucket: &s.bucket, Key: &key, ContentType: &mime}, s3.WithPresignExpires(s.uploadTTL))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

func (s *Store) Head(ctx context.Context, key string, expectedSize int64) error {
	out, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		return err
	}
	if expectedSize >= 0 && aws.ToInt64(out.ContentLength) != expectedSize {
		return fmt.Errorf("object size mismatch")
	}
	return nil
}

func (s *Store) Copy(ctx context.Context, source, destination string) error {
	_, err := s.client.CopyObject(ctx, &s3.CopyObjectInput{Bucket: &s.bucket, Key: &destination, CopySource: aws.String(s.bucket + "/" + source)})
	return err
}

func (s *Store) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		return nil, err
	}
	return out.Body, nil
}

func (s *Store) Put(ctx context.Context, key string, body io.Reader, size int64) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: &s.bucket, Key: &key, Body: body, ContentLength: &size, ContentType: aws.String("application/zip"), ContentDisposition: aws.String("attachment")})
	return err
}

func (s *Store) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.bucket, Key: &key})
	return err
}

func (s *Store) ConfigureCORS(ctx context.Context, origin string) error {
	_, err := s.client.PutBucketCors(ctx, &s3.PutBucketCorsInput{Bucket: &s.bucket, CORSConfiguration: &types.CORSConfiguration{CORSRules: []types.CORSRule{{AllowedOrigins: []string{origin}, AllowedMethods: []string{"GET", "PUT", "HEAD"}, AllowedHeaders: []string{"*"}, ExposeHeaders: []string{"ETag", "Content-Length"}, MaxAgeSeconds: aws.Int32(3600)}}}})
	return err
}

func safeDisposition(value string) string {
	out := make([]rune, 0, len(value))
	for _, r := range value {
		if r >= 32 && r != '"' && r != '\\' && r != '\r' && r != '\n' {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return "photo"
	}
	return string(out)
}

func (s *Store) StartMultipart(ctx context.Context, key, mime string) (string, error) {
	out, err := s.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: &s.bucket, Key: &key, ContentType: &mime})
	if err != nil {
		return "", err
	}
	return aws.ToString(out.UploadId), nil
}

func (s *Store) SignPart(ctx context.Context, key, uploadID string, part int32) (string, error) {
	req, err := s.presign.PresignUploadPart(ctx, &s3.UploadPartInput{Bucket: &s.bucket, Key: &key, UploadId: &uploadID, PartNumber: &part}, s3.WithPresignExpires(s.uploadTTL))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

func (s *Store) CompleteMultipart(ctx context.Context, key, uploadID string, parts []types.CompletedPart) error {
	_, err := s.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{Bucket: &s.bucket, Key: &key, UploadId: &uploadID, MultipartUpload: &types.CompletedMultipartUpload{Parts: parts}})
	return err
}

func (s *Store) AbortMultipart(ctx context.Context, key, uploadID string) error {
	_, err := s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: &s.bucket, Key: &key, UploadId: &uploadID})
	return err
}
