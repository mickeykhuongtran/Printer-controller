package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const (
	pairStateVersion   = 2
	maxTokensPerOrigin = 32
)

type pairedTokenRecord struct {
	TokenSHA256 string    `json:"tokenSha256"`
	PairedAt    time.Time `json:"pairedAt"`
}

type pairedOriginRecord struct {
	Tokens []pairedTokenRecord `json:"tokens"`
}

type persistedPairState struct {
	Version int                           `json:"version"`
	Origins map[string]pairedOriginRecord `json:"origins"`
}

type persistedPairStateEnvelope struct {
	Version int                        `json:"version"`
	Origins map[string]json.RawMessage `json:"origins"`
}

type pairStore struct {
	mu      sync.RWMutex
	path    string
	origins map[string]pairedOriginRecord
}

func newPairStore(path string) (*pairStore, error) {
	store := &pairStore{
		path:    path,
		origins: make(map[string]pairedOriginRecord),
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	var envelope persistedPairStateEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	if envelope.Version > pairStateVersion {
		return nil, fmt.Errorf(
			"decode %s: unsupported pairing state version %d",
			path,
			envelope.Version,
		)
	}
	needsMigration := envelope.Version != pairStateVersion
	for rawOrigin, rawRecord := range envelope.Origins {
		origin, originErr := normalizeOrigin(rawOrigin)
		if originErr != nil || origin != rawOrigin {
			return nil, fmt.Errorf("decode %s: invalid paired origin %q", path, rawOrigin)
		}
		record, migrated, decodeErr := decodePairedOriginRecord(rawRecord)
		if decodeErr != nil {
			return nil, fmt.Errorf("decode %s origin %q: %w", path, origin, decodeErr)
		}
		store.origins[origin] = record
		needsMigration = needsMigration || migrated
	}
	if needsMigration {
		store.mu.Lock()
		err = store.saveLocked()
		store.mu.Unlock()
		if err != nil {
			return nil, fmt.Errorf("migrate %s: %w", path, err)
		}
	}
	return store, nil
}

func decodePairedOriginRecord(raw json.RawMessage) (pairedOriginRecord, bool, error) {
	var wire struct {
		TokenSHA256 string              `json:"tokenSha256"`
		PairedAt    time.Time           `json:"pairedAt"`
		Tokens      []pairedTokenRecord `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return pairedOriginRecord{}, false, err
	}
	migrated := false
	tokens := wire.Tokens
	if len(tokens) == 0 && wire.TokenSHA256 != "" {
		tokens = []pairedTokenRecord{{
			TokenSHA256: wire.TokenSHA256,
			PairedAt:    wire.PairedAt,
		}}
		migrated = true
	}
	if len(tokens) == 0 {
		return pairedOriginRecord{}, false, fmt.Errorf("token list is empty")
	}
	sanitized, changed, err := sanitizeTokenRecords(tokens)
	if err != nil {
		return pairedOriginRecord{}, false, err
	}
	return pairedOriginRecord{Tokens: sanitized}, migrated || changed, nil
}

func sanitizeTokenRecords(tokens []pairedTokenRecord) ([]pairedTokenRecord, bool, error) {
	byHash := make(map[string]pairedTokenRecord, len(tokens))
	changed := false
	for _, record := range tokens {
		hash, err := hex.DecodeString(record.TokenSHA256)
		if err != nil || len(hash) != sha256.Size {
			return nil, false, fmt.Errorf("tokenSha256 is invalid")
		}
		record.TokenSHA256 = hex.EncodeToString(hash)
		record.PairedAt = record.PairedAt.UTC()
		if previous, exists := byHash[record.TokenSHA256]; exists {
			changed = true
			if previous.PairedAt.After(record.PairedAt) {
				continue
			}
		}
		byHash[record.TokenSHA256] = record
	}
	sanitized := make([]pairedTokenRecord, 0, len(byHash))
	for _, record := range byHash {
		sanitized = append(sanitized, record)
	}
	sort.SliceStable(sanitized, func(left, right int) bool {
		if sanitized[left].PairedAt.Equal(sanitized[right].PairedAt) {
			return sanitized[left].TokenSHA256 < sanitized[right].TokenSHA256
		}
		return sanitized[left].PairedAt.Before(sanitized[right].PairedAt)
	})
	if len(sanitized) > maxTokensPerOrigin {
		sanitized = sanitized[len(sanitized)-maxTokensPerOrigin:]
		changed = true
	}
	if len(sanitized) != len(tokens) {
		changed = true
	}
	return sanitized, changed, nil
}

func (s *pairStore) isPaired(origin string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.origins[origin]
	return ok && len(record.Tokens) > 0
}

func (s *pairStore) verify(origin, token string) bool {
	if token == "" {
		return false
	}
	s.mu.RLock()
	record, ok := s.origins[origin]
	s.mu.RUnlock()
	if !ok {
		return false
	}
	actual := sha256.Sum256([]byte(token))
	matched := 0
	for _, candidate := range record.Tokens {
		expected, err := hex.DecodeString(candidate.TokenSHA256)
		if err != nil || len(expected) != sha256.Size {
			expected = make([]byte, sha256.Size)
		}
		matched |= subtle.ConstantTimeCompare(expected, actual[:])
	}
	return matched == 1
}

func (s *pairStore) add(origin, token string, pairedAt time.Time) error {
	if token == "" {
		return fmt.Errorf("token is empty")
	}
	sum := sha256.Sum256([]byte(token))
	newToken := pairedTokenRecord{
		TokenSHA256: hex.EncodeToString(sum[:]),
		PairedAt:    pairedAt.UTC(),
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	previous, existed := s.origins[origin]
	tokens := append([]pairedTokenRecord(nil), previous.Tokens...)
	tokens = append(tokens, newToken)
	sanitized, _, err := sanitizeTokenRecords(tokens)
	if err != nil {
		return err
	}
	s.origins[origin] = pairedOriginRecord{Tokens: sanitized}
	if err := s.saveLocked(); err != nil {
		if existed {
			s.origins[origin] = previous
		} else {
			delete(s.origins, origin)
		}
		return err
	}
	return nil
}

func (s *pairStore) count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.origins)
}

func (s *pairStore) saveLocked() error {
	state := persistedPairState{
		Version: pairStateVersion,
		Origins: s.origins,
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(s.path), ".paired-origins-*.tmp")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(raw); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempName, s.path); err != nil {
		return err
	}
	return os.Chmod(s.path, 0o600)
}

type pairingManager struct {
	mu         sync.Mutex
	store      *pairStore
	ttl        time.Duration
	code       string
	expires    time.Time
	attempts   int
	maxAttempt int
	onCode     func(string, time.Time)
	now        func() time.Time
}

func newPairingManager(store *pairStore, ttl time.Duration, onCode func(string, time.Time)) (*pairingManager, error) {
	manager := &pairingManager{
		store:      store,
		ttl:        ttl,
		maxAttempt: 10,
		onCode:     onCode,
		now:        time.Now,
	}
	if err := manager.rotateLocked(); err != nil {
		return nil, err
	}
	return manager, nil
}

func (m *pairingManager) rotateLocked() error {
	number, err := rand.Int(rand.Reader, big.NewInt(100_000_000))
	if err != nil {
		return err
	}
	m.code = fmt.Sprintf("%08d", number.Int64())
	m.expires = m.now().Add(m.ttl)
	m.attempts = 0
	if m.onCode != nil {
		m.onCode(m.code, m.expires)
	}
	return nil
}

func (m *pairingManager) pair(origin, suppliedCode string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := m.now()
	if !now.Before(m.expires) {
		if err := m.rotateLocked(); err != nil {
			return "", err
		}
		return "", &apiError{Status: 401, Message: "Pairing code expired. Use the new code displayed by the connector."}
	}
	if len(suppliedCode) != 8 || subtle.ConstantTimeCompare([]byte(suppliedCode), []byte(m.code)) != 1 {
		m.attempts++
		if m.attempts >= m.maxAttempt {
			if err := m.rotateLocked(); err != nil {
				return "", err
			}
			return "", &apiError{Status: 429, Message: "Too many pairing attempts. A new code was generated."}
		}
		return "", &apiError{Status: 401, Message: "Invalid pairing code."}
	}

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	if err := m.store.add(origin, token, now); err != nil {
		return "", fmt.Errorf("persist pairing: %w", err)
	}
	if err := m.rotateLocked(); err != nil {
		return "", err
	}
	return token, nil
}

func (m *pairingManager) expiresAt() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.expires
}

func sortedPorts(ports map[int]struct{}) []int {
	values := make([]int, 0, len(ports))
	for port := range ports {
		values = append(values, port)
	}
	sort.Ints(values)
	return values
}
