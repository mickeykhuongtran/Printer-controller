package main

// A roll is a durable collection of print runs. Closing ends its logical
// association with a production lot; exporting is a separate immutable snapshot.
import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var productionRollMu sync.Mutex
var productionProcessStartedAt = time.Now()

type productionRollRequest struct {
	RecordIDs               []string `json:"recordIds"`
	NoteID                  string   `json:"noteId"`
	Incident                bool     `json:"incident"`
	AllowTemplateRevision   bool     `json:"allowTemplateRevision"`
	RollIDs                 []string `json:"rollIds"`
	JobID                   string   `json:"jobId"`
	RollID                  string   `json:"rollId"`
	RollNumber              int      `json:"rollNumber"`
	TargetLabels            int      `json:"targetLabels"`
	Operator                string   `json:"operator"`
	ClosedBy                string   `json:"closedBy"`
	TemplateName            string   `json:"templateName"`
	TemplateFingerprint     string   `json:"templateFingerprint"`
	PrinterHost             string   `json:"printerHost"`
	PrinterPort             int      `json:"printerPort"`
	OperationMode           string   `json:"operationMode"`
	Bank                    string   `json:"bank"`
	RemovedValidCount       *int64   `json:"removedValidCount,omitempty"`
	RemovedGoodCount        *int64   `json:"removedGoodCount,omitempty"`
	RemovedRejectedCount    *int64   `json:"removedRejectedCount,omitempty"`
	MaterialLot             string   `json:"materialLot"`
	Kind                    string   `json:"kind"`
	Reference               string   `json:"reference"`
	RunID                   string   `json:"runId"`
	Note                    string   `json:"note"`
	Verified                bool     `json:"verified"`
	ExcludedOrdinals        []int    `json:"excludedOrdinals"`
	Confirmed               bool     `json:"confirmed"`
	PhysicalGoodCount       int      `json:"physicalGoodCount"`
	Orientation             string   `json:"orientation"`
	Provisional             bool     `json:"provisional"`
	RequireUniqueSourceRows bool     `json:"requireUniqueSourceRows"`
	CountersResetConfirmed  bool     `json:"countersResetConfirmed"`
	PrinterValidCount       *int64   `json:"printerValidCount"`
	PrinterVoidCount        *int64   `json:"printerVoidCount"`
	RetainedVoidCount       *int64   `json:"retainedVoidCount"`
	ExternalTestVoidCount   int64    `json:"externalTestVoidCount"`
	QCMethod                string   `json:"qcMethod"`
}

