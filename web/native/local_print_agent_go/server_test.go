package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func testServer(t *testing.T) (*appServer, *pairingManager) {
	t.Helper()
	return testServerAt(t, "127.0.0.1")
}

func testServerAt(t *testing.T, rawListenAddress string) (*appServer, *pairingManager) {
	t.Helper()
	return testServerConfigured(t, rawListenAddress, false)
}

func testServerConfigured(
	t *testing.T,
	rawListenAddress string,
	requireOriginToken bool,
) (*appServer, *pairingManager) {
	t.Helper()
	store, err := newPairStore(filepath.Join(t.TempDir(), "pairs.json"))
	if err != nil {
		t.Fatal(err)
	}
	pairing, err := newPairingManager(store, 10*time.Minute, nil)
	if err != nil {
		t.Fatal(err)
	}
	configuredListenAddress, err := parseListenAddress(rawListenAddress)
	if err != nil {
		t.Fatal(err)
	}
	server := newAppServer(serverConfig{
		ListenAddress:      configuredListenAddress,
		Port:               17917,
		AllowedTCPPorts:    map[int]struct{}{9100: {}},
		RequireOriginToken: requireOriginToken,
		Pairing:            pairing,
		Logger:             log.New(io.Discard, "", 0),
	})
	t.Cleanup(server.rawSpoolBatches.close)
	return server, pairing
}

