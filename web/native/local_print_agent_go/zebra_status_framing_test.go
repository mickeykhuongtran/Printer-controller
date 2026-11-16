package main

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestZebraStatusFraming(t *testing.T) {
	hs := "\x02000,0,0,0251,000,0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,1,2,6,0,00000000,1,001\x03\r\n\x021234,1\x03\r\n"
	for n := 0; n < len(hs); n++ {
		if completeZebraStatusResponse("~HS\r\n", hs[:n]) {
			t.Fatalf("early completion at byte %d", n)
		}
	}
	if !completeZebraStatusResponse("~HS", hs) {
		t.Fatal("complete HS rejected")
	}
	if !completeZebraStatusResponse("~HQES", "\x02\r\nPRINTER STATUS\r\n\x03") {
		t.Fatal("complete HQES rejected")
	}
	for _, bad := range []string{hs + "garbage", hs + hs, "garbage" + hs, "\x02\x02\x03\r\n"} {
		if completeZebraStatusResponse("~HS", bad) {
			t.Fatal("invalid framing accepted")
		}
	}
	if completeZebraStatusResponse("! U1 getvar status", hs) {
		t.Fatal("legacy response must keep idle fallback")
	}
}

func TestTCPJobFramedQueriesReturnBeforeIdleOnSameSocket(t *testing.T) {
	const response = "\x02000,0,0,0251,000,0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,1,2,6,0,00000000,1,001\x03\r\n\x021234,1\x03\r\n"
	dials := 0
	manager := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
		dials++
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			for i := 0; i < 2; i++ {
				command := make([]byte, len("~HS\r\n"))
				if _, err := io.ReadFull(server, command); err != nil {
					return
				}
				// Separate writes exercise TCP fragmentation, including CR/LF.
				for _, b := range []byte(response) {
					if _, err := server.Write([]byte{b}); err != nil {
						return
					}
				}
			}
			_, _ = io.Copy(io.Discard, server)
		}()
		return client, "192.168.50.50", nil
	})
	defer manager.close()
	if _, err := manager.open(context.Background(), "owner", "framing", "192.168.50.50", 9100, time.Second, time.Second, time.Minute); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	for i := 0; i < 2; i++ {
		result, err := manager.queryContext(context.Background(), "owner", "framing", []byte("~HS\r\n"), 5*time.Second, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if result.Response != response || result.NextSequence != 1 || result.CumulativeBytes != 0 {
			t.Fatalf("bad response/checkpoint: %+v", result)
		}
	}
	if time.Since(started) >= time.Second {
		t.Fatal("framed status still waits for read-idle timeout")
	}
	if dials != 1 {
		t.Fatal("status queries opened extra sockets")
	}
}