type productionRunReview struct {
	RunID            string `json:"runId"`
	Verified         bool   `json:"verified"`
	Operator         string `json:"operator"`
	Note             string `json:"note"`
	ExcludedOrdinals []int  `json:"excludedOrdinals"`
	EvidenceSHA256   string `json:"evidenceSha256"`
	At               string `json:"at"`
}
type productionRun struct {
	TemplateFingerprint   string               `json:"templateFingerprint,omitempty"`
	ConfigurationRevision int                  `json:"configurationRevision,omitempty"`
	RunID                 string               `json:"runId"`
	Operator              string               `json:"operator"`
	SourceRollID          string               `json:"sourceRollId"`
	MaterialLot           string               `json:"materialLot"`
	RegisteredAt          string               `json:"registeredAt"`
	Review                *productionRunReview `json:"review,omitempty"`
}
type productionQuantityAdjustment struct {
	Previous          int64  `json:"previous"`
	Count             int64  `json:"count"`
	At                string `json:"at"`
	PreviousGood      int64  `json:"previousGood"`
	Good              int64  `json:"good"`
	PreviousRejected  int64  `json:"previousRejected"`
	Rejected          int64  `json:"rejected"`
	AccountingVersion int    `json:"accountingVersion,omitempty"`
}
type productionRowNote struct {
	ID        string   `json:"id"`
	RecordIDs []string `json:"recordIds"`
	Text      string   `json:"text"`
	At        string   `json:"at"`
	Incident  bool     `json:"incident"`
}
type productionRoll struct {
	Notes                    []productionRowNote            `json:"notes,omitempty"`
	HistoryClearedAt         string                         `json:"historyClearedAt,omitempty"`
	JobID                    string                         `json:"jobId"`
	RollID                   string                         `json:"rollId"`
	RollNumber               int                            `json:"rollNumber"`
	TargetLabels             int                            `json:"targetLabels"`
	Operator                 string                         `json:"operator"`
	TemplateName             string                         `json:"templateName"`
	TemplateFingerprint      string                         `json:"templateFingerprint"`
	MaterialLot              string                         `json:"materialLot"`
	Kind                     string                         `json:"kind"`
	Reference                string                         `json:"reference"`
	RequireUniqueSourceRows  bool                           `json:"requireUniqueSourceRows"`
	CreatedAt                string                         `json:"createdAt"`
	State                    string                         `json:"state"`
	Revision                 int                            `json:"revision"`
	Runs                     []productionRun                `json:"runs"`
	Reviews                  []productionRunReview          `json:"reviews"`
	ClosedAt                 string                         `json:"closedAt,omitempty"`
	ClosedBy                 string                         `json:"closedBy,omitempty"`
	CloseWarnings            []string                       `json:"closeWarnings,omitempty"`
	ExportedAt               string                         `json:"exportedAt,omitempty"`
	ExportedBy               string                         `json:"exportedBy,omitempty"`
	FinalizedAt              string                         `json:"finalizedAt,omitempty"`
	FinalizedBy              string                         `json:"finalizedBy,omitempty"`
	PhysicalGoodCount        int                            `json:"physicalGoodCount,omitempty"`
	Orientation              string                         `json:"orientation,omitempty"`
	CloseNote                string                         `json:"closeNote,omitempty"`
	ExportFileName           string                         `json:"exportFileName,omitempty"`
	CountersResetConfirmed   bool                           `json:"countersResetConfirmed"`
	PrinterValidCount        *int64                         `json:"printerValidCount,omitempty"`
	PrinterVoidCount         *int64                         `json:"printerVoidCount,omitempty"`
	RetainedVoidCount        *int64                         `json:"retainedVoidCount,omitempty"`
	ExternalTestVoidCount    int64                          `json:"externalTestVoidCount"`
	SourcePlanFirstRow       int                            `json:"sourcePlanFirstRow,omitempty"`
	SourcePlanRowStep        int                            `json:"sourcePlanRowStep,omitempty"`
	QCMethod                 string                         `json:"qcMethod,omitempty"`
	CounterProvenance        string                         `json:"counterProvenance,omitempty"`
	PrinterHost              string                         `json:"printerHost,omitempty"`
	PrinterPort              int                            `json:"printerPort,omitempty"`
	OperationMode            string                         `json:"operationMode,omitempty"`
	Bank                     string                         `json:"bank,omitempty"`
	IdentityProvenance       string                         `json:"identityProvenance,omitempty"`
	IdentityWarnings         []string                       `json:"identityWarnings,omitempty"`
	RemovedValidCount        int64                          `json:"removedValidCount"`
	RemovedGoodCount         int64                          `json:"removedGoodCount"`
	RemovedRejectedCount     int64                          `json:"removedRejectedCount"`
	RemovalAccountingVersion int                            `json:"removalAccountingVersion"`
	RemovalReviewRequired    bool                           `json:"removalReviewRequired"`
	RemovalAdjustments       []productionQuantityAdjustment `json:"removalAdjustments,omitempty"`
}
type productionRollManifest struct {
	Owner string         `json:"owner"`
	Roll  productionRoll `json:"roll"`
}

func productionError(message string) error {
	return &apiError{Status: 409, Code: "PRODUCTION_ROLL_CONFLICT", Message: message}
}

// Only use at admission/registration sites that have sent no socket bytes.
// A general roll conflict can also occur during reporting and must not imply
// that an earlier physical print has a known outcome.
func productionAdmissionError(err error) error {
	if err == nil {
		return nil
	}
	var apiErr *apiError
	if !errors.As(err, &apiErr) {
		return err
	}
	copy := *apiErr
	copy.Stage, copy.Outcome, copy.RetrySafety = "admission", "not_sent", "safe"
	copy.BytesWritten, copy.WriteStarted, copy.WriteCompleted = 0, false, false
	copy.CheckpointState = "not_committed"
	return &copy
}

