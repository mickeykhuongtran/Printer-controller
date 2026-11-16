package main

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

func (c *rfidCapture) recordDiagnosticLocked(raw, reason string) {
	data, err := json.Marshal(map[string]any{"record": c.summary.Received, "at": time.Now().UTC().Format(time.RFC3339Nano), "reason": reason, "frameHex": hex.EncodeToString([]byte(raw))})
	if err != nil {
		c.failLocked(err)
		return
	}
	c.diagnosticBuffer = append(c.diagnosticBuffer, append(data, '\n')...)
	c.dirty = true
}

// Sync once per received packet, rather than once per RFID row. A coalesced
// TCP burst may contain hundreds of rows; the durability boundary remains the
// end of feed(), and every counter/manifest checkpoint flushes evidence first.
func (c *rfidCapture) flushEvidenceLocked() error {
	if !c.dirty {
		return nil
	}
	if c.csv != nil {
		c.csv.Flush()
		if err := c.csv.Error(); err != nil {
			return err
		}
	}
	if c.file != nil {
		if err := c.file.Sync(); err != nil {
			return err
		}
	}
	if len(c.diagnosticBuffer) > 0 {
		f, err := os.OpenFile(filepath.Join(c.dir, "feedback-errors.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		_, err = f.Write(c.diagnosticBuffer)
		if err == nil {
			err = f.Sync()
		}
		closed := f.Close()
		if err != nil {
			return err
		}
		if closed != nil {
			return closed
		}
		c.diagnosticBuffer = nil
	}
	c.dirty = false
	return nil
}
