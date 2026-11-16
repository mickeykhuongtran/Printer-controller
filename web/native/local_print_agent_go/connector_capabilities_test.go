package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthAdvertisesProductionAndFaultSafetyCapabilities(t *testing.T) {
	server, _ := testServer(t)
	defer server.tcpJobs.close()
	for _, configured := range []bool{true, false} {
		if !configured {
			server.tcpJobs.captureDir = ""
		}
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://127.0.0.1:17917/v1/health", nil))
		var health struct {
			Version      string          `json:"version"`
			Capabilities map[string]bool `json:"capabilities"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &health); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusOK || health.Version != "0.12.2" {
			t.Fatalf("%d %+v", response.Code, health)
		}
		if !health.Capabilities["tcpServiceFaultLatchV1"] || !health.Capabilities["tcpBackgroundMonitorV1"] {
			t.Fatal("service fault latch is not advertised")
		}
		for _, name := range []string{"fleetStreamingV1", "fleetFlowControlV1", "fleetSpoolV1", "productionRowNotesV1", "productionRevisionsV1", "rfidCaptureV1", "rfidBatchAuditV1", "productionRollV1", "productionRollLifecycleV1", "productionRollHistoryV1", "connectorCounterLifecycleV1", "productionRollIdentityV2", "productionRollCountsV2", "rfidWriteVerifyV1", "productionRemovalAccountingV2", "tcpFaultCounterReconciliationV1"} {
			if health.Capabilities[name] != configured {
				t.Fatalf("%s configured=%t, got=%t", name, configured, health.Capabilities[name])
			}
		}
	}
}