func validProductionFingerprint(value string) bool {
	b, err := hex.DecodeString(value)
	return err == nil && len(b) == 32
}
func productionDirectory(root, owner, rollID string) string {
	digest := sha256.Sum256([]byte(owner + "\x00" + rollID))
	return filepath.Join(root, "production-rolls", hex.EncodeToString(digest[:]))
}
func readProductionRoll(root, owner, id string) (productionRoll, error) {
	raw, err := os.ReadFile(filepath.Join(productionDirectory(root, owner, id), "roll.json"))
	if err != nil {
		return productionRoll{}, &apiError{Status: 404, Code: "PRODUCTION_ROLL_NOT_FOUND", Message: "Production roll not found."}
	}
	var m productionRollManifest
	if json.Unmarshal(raw, &m) != nil || m.Owner != owner || m.Roll.RollID != id {
		return productionRoll{}, forbidden("Production roll owner or identity mismatch.")
	}
	normalizeProductionRemovals(&m.Roll)
	return m.Roll, nil
}

// Old read-only removals have one meaning. A nonzero legacy write removal
// does not reveal whether it was already rejected by verification, so retain
// its original total until the operator explicitly classifies the two counts.
func normalizeProductionRemovals(roll *productionRoll) {
	if roll.State != "open" || roll.RemovalAccountingVersion >= 2 {
		return
	}
	if roll.OperationMode != "read" && roll.RemovedValidCount > 0 {
		roll.RemovalReviewRequired = true
		return
	}
	roll.RemovedGoodCount = roll.RemovedValidCount
	roll.RemovedRejectedCount = 0
	roll.RemovalAccountingVersion = 2
	roll.RemovalReviewRequired = false
}
func saveProductionRoll(root, owner string, roll productionRoll) error {
	dir := productionDirectory(root, owner, roll.RollID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(productionRollManifest{Owner: owner, Roll: roll}, "", "  ")
	if err != nil {
		return err
	}
	return writeRawSpoolAtomic(filepath.Join(dir, "roll.json"), b)
}
func validateProductionText(p *productionRollRequest) error {
	p.Operator = strings.TrimSpace(p.Operator)
	p.Note = strings.TrimSpace(p.Note)
	p.ClosedBy = strings.TrimSpace(p.ClosedBy)
	if len(p.ClosedBy) > 128 || len(p.Operator) > 128 || len(p.Note) > 4096 || len(p.MaterialLot) > 128 || len(p.TemplateName) > 512 || len(p.Reference) > 256 || len(p.ExcludedOrdinals) > 100000 {
		return badRequest("Production metadata is too long.")
	}
	return nil
}

// Called before the socket accepts label bytes. Registration and close share
// one lock, so a closed roll can never acquire a late unrecorded run.
func registerProductionRun(root, owner, runID, host string, port int, options rfidCaptureOptions) error {
	productionRollMu.Lock()
	defer productionRollMu.Unlock()
	if err := validateProductionJobIdentityLocked(root, owner, host, port, &options); err != nil {
		return err
	}
	roll, err := readProductionRoll(root, owner, options.ProductionRollID)
	if err != nil {
		return err
	}
	if roll.State != "open" {
		return productionError("This roll is closed. Start a new roll; closed history cannot accept another print run.")
	}
	for _, run := range roll.Runs {
		if run.RunID == runID {
			return productionError("This print run is already recorded; do not replay print data.")
		}
	}
	// No review, target-count, source-roll, operator or counter-reset gate belongs
	// here. The operator may print any replacement quantity after servicing.
	if err := bindProductionIdentity(root, owner, &roll, productionRollRequest{PrinterHost: host, PrinterPort: port, TemplateFingerprint: options.TemplateFingerprint, TemplateName: options.TemplateName, OperationMode: options.OperationMode, Bank: options.Bank, AllowTemplateRevision: options.AllowTemplateRevision}, true); err != nil {
		return err
	}
	roll.Runs = append(roll.Runs, productionRun{TemplateFingerprint: options.TemplateFingerprint, ConfigurationRevision: len(roll.Runs) + 1, RunID: runID, Operator: options.Operator, SourceRollID: options.SourceRollID, MaterialLot: options.MaterialLot, RegisteredAt: time.Now().UTC().Format(time.RFC3339Nano)})
	roll.Revision++
	return saveProductionRoll(root, owner, roll)
}

func listProductionRolls(root, owner string) ([]productionRoll, error) {
	rolls := []productionRoll{}
	entries, err := os.ReadDir(filepath.Join(root, "production-rolls"))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(root, "production-rolls", entry.Name(), "roll.json"))
		if err != nil {
			return nil, err
		}
		var manifest productionRollManifest
		if json.Unmarshal(b, &manifest) != nil {
			return nil, productionError("A stored roll manifest is unreadable; recover it before creating a replacement.")
		}
		if manifest.Owner == owner {
			normalizeProductionRemovals(&manifest.Roll)
			manifest.Roll.HistoryClearedAt, err = readProductionHistoryState(root, owner, manifest.Roll.RollID)
			if err != nil {
				return nil, err
			}
			rolls = append(rolls, manifest.Roll)
		}
	}
	sort.Slice(rolls, func(i, j int) bool { return rolls[i].CreatedAt > rolls[j].CreatedAt })
	return rolls, nil
}

