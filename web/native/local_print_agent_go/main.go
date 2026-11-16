package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const (
	agentName    = "Nextwaves Zebra Local Print Connector"
	agentVersion = "0.12.2"
	defaultPort  = 17917
)

func main() {
	var (
		port                = flag.Int("port", defaultPort, "HTTP port")
		listenAddressFlag   = flag.String("listen-address", "127.0.0.1", "one loopback/private/link-local IP address")
		stateFile           = flag.String("state-file", "", "pairing state file (default: user config directory)")
		tcpPorts            = flag.String("tcp-ports", "9100", "comma-separated TCP printer ports to allow")
		requireOriginToken  = flag.Bool("require-origin-token", false, "require HTTPS Origin pairing and a token for every protected request")
		allowNonZebraQueues = flag.Bool(
			"allow-non-zebra-queues",
			false,
			"allow Windows RAW jobs to queues that are not recognized as Zebra (unsafe)",
		)
	)
	flag.Parse()

	if *port < 1 || *port > 65535 {
		log.Fatalf("invalid --port %d", *port)
	}
	configuredListenAddress, err := parseListenAddress(*listenAddressFlag)
	if err != nil {
		log.Fatalf("invalid --listen-address: %v", err)
	}
	allowedPorts, err := parseAllowedPorts(*tcpPorts)
	if err != nil {
		log.Fatalf("invalid --tcp-ports: %v", err)
	}
	if *stateFile == "" {
		configDir, configErr := os.UserConfigDir()
		if configErr != nil {
			log.Fatalf("locate user config directory: %v", configErr)
		}
		*stateFile = filepath.Join(configDir, "Nextwaves", "ZebraPrinterConnector", "paired-origins.json")
	}

	logger := log.New(os.Stderr, "[local-print-connector] ", log.LstdFlags|log.LUTC)
	pairs, err := newPairStore(*stateFile)
	if err != nil {
		logger.Fatalf("load pairing state: %v", err)
	}
	pairing, err := newPairingManager(pairs, 10*time.Minute, func(code string, expires time.Time) {
		logger.Printf("PAIRING CODE: %s (expires %s)", code, expires.Local().Format(time.RFC3339))
	})
	if err != nil {
		logger.Fatalf("initialize pairing: %v", err)
	}

	app := newAppServer(serverConfig{
		ListenAddress:       configuredListenAddress,
		Port:                *port,
		AllowedTCPPorts:     allowedPorts,
		AllowNonZebraQueues: *allowNonZebraQueues,
		RequireOriginToken:  *requireOriginToken,
		Pairing:             pairing,
		Logger:              logger,
		RawSpoolStateDir:    filepath.Join(filepath.Dir(*stateFile), "raw-spool-batches"),
	})
	defer app.tcpJobs.close()
	defer app.rawSpoolBatches.close()
	address := configuredListenAddress.hostPort(*port)
	httpServer := &http.Server{
		Addr:              address,
		Handler:           app,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       2 * time.Minute,
		// WritePrinter and a backpressured 9100 socket are synchronous. A 55 s
		// server deadline can discard the HTTP receipt after the job was already
		// accepted, which invites an unsafe duplicate retry for large batches.
		WriteTimeout:   11 * time.Minute,
		IdleTimeout:    60 * time.Second,
		MaxHeaderBytes: 32 * 1024,
	}

	logger.Printf("%s %s (%s/%s)", agentName, agentVersion, runtime.GOOS, runtime.GOARCH)
	logger.Printf("listening on exact address http://%s (site mode: %t)", address, configuredListenAddress.siteMode)
	if configuredListenAddress.siteMode {
		logger.Printf("WARNING: site mode is LAN/VPN-only; restrict inbound TCP %d with the host/network firewall", *port)
	}
	logger.Printf("require browser Origin and token: %t", *requireOriginToken || configuredListenAddress.siteMode)
	logger.Printf("allowed TCP printer ports: %v", sortedPorts(allowedPorts))
	logger.Printf("allow non-Zebra Windows queues: %t", *allowNonZebraQueues)
	logger.Printf("pairing state: %s", *stateFile)
	logger.Printf("endpoints: GET /v1/health, POST /v1/pair, GET /v1/printers, POST /v1/tcp/exchange, POST /v1/tcp/job, POST /v1/print, POST /v1/print/batch")
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Fatalf("HTTP server stopped: %v", err)
	}
}
