package httpapi

import "testing"

func TestTokenHashChangesWithToken(t *testing.T) {
	if tokenHash("first") == tokenHash("second") {
		t.Fatal("session tokens must not share hashes")
	}
	if tokenHash("first") != tokenHash("first") {
		t.Fatal("hash must be deterministic")
	}
	if len(randomToken()) != 64 {
		t.Fatal("session token must contain 32 random bytes")
	}
}

func TestUniqueName(t *testing.T) {
	used := map[string]int{}
	if got := uniqueName("family.jpg", used); got != "family.jpg" {
		t.Fatalf("unexpected name %q", got)
	}
	if got := uniqueName("family.jpg", used); got != "family (2).jpg" {
		t.Fatalf("unexpected duplicate name %q", got)
	}
	if got := uniqueName("family.jpg", used); got != "family (3).jpg" {
		t.Fatalf("unexpected duplicate name %q", got)
	}
}

func TestValidateUpload(t *testing.T) {
	valid := uploadRequest{Name: "family.jpg", Size: 1024, Mime: "image/jpeg"}
	if _, ok := validateUpload(valid, 200<<20); !ok {
		t.Fatal("valid image should be accepted")
	}
	invalid := valid
	invalid.Size = 0
	if _, ok := validateUpload(invalid, 200<<20); ok {
		t.Fatal("empty file must be rejected")
	}
	invalid = valid
	invalid.Mime = "application/x-msdownload"
	if _, ok := validateUpload(invalid, 200<<20); ok {
		t.Fatal("executable must be rejected")
	}
	invalid = valid
	invalid.Size = 201 << 20
	if _, ok := validateUpload(invalid, 200<<20); ok {
		t.Fatal("oversized file must be rejected")
	}
	if _, ok := validateUpload(invalid, 300<<20); !ok {
		t.Fatal("file within configured limit must be accepted")
	}
}

func TestPlaceholders(t *testing.T) {
	if got := placeholders(3); got != "?,?,?" {
		t.Fatalf("unexpected placeholders %q", got)
	}
}