func openProductionRoll(root, owner string, p productionRollRequest) (productionRoll, error) {
	resume := func(roll productionRoll) (productionRoll, error) {
		before, _ := json.Marshal(roll)
		if err := bindProductionIdentity(root, owner, &roll, p, false); err != nil {
			return productionRoll{}, err
		}
		after, _ := json.Marshal(roll)
		if string(before) != string(after) {
			roll.Revision++
			if err := saveProductionRoll(root, owner, roll); err != nil {
				return productionRoll{}, err
			}
		}
		return roll, nil
	}
	if p.RollID != "" {
		roll, err := readProductionRoll(root, owner, p.RollID)
		if err != nil {
			return productionRoll{}, err
		}
		if roll.State != "open" {
			return productionRoll{}, productionError("This roll is closed. Start a new roll instead of resuming closed history.")
		}
		return resume(roll)
	}
	rolls, err := listProductionRolls(root, owner)
	if err != nil {
		return productionRoll{}, err
	}
	for _, roll := range rolls {
		if roll.State == "open" && (p.PrinterHost == "" || roll.PrinterHost == "" || (productionEndpointHost(roll.PrinterHost) == productionEndpointHost(p.PrinterHost) && roll.PrinterPort == p.PrinterPort)) {
			return productionRoll{}, productionError("An earlier roll is still open for this printer. Explicitly resume that roll or close it before starting a new lot. Closing keeps all history and does not require CSV export.")
		}
	}
	if err := validateProductionJobIdentityLocked(root, owner, p.PrinterHost, p.PrinterPort, nil); err != nil {
		return productionRoll{}, err
	}
	if p.TargetLabels < 0 || p.TargetLabels > 1000000 {
		return productionRoll{}, badRequest("Invalid label quantity.")
	}
	if p.TemplateFingerprint != "" && !validProductionFingerprint(p.TemplateFingerprint) {
		return productionRoll{}, badRequest("Invalid template fingerprint.")
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return productionRoll{}, err
	}
	// Business metadata is deliberately absent until the export dialog is filled.
	roll := productionRoll{RollID: "roll-" + hex.EncodeToString(id[:]), TargetLabels: p.TargetLabels, TemplateName: p.TemplateName, TemplateFingerprint: strings.ToLower(p.TemplateFingerprint), Kind: p.Kind, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), State: "open", Revision: 1, Runs: []productionRun{}, Reviews: []productionRunReview{}, RemovalAccountingVersion: 2}
	if err := bindProductionIdentity(root, owner, &roll, p, false); err != nil {
		return productionRoll{}, err
	}
	return roll, saveProductionRoll(root, owner, roll)
}

func adjustProductionRemovedQuantity(root, owner string, roll *productionRoll, request productionRollRequest, summary productionRollSummary) error {
	if roll.State != "open" {
		return productionError("A closed roll cannot change its recorded removed quantity.")
	}
	if len(summary.ActiveRuns) > 0 {
		return productionError("Finish or stop the current run before changing removed quantities.")
	}
	good, rejected := request.RemovedGoodCount, request.RemovedRejectedCount
	if good == nil && rejected == nil && request.RemovedValidCount != nil && productionOperationMode(roll.OperationMode) == "read" {
		good = request.RemovedValidCount
		zero := int64(0)
		rejected = &zero
	} else if request.RemovedValidCount != nil {
		return badRequest("Use removedGoodCount and removedRejectedCount to classify removed labels.")
	}
	if good == nil || rejected == nil {
		return badRequest("removedGoodCount and removedRejectedCount are required together.")
	}
	if *good < 0 || *rejected < 0 || *good > 9007199254740991 || *rejected > 9007199254740991-*good {
		return badRequest("Removed quantities must be nonnegative safe integers.")
	}
	if *good > summary.RemovableGoodCount || *rejected > summary.RemovableRejectedCount {
		return productionError("Removed quantities exceed the recorded GOOD or rejected label counts.")
	}
	if *rejected > 0 && productionOperationMode(roll.OperationMode) == "read" {
		return badRequest("Read-only rolls accept GOOD removals only.")
	}
	if !roll.RemovalReviewRequired && roll.RemovalAccountingVersion == 2 && *good == roll.RemovedGoodCount && *rejected == roll.RemovedRejectedCount {
		return nil
	}
	roll.RemovalAdjustments = append(roll.RemovalAdjustments, productionQuantityAdjustment{Previous: roll.RemovedValidCount, Count: *good + *rejected, PreviousGood: roll.RemovedGoodCount, Good: *good, PreviousRejected: roll.RemovedRejectedCount, Rejected: *rejected, AccountingVersion: 2, At: time.Now().UTC().Format(time.RFC3339Nano)})
	roll.RemovedGoodCount, roll.RemovedRejectedCount = *good, *rejected
	roll.RemovedValidCount = *good + *rejected
	roll.RemovalAccountingVersion, roll.RemovalReviewRequired = 2, false
	roll.Revision++
	return saveProductionRoll(root, owner, *roll)
}