func TestSiteModeHealthAndProtectedOriginRequirement(t *testing.T) {
	t.Parallel()
	server, pairing := testServerAt(t, "192.168.50.10")
	const (
		gatewayURL  = "http://192.168.50.10:17917"
		cloudOrigin = "https://print.example.com"
	)

	healthRequest := httptest.NewRequest(http.MethodGet, gatewayURL+"/v1/health", nil)
	healthResponse := httptest.NewRecorder()
	server.ServeHTTP(healthResponse, healthRequest)
	if healthResponse.Code != http.StatusOK {
		t.Fatalf("health status = %d, body=%s", healthResponse.Code, healthResponse.Body)
	}
	var health struct {
		ListenAddress      string `json:"listenAddress"`
		SiteMode           bool   `json:"siteMode"`
		RequireOriginToken bool   `json:"requireOriginToken"`
	}
	if err := json.Unmarshal(healthResponse.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	if health.ListenAddress != "192.168.50.10" ||
		!health.SiteMode ||
		!health.RequireOriginToken {
		t.Fatalf("unexpected site health: %+v", health)
	}

	protectedBody := []byte(`{"host":"8.8.8.8","port":9100,"text":"~HS"}`)
	noOriginRequest := httptest.NewRequest(
		http.MethodPost,
		gatewayURL+"/v1/tcp/exchange",
		bytes.NewReader(protectedBody),
	)
	noOriginRequest.Header.Set("Content-Type", "application/json")
	noOriginResponse := httptest.NewRecorder()
	server.ServeHTTP(noOriginResponse, noOriginRequest)
	if noOriginResponse.Code != http.StatusForbidden {
		t.Fatalf("site request without Origin status = %d, want 403", noOriginResponse.Code)
	}

	pairing.mu.Lock()
	pairing.code = "12345678"
	pairing.expires = time.Now().Add(time.Minute)
	pairing.mu.Unlock()
	pairBody := []byte(`{"code":"12345678","origin":"https://print.example.com"}`)
	nativePairRequest := httptest.NewRequest(
		http.MethodPost,
		gatewayURL+"/v1/pair",
		bytes.NewReader(pairBody),
	)
	nativePairRequest.Header.Set("Content-Type", "application/json")
	nativePairResponse := httptest.NewRecorder()
	server.ServeHTTP(nativePairResponse, nativePairRequest)
	if nativePairResponse.Code != http.StatusForbidden {
		t.Fatalf("site pairing without Origin status = %d, want 403", nativePairResponse.Code)
	}

	httpOriginRequest := httptest.NewRequest(
		http.MethodPost,
		gatewayURL+"/v1/pair",
		bytes.NewReader([]byte(`{"code":"12345678"}`)),
	)
	httpOriginRequest.Header.Set("Content-Type", "application/json")
	httpOriginRequest.Header.Set("Origin", "http://localhost:3000")
	httpOriginResponse := httptest.NewRecorder()
	server.ServeHTTP(httpOriginResponse, httpOriginRequest)
	if httpOriginResponse.Code != http.StatusForbidden {
		t.Fatalf("site pairing from HTTP Origin status = %d, want 403", httpOriginResponse.Code)
	}

	pairRequest := httptest.NewRequest(
		http.MethodPost,
		gatewayURL+"/v1/pair",
		bytes.NewReader([]byte(`{"code":"12345678"}`)),
	)
	pairRequest.Header.Set("Content-Type", "application/json")
	pairRequest.Header.Set("Origin", cloudOrigin)
	pairResponse := httptest.NewRecorder()
	server.ServeHTTP(pairResponse, pairRequest)
	if pairResponse.Code != http.StatusOK {
		t.Fatalf("site HTTPS pairing status = %d, body=%s", pairResponse.Code, pairResponse.Body)
	}
	var pairResult struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(pairResponse.Body.Bytes(), &pairResult); err != nil || pairResult.Token == "" {
		t.Fatalf("site pair response token is missing: %v", err)
	}

	authorizedRequest := httptest.NewRequest(
		http.MethodPost,
		gatewayURL+"/v1/tcp/exchange",
		bytes.NewReader(protectedBody),
	)
	authorizedRequest.Header.Set("Content-Type", "application/json")
	authorizedRequest.Header.Set("Origin", cloudOrigin)
	authorizedRequest.Header.Set("Authorization", "Bearer "+pairResult.Token)
	authorizedResponse := httptest.NewRecorder()
	server.ServeHTTP(authorizedResponse, authorizedRequest)
	if authorizedResponse.Code != http.StatusForbidden {
		t.Fatalf(
			"authorized site request status = %d, want TCP public-IP rejection 403; body=%s",
			authorizedResponse.Code,
			authorizedResponse.Body,
		)
	}
}

func TestExplicitStrictLoopbackMode(t *testing.T) {
	t.Parallel()
	server, pairing := testServerConfigured(t, "127.0.0.1", true)
	const (
		connectorURL = "http://127.0.0.1:17917"
		origin       = "https://localhost:3000"
	)

	healthRequest := httptest.NewRequest(http.MethodGet, connectorURL+"/v1/health", nil)
	healthResponse := httptest.NewRecorder()
	server.ServeHTTP(healthResponse, healthRequest)
	var health struct {
		SiteMode           bool `json:"siteMode"`
		RequireOriginToken bool `json:"requireOriginToken"`
	}
	if err := json.Unmarshal(healthResponse.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	if healthResponse.Code != http.StatusOK || health.SiteMode || !health.RequireOriginToken {
		t.Fatalf("unexpected strict-loopback health: status=%d health=%+v", healthResponse.Code, health)
	}

	protectedBody := []byte(`{"host":"8.8.8.8","port":9100,"text":"~HS"}`)
	noOriginRequest := httptest.NewRequest(
		http.MethodPost,
		connectorURL+"/v1/tcp/exchange",
		bytes.NewReader(protectedBody),
	)
	noOriginRequest.Header.Set("Content-Type", "application/json")
	noOriginResponse := httptest.NewRecorder()
	server.ServeHTTP(noOriginResponse, noOriginRequest)
	if noOriginResponse.Code != http.StatusForbidden {
		t.Fatalf("strict loopback request without Origin status = %d, want 403", noOriginResponse.Code)
	}

	localPreflight := httptest.NewRequest(
		http.MethodOptions,
		connectorURL+"/v1/tcp/exchange",
		nil,
	)
	localPreflight.Header.Set("Origin", origin)
	localPreflight.Header.Set("Access-Control-Request-Method", "POST")
	localPreflight.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
	localPreflightResponse := httptest.NewRecorder()
	server.ServeHTTP(localPreflightResponse, localPreflight)
	if localPreflightResponse.Code != http.StatusForbidden {
		t.Fatalf(
			"unpaired localhost Origin preflight status = %d, want 403",
			localPreflightResponse.Code,
		)
	}

	pairing.mu.Lock()
	pairing.code = "12345678"
	pairing.expires = time.Now().Add(time.Minute)
	pairing.mu.Unlock()

	noOriginPairRequest := httptest.NewRequest(
		http.MethodPost,
		connectorURL+"/v1/pair",
		bytes.NewReader([]byte(`{"code":"12345678","origin":"https://localhost:3000"}`)),
	)
	noOriginPairRequest.Header.Set("Content-Type", "application/json")
	noOriginPairResponse := httptest.NewRecorder()
	server.ServeHTTP(noOriginPairResponse, noOriginPairRequest)
	if noOriginPairResponse.Code != http.StatusForbidden {
		t.Fatalf("strict loopback pair without Origin status = %d, want 403", noOriginPairResponse.Code)
	}

	httpPairRequest := httptest.NewRequest(
		http.MethodPost,
		connectorURL+"/v1/pair",
		bytes.NewReader([]byte(`{"code":"12345678"}`)),
	)
	httpPairRequest.Header.Set("Content-Type", "application/json")
	httpPairRequest.Header.Set("Origin", "http://localhost:3000")
	httpPairResponse := httptest.NewRecorder()
	server.ServeHTTP(httpPairResponse, httpPairRequest)
	if httpPairResponse.Code != http.StatusForbidden {
		t.Fatalf("strict loopback HTTP-Origin pair status = %d, want 403", httpPairResponse.Code)
	}

	pairRequest := httptest.NewRequest(
		http.MethodPost,
		connectorURL+"/v1/pair",
		bytes.NewReader([]byte(`{"code":"12345678"}`)),
	)
	pairRequest.Header.Set("Content-Type", "application/json")
	pairRequest.Header.Set("Origin", origin)
	pairResponse := httptest.NewRecorder()
	server.ServeHTTP(pairResponse, pairRequest)
	if pairResponse.Code != http.StatusOK {
		t.Fatalf("strict loopback HTTPS-Origin pair status = %d, body=%s", pairResponse.Code, pairResponse.Body)
	}
	var pairResult struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(pairResponse.Body.Bytes(), &pairResult); err != nil || pairResult.Token == "" {
		t.Fatalf("strict loopback pair response token is missing: %v", err)
	}

	withoutTokenRequest := httptest.NewRequest(
		http.MethodPost,
		connectorURL+"/v1/tcp/exchange",
		bytes.NewReader(protectedBody),
	)
	withoutTokenRequest.Header.Set("Content-Type", "application/json")
	withoutTokenRequest.Header.Set("Origin", origin)
	withoutTokenResponse := httptest.NewRecorder()
	server.ServeHTTP(withoutTokenResponse, withoutTokenRequest)
	if withoutTokenResponse.Code != http.StatusUnauthorized {
		t.Fatalf("paired localhost Origin without token status = %d, want 401", withoutTokenResponse.Code)
	}

	withTokenRequest := httptest.NewRequest(
		http.MethodPost,
		connectorURL+"/v1/tcp/exchange",
		bytes.NewReader(protectedBody),
	)
	withTokenRequest.Header.Set("Content-Type", "application/json")
	withTokenRequest.Header.Set("Origin", origin)
	withTokenRequest.Header.Set("Authorization", "Bearer "+pairResult.Token)
	withTokenResponse := httptest.NewRecorder()
	server.ServeHTTP(withTokenResponse, withTokenRequest)
	if withTokenResponse.Code != http.StatusForbidden {
		t.Fatalf(
			"strict loopback authenticated request status = %d, want TCP public-IP rejection 403; body=%s",
			withTokenResponse.Code,
			withTokenResponse.Body,
		)
	}
}

func TestSiteModeRejectsMismatchedHost(t *testing.T) {
	t.Parallel()
	server, _ := testServerAt(t, "192.168.50.10")
	request := httptest.NewRequest(http.MethodGet, "http://192.168.50.11:17917/v1/health", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", response.Code)
	}
}

func TestCORSUsesExactOriginAndPNAHeader(t *testing.T) {
	t.Parallel()
	server, _ := testServer(t)
	request := httptest.NewRequest(http.MethodOptions, "http://127.0.0.1:17917/v1/tcp/exchange", nil)
	request.Header.Set("Origin", "http://localhost:3000")
	request.Header.Set("Access-Control-Request-Method", "POST")
	request.Header.Set("Access-Control-Request-Headers", "content-type")
	request.Header.Set("Access-Control-Request-Private-Network", "true")
	response := httptest.NewRecorder()

	server.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body=%s", response.Code, response.Body)
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("allow-origin = %q", got)
	}
	if got := response.Header().Get("Access-Control-Allow-Private-Network"); got != "true" {
		t.Fatalf("allow-private-network = %q", got)
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got == "*" {
		t.Fatal("wildcard CORS must never be used")
	}
	healthRequest := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:17917/v1/health", nil)
	healthResponse := httptest.NewRecorder()
	server.ServeHTTP(healthResponse, healthRequest)
	var health struct {
		RequireOriginToken bool `json:"requireOriginToken"`
	}
	if err := json.Unmarshal(healthResponse.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	if health.RequireOriginToken {
		t.Fatal("legacy loopback mode unexpectedly requires Origin/token")
	}
}

func TestCloudOriginMustPairBeforeProtectedPreflight(t *testing.T) {
	t.Parallel()
	server, pairing := testServer(t)
	const origin = "https://print.example.com"

	preflight := httptest.NewRequest(http.MethodOptions, "http://127.0.0.1:17917/v1/tcp/exchange", nil)
	preflight.Header.Set("Origin", origin)
	preflight.Header.Set("Access-Control-Request-Method", "POST")
	preflight.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
	before := httptest.NewRecorder()
	server.ServeHTTP(before, preflight)
	if before.Code != http.StatusForbidden {
		t.Fatalf("unpaired preflight status = %d, want 403", before.Code)
	}

	pairing.mu.Lock()
	pairing.code = "12345678"
	pairing.expires = time.Now().Add(time.Minute)
	pairing.mu.Unlock()
	pairBody, _ := json.Marshal(map[string]string{"code": "12345678"})
	pairRequest := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:17917/v1/pair", bytes.NewReader(pairBody))
	pairRequest.Header.Set("Origin", origin)
	pairRequest.Header.Set("Content-Type", "application/json")
	pairResponse := httptest.NewRecorder()
	server.ServeHTTP(pairResponse, pairRequest)
	if pairResponse.Code != http.StatusOK {
		t.Fatalf("pair status = %d, body=%s", pairResponse.Code, pairResponse.Body)
	}

	afterRequest := httptest.NewRequest(http.MethodOptions, "http://127.0.0.1:17917/v1/tcp/exchange", nil)
	afterRequest.Header = preflight.Header.Clone()
	after := httptest.NewRecorder()
	server.ServeHTTP(after, afterRequest)
	if after.Code != http.StatusNoContent {
		t.Fatalf("paired preflight status = %d, want 204; body=%s", after.Code, after.Body)
	}
	if after.Header().Get("Access-Control-Allow-Origin") != origin {
		t.Fatal("paired preflight did not return exact origin")
	}

	var pairResult struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(pairResponse.Body.Bytes(), &pairResult); err != nil || pairResult.Token == "" {
		t.Fatalf("pair response token is missing: %v", err)
	}
	protectedBody := []byte(`{"host":"8.8.8.8","port":9100,"text":"~HS"}`)
	withoutTokenRequest := httptest.NewRequest(
		http.MethodPost,
		"http://127.0.0.1:17917/v1/tcp/exchange",
		bytes.NewReader(protectedBody),
	)
	withoutTokenRequest.Header.Set("Origin", origin)
	withoutTokenRequest.Header.Set("Content-Type", "application/json")
	withoutToken := httptest.NewRecorder()
	server.ServeHTTP(withoutToken, withoutTokenRequest)
	if withoutToken.Code != http.StatusUnauthorized {
		t.Fatalf("tokenless request status = %d, want 401", withoutToken.Code)
	}
	if withoutToken.Header().Get("Access-Control-Allow-Origin") != origin {
		t.Fatal("tokenless response omitted exact paired CORS origin")
	}

	withTokenRequest := httptest.NewRequest(
		http.MethodPost,
		"http://127.0.0.1:17917/v1/tcp/exchange",
		bytes.NewReader(protectedBody),
	)
	withTokenRequest.Header.Set("Origin", origin)
	withTokenRequest.Header.Set("Content-Type", "application/json")
	withTokenRequest.Header.Set("Authorization", "Bearer "+pairResult.Token)
	withToken := httptest.NewRecorder()
	server.ServeHTTP(withToken, withTokenRequest)
	if withToken.Code != http.StatusForbidden {
		t.Fatalf("authenticated public-IP request status = %d, want 403; body=%s", withToken.Code, withToken.Body)
	}
}

func TestHostHeaderRejectsDNSRebindingName(t *testing.T) {
	t.Parallel()
	server, _ := testServer(t)
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:17917/v1/health", nil)
	request.Host = "attacker.example:17917"
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", response.Code)
	}
}
