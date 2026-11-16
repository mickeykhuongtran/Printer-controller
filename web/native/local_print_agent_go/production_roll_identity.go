package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
)

func productionOperationMode(mode string) string {
	if mode == "" {
		return "read"
	}
	return mode
}

func productionEndpointHost(host string) string {
	host = strings.Trim(strings.TrimSpace(host), "[]")
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}
	return strings.TrimSuffix(strings.ToLower(host), ".")
}

// New label jobs must not bypass an unfinished roll by omitting capture. Status
// and printer controls use separate existing operations and are unaffected.
func validateProductionJobIdentity(root, owner, host string, port int, capture *rfidCaptureOptions) error {
	if root == "" {
		return nil
	}
	productionRollMu.Lock()
	defer productionRollMu.Unlock()
	return validateProductionJobIdentityLocked(root, owner, host, port, capture)
}

// Also called while registering the first run so concurrently prepared drafts
// cannot both acquire the same physical printer between preflight and append.
func validateProductionJobIdentityLocked(root, owner, host string, port int, capture *rfidCaptureOptions) error {
	if root == "" {
		return nil
	}
	if capture != nil && capture.ProductionRollID != "" {
		roll, err := readProductionRoll(root, owner, capture.ProductionRollID)
		if err != nil {
			return err
		}
		if roll.State != "open" {
			return productionError("The selected roll is closed. Start a new roll; no print data was sent.")
		}
	}
	entries, err := os.ReadDir(filepath.Join(root, "production-rolls"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, "production-rolls", entry.Name(), "roll.json"))
		if err != nil {
			return err
		}
		var manifest productionRollManifest
		if json.Unmarshal(data, &manifest) != nil {
			return productionError("A saved roll identity is unreadable; recover it before starting another job.")
		}
		roll := manifest.Roll
		if roll.State == "open" && len(roll.Runs) > 0 && productionEndpointHost(roll.PrinterHost) == productionEndpointHost(host) && roll.PrinterPort == port {
			if manifest.Owner != owner {
				return productionError("Print data was not sent: this printer has an open roll in another session. Close that roll or explicitly resume it before starting a new lot. CSV export is optional.")
			}
			if capture == nil || capture.ProductionRollID != roll.RollID {
				return productionError("Print data was not sent: an earlier roll is still open for this printer. Explicitly resume it or close it before starting a new lot. History is preserved and CSV can be exported later.")
			}
		}
	}
	return nil
}

// Roll identity is enforced before any new label data is accepted. Legacy
// evidence stays exportable; migration checks every known prior identity and
// explicitly retains the limits of evidence produced by older connectors.
func bindProductionIdentity(root, owner string, roll *productionRoll, p productionRollRequest, requireComplete bool) error {
	p.PrinterHost = productionEndpointHost(p.PrinterHost)
	p.TemplateFingerprint = strings.ToLower(p.TemplateFingerprint)
	if p.OperationMode != "" && p.OperationMode != "read" && p.OperationMode != "write" && p.OperationMode != "read_write" {
		return badRequest("Invalid production operation mode.")
	}
	if p.Bank != "" && p.Bank != "EPC" && p.Bank != "TID" {
		return badRequest("Invalid production RFID bank.")
	}
	if p.TemplateFingerprint != "" && !validProductionFingerprint(p.TemplateFingerprint) {
		return badRequest("Invalid production template fingerprint.")
	}
	if p.PrinterHost != "" && (p.PrinterPort < 1 || p.PrinterPort > 65535) {
		return badRequest("Invalid production printer endpoint.")
	}
	if requireComplete {
		p.OperationMode = productionOperationMode(p.OperationMode)
		if p.PrinterHost == "" || p.TemplateFingerprint == "" || p.Bank == "" {
			return badRequest("The printer endpoint, actual template fingerprint, operation mode and bank are required before printing.")
		}
	}
	if p.OperationMode != "" && p.OperationMode != "read" && p.Bank != "EPC" {
		return badRequest("Write verification requires the EPC bank.")
	}
	conflict := func() error {
		return productionError("This open roll belongs to a different printer, template or RFID mode. Resume its original configuration or close it before starting a new roll.")
	}
	check := func(host string, port int, fingerprint, mode, bank string) error {
		if host != "" && p.PrinterHost != "" && (productionEndpointHost(host) != p.PrinterHost || port != p.PrinterPort) {
			return conflict()
		}
		if fingerprint != "" && p.TemplateFingerprint != "" && strings.ToLower(fingerprint) != p.TemplateFingerprint && !p.AllowTemplateRevision {
			return conflict()
		}
		if mode != "" && p.OperationMode != "" && mode != p.OperationMode {
			return conflict()
		}
		if bank != "" && p.Bank != "" && bank != p.Bank {
			return conflict()
		}
		return nil
	}
	if len(roll.Runs) > 0 {
		if err := check(roll.PrinterHost, roll.PrinterPort, roll.TemplateFingerprint, roll.OperationMode, roll.Bank); err != nil {
			return err
		}
	} else {
		// Preparing a job or failing to connect is not a printed roll. Permit
		// correcting that empty draft without forcing an impossible empty export.
		roll.IdentityProvenance, roll.IdentityWarnings = "", nil
	}
	if len(roll.Runs) > 0 && roll.IdentityProvenance == "" && p.PrinterHost != "" && p.TemplateFingerprint != "" && p.OperationMode != "" && p.Bank != "" {
		// Older clients sometimes repeated the first template hash in later runs.
		// Matching stored hashes permits continuity but cannot retroactively prove
		// that every historical payload used that template.
		for _, run := range roll.Runs {
			data, err := os.ReadFile(filepath.Join(captureDirectory(root, owner, run.RunID), "manifest.json"))
			if err != nil {
				return productionError("Earlier run identity is unavailable. Close the saved roll before starting a new lot; its history is retained.")
			}
			var manifest rfidCaptureManifest
			if json.Unmarshal(data, &manifest) != nil || manifest.Owner != owner || manifest.Summary.JobID != run.RunID {
				return productionError("Earlier run identity is invalid; no new print data was accepted.")
			}
			s := manifest.Summary
			if err := check(s.Host, s.Port, s.Options.TemplateFingerprint, s.Options.OperationMode, s.Options.Bank); err != nil {
				return err
			}
		}
		roll.IdentityProvenance = "legacy_unverified"
		roll.IdentityWarnings = []string{"Earlier runs were created by a legacy connector; stored identity matches, but historical template/mode verification is incomplete."}
	}
	if p.PrinterHost != "" {
		roll.PrinterHost, roll.PrinterPort = p.PrinterHost, p.PrinterPort
	}
	if p.TemplateFingerprint != "" && len(roll.Runs) == 0 {
		roll.TemplateFingerprint = p.TemplateFingerprint
	}
	if p.TemplateName != "" && len(roll.Runs) == 0 {
		roll.TemplateName = p.TemplateName
	}
	if p.OperationMode != "" {
		roll.OperationMode = p.OperationMode
	}
	if p.Bank != "" {
		roll.Bank = p.Bank
	}
	if roll.IdentityProvenance == "" && roll.PrinterHost != "" && roll.TemplateFingerprint != "" && roll.OperationMode != "" && roll.Bank != "" {
		roll.IdentityProvenance = "verified"
	}
	return nil
}