// Take this snapshot BEFORE productionRollMu: open() holds session.mu while
// registering the run, so taking the locks in the reverse order would deadlock.
func (m *tcpJobManager) productionActiveRuns(owner string) map[string]bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.productionActiveRunsLocked(owner)
}

// Caller holds m.mu, before productionRollMu. This order matches admission.
func (m *tcpJobManager) productionActiveRunsLocked(owner string) map[string]bool {
	active := map[string]bool{}
	for _, session := range m.jobs {
		// A busy session is conservatively active. Never block other printers'
		// admission or the dashboard behind a physical printer response.
		locked := session.mu.TryLock()
		running := !locked
		if locked {
			running = session.state == "opening" || session.state == "open"
		}
		if running {
			active["target:"+tcpPrinterTargetKey(session.host, session.port)] = true
			if session.owner == owner {
				active[session.jobID] = true
				if session.captureOptions != nil && session.captureOptions.ProductionRollID != "" {
					active["roll:"+session.captureOptions.ProductionRollID] = true
				}
			}
		}
		if locked {
			session.mu.Unlock()
		}
	}
	return active
}

func (m *tcpJobManager) handleProductionRoll(w http.ResponseWriter, r *http.Request, owner string, body tcpJobRequest) error {
	m.spoolMu.Lock()
	defer m.spoolMu.Unlock()
	if err := m.loadSpoolsLocked(); err != nil {
		return err
	}
	if m.captureDir == "" {
		return &apiError{Status: 503, Code: "RFID_CAPTURE_UNAVAILABLE", Message: "Production evidence storage is unavailable."}
	}
	if body.Production == nil {
		return badRequest("production metadata is required.")
	}
	p := *body.Production
	if err := validateProductionText(&p); err != nil {
		return err
	}
	var active map[string]bool
	if body.Action == "roll-close" || body.Action == "roll-history-clear" || body.Action == "roll-history-restore" {
		// Keep admission locked through the durable close. A job already queued
		// for this roll is detected even before it registers its first run.
		m.mu.Lock()
		defer m.mu.Unlock()
		active = m.productionActiveRunsLocked(owner)
	} else {
		active = m.productionActiveRuns(owner)
	}
	for _, job := range m.spools {
		if job.Owner == owner && fleetActive(job.State) {
			active[job.JobID] = true
			active["target:"+tcpPrinterTargetKey(job.Host, job.Port)] = true
			if job.Capture != nil {
				active["roll:"+job.Capture.ProductionRollID] = true
			}
		}
	}
	productionRollMu.Lock()
	defer productionRollMu.Unlock()
	if body.Action == "roll-history-clear" || body.Action == "roll-history-restore" {
		return m.updateProductionRollHistory(w, owner, p.RollIDs, body.Action == "roll-history-clear", active)
	}
	if body.Action == "roll-list" {
		rolls, err := listProductionRolls(m.captureDir, owner)
		if err != nil {
			return err
		}
		w.Header().Set("Content-Type", "application/json")
		return json.NewEncoder(w).Encode(map[string]any{"ok": true, "rolls": rolls})
	}
	var roll productionRoll
	var err error
	if body.Action == "roll-create" {
		roll, err = openProductionRoll(m.captureDir, owner, p)
	} else {
		if len(p.RollID) > 96 || p.RollID == "" {
			return badRequest("rollId is required.")
		}
		roll, err = readProductionRoll(m.captureDir, owner, p.RollID)
	}
	if err != nil {
		return err
	}
	// Re-download a closed report from its authenticated archive. Raw evidence
	// availability cannot make a previously completed export inaccessible.
	if body.Action == "roll-export" {
		if roll.State == "open" {
			return productionError("Close this roll before exporting CSV. Closing preserves history and lets you start a new lot; CSV can be exported later.")
		}
		_, receiptErr := os.Stat(filepath.Join(productionDirectory(m.captureDir, owner, roll.RollID), "final-export.json"))
		if roll.State == "finalized" || roll.ExportedAt != "" || receiptErr == nil {
			return m.exportProductionRoll(w, owner, productionRollView{Roll: roll}, false)
		}
	}
	if body.Action == "roll-close" && roll.State == "open" && (active["roll:"+roll.RollID] || (roll.PrinterHost != "" && active["target:"+tcpPrinterTargetKey(roll.PrinterHost, roll.PrinterPort)])) {
		return productionError("This roll has an active or queued print job. Finish or stop it before closing the roll.")
	}
	view, err := m.inspectProductionRoll(owner, roll, active)
	if err != nil {
		return err
	}
	if body.Action == "roll-adjust" {
		if err := adjustProductionRemovedQuantity(m.captureDir, owner, &roll, p, view.Summary); err != nil {
			return err
		}
		view, err = m.inspectProductionRoll(owner, roll, active)
		if err != nil {
			return err
		}
	}
	switch body.Action {
	case "roll-note":
		if err := applyProductionNote(m.captureDir, owner, &view, p); err != nil {
			return err
		}
	case "roll-create", "roll-get", "roll-adjust":
	case "roll-status":
		view.Rows = []productionRow{}
	case "roll-close":
		if roll.State == "open" {
			if len(view.Summary.ActiveRuns) > 0 {
				return productionError("This roll has an active print run. Finish or stop it before closing the roll.")
			}
			roll.State = "closed"
			roll.ClosedAt = time.Now().UTC().Format(time.RFC3339Nano)
			roll.ClosedBy, roll.CloseNote = p.ClosedBy, p.Note
			roll.CloseWarnings = append([]string{}, view.Summary.Blockers...)
			if !view.Summary.CountsComplete || !view.Summary.GoodCountKnown {
				roll.CloseWarnings = append(roll.CloseWarnings, "Closed without certifying final counts; incomplete evidence and reconciliation requirements are retained.")
			}
			roll.Revision++
			if err := saveProductionRoll(m.captureDir, owner, roll); err != nil {
				return err
			}
			view.Roll = roll
			view.Summary.CanFinalize = false
			// Classification can remain unresolved on a closed legacy roll.
			// Keep the warning in closure history while enabling honest export.
			if roll.RemovalReviewRequired {
				blockers := view.Summary.Blockers[:0]
				for _, blocker := range view.Summary.Blockers {
					if blocker != "Classify the legacy removed quantity into GOOD and rejected labels before export." {
						blockers = append(blockers, blocker)
					}
				}
				view.Summary.Blockers = blockers
			}
		}
	case "roll-finalize", "roll-review":
		return badRequest("Use roll-close to end the roll. Export CSV separately with operator, jobId and rollNumber when needed.")
	case "roll-export":
		if len(view.Summary.Blockers) > 0 {
			return productionError("Cannot take a complete export snapshot: " + strings.Join(view.Summary.Blockers, "; "))
		}
		if roll.State == "closed" {
			p.JobID = strings.TrimSpace(p.JobID)
			if p.Operator == "" || p.JobID == "" || len(p.JobID) > 128 || strings.ContainsAny(p.JobID, "\r\n\x00") || p.RollNumber < 1 || p.RollNumber > 999999 {
				return badRequest("Enter the operator name, job ID and positive roll number before exporting.")
			}
			view.Roll.Operator, view.Roll.JobID, view.Roll.RollNumber = p.Operator, p.JobID, p.RollNumber
			view.Roll.ExportedBy = p.Operator
			view.Roll.ExportedAt = time.Now().UTC().Format(time.RFC3339Nano)
			view.Roll.ExportFileName = ""
			view.Roll.ExportFileName = productionExportFileName(view.Roll)
		}
		return m.exportProductionRoll(w, owner, view, false)
	default:
		return badRequest("Unknown production roll action.")
	}
	w.Header().Set("Content-Type", "application/json")
	return json.NewEncoder(w).Encode(view)
}
