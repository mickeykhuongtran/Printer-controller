package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPairingKeepsMultipleTokensForOneOrigin(t *testing.T) {
	t.Parallel()
	statePath := filepath.Join(t.TempDir(), "state", "paired-origins.json")
	store, err := newPairStore(statePath)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := newPairingManager(store, 10*time.Minute, nil)
	if err != nil {
		t.Fatal(err)
	}
	manager.mu.Lock()
	manager.code = "12345678"
	manager.expires = time.Now().Add(time.Minute)
	manager.mu.Unlock()

	const origin = "https://print.example.com"
	firstToken, err := manager.pair(origin, "12345678")
	if err != nil {
		t.Fatalf("pair: %v", err)
	}
	if firstToken == "" {
		t.Fatal("pair returned an empty token")
	}
	if !store.verify(origin, firstToken) {
		t.Fatal("first token did not verify")
	}

	manager.mu.Lock()
	manager.code = "87654321"
	manager.expires = time.Now().Add(time.Minute)
	manager.mu.Unlock()
	if _, err := manager.pair(origin, "12345678"); err == nil {
		t.Fatal("one-time code was accepted twice")
	}
	secondToken, err := manager.pair(origin, "87654321")
	if err != nil {
		t.Fatalf("second pair: %v", err)
	}
	if secondToken == "" || secondToken == firstToken {
		t.Fatal("second pairing did not return a distinct token")
	}
	if !store.verify(origin, firstToken) || !store.verify(origin, secondToken) {
		t.Fatal("pairing a second browser invalidated an existing token")
	}
	if store.verify(origin, "wrong-token") {
		t.Fatal("wrong token unexpectedly verified")
	}
	if store.count() != 1 {
		t.Fatalf("paired origin count = %d, want 1", store.count())
	}

	reloaded, err := newPairStore(statePath)
	if err != nil {
		t.Fatalf("reload pair store: %v", err)
	}
	if !reloaded.verify(origin, firstToken) || !reloaded.verify(origin, secondToken) {
		t.Fatal("persisted browser tokens did not verify after reload")
	}
	if reloaded.verify(origin, "wrong-token") {
		t.Fatal("wrong token unexpectedly verified")
	}
	record := reloaded.origins[origin]
	if len(record.Tokens) != 2 {
		t.Fatalf("persisted token count = %d, want 2", len(record.Tokens))
	}
	rawState, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, plaintext := range []string{firstToken, secondToken} {
		if bytes.Contains(rawState, []byte(plaintext)) {
			t.Fatal("pair store persisted a plaintext token")
		}
	}
}

func TestPairStoreMigratesV1SingleTokenState(t *testing.T) {
	t.Parallel()
	const (
		origin = "https://print.example.com"
		token  = "legacy-browser-token"
	)
	statePath := filepath.Join(t.TempDir(), "paired-origins.json")
	sum := sha256.Sum256([]byte(token))
	legacyState := map[string]any{
		"version": 1,
		"origins": map[string]any{
			origin: map[string]any{
				"tokenSha256": hex.EncodeToString(sum[:]),
				"pairedAt":    time.Date(2026, 7, 27, 8, 0, 0, 0, time.UTC),
			},
		},
	}
	rawLegacy, err := json.MarshalIndent(legacyState, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, rawLegacy, 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := newPairStore(statePath)
	if err != nil {
		t.Fatalf("load and migrate v1 state: %v", err)
	}
	if !store.verify(origin, token) {
		t.Fatal("migrated v1 token did not verify")
	}
	if store.verify(origin, "wrong-token") {
		t.Fatal("wrong token verified after migration")
	}
	if store.count() != 1 {
		t.Fatalf("paired origin count after migration = %d, want 1", store.count())
	}

	rawMigrated, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	var migrated persistedPairState
	if err := json.Unmarshal(rawMigrated, &migrated); err != nil {
		t.Fatalf("decode migrated state: %v", err)
	}
	if migrated.Version != pairStateVersion {
		t.Fatalf("migrated version = %d, want %d", migrated.Version, pairStateVersion)
	}
	if len(migrated.Origins[origin].Tokens) != 1 {
		t.Fatalf("migrated token count = %d, want 1", len(migrated.Origins[origin].Tokens))
	}

	reloaded, err := newPairStore(statePath)
	if err != nil {
		t.Fatalf("reload migrated state: %v", err)
	}
	if !reloaded.verify(origin, token) {
		t.Fatal("migrated token did not survive reload")
	}
}

func TestPairStoreEvictsOldestTokenAtCap(t *testing.T) {
	t.Parallel()
	const origin = "https://print.example.com"
	statePath := filepath.Join(t.TempDir(), "paired-origins.json")
	store, err := newPairStore(statePath)
	if err != nil {
		t.Fatal(err)
	}
	baseTime := time.Date(2026, 7, 27, 9, 0, 0, 0, time.UTC)
	tokens := make([]string, maxTokensPerOrigin+2)
	for index := range tokens {
		tokens[index] = fmt.Sprintf("browser-token-%02d", index)
		if err := store.add(
			origin,
			tokens[index],
			baseTime.Add(time.Duration(index)*time.Second),
		); err != nil {
			t.Fatalf("add token %d: %v", index, err)
		}
	}
	if store.verify(origin, tokens[0]) || store.verify(origin, tokens[1]) {
		t.Fatal("oldest tokens were not evicted at the per-origin cap")
	}
	for index := 2; index < len(tokens); index++ {
		if !store.verify(origin, tokens[index]) {
			t.Fatalf("retained token %d did not verify", index)
		}
	}
	if store.verify(origin, "wrong-token") {
		t.Fatal("wrong token unexpectedly verified")
	}
	record := store.origins[origin]
	if len(record.Tokens) != maxTokensPerOrigin {
		t.Fatalf("token count = %d, want cap %d", len(record.Tokens), maxTokensPerOrigin)
	}
	if store.count() != 1 {
		t.Fatalf("pairedOrigins semantics changed: count = %d, want 1", store.count())
	}

	reloaded, err := newPairStore(statePath)
	if err != nil {
		t.Fatalf("reload capped store: %v", err)
	}
	if reloaded.verify(origin, tokens[0]) || !reloaded.verify(origin, tokens[len(tokens)-1]) {
		t.Fatal("cap eviction was not preserved after reload")
	}
}

func TestPairingAttemptLimitRotatesCode(t *testing.T) {
	t.Parallel()
	store, err := newPairStore(filepath.Join(t.TempDir(), "pairs.json"))
	if err != nil {
		t.Fatal(err)
	}
	manager, err := newPairingManager(store, time.Minute, nil)
	if err != nil {
		t.Fatal(err)
	}
	manager.mu.Lock()
	manager.code = "87654321"
	manager.expires = time.Now().Add(time.Minute)
	manager.maxAttempt = 2
	manager.mu.Unlock()

	if _, err := manager.pair("https://print.example.com", "00000000"); err == nil {
		t.Fatal("first invalid code unexpectedly succeeded")
	}
	if _, err := manager.pair("https://print.example.com", "00000000"); err == nil {
		t.Fatal("second invalid code unexpectedly succeeded")
	}
	manager.mu.Lock()
	code := manager.code
	manager.mu.Unlock()
	if code == "87654321" {
		t.Fatal("attempt limit did not rotate the pairing code")
	}
}
