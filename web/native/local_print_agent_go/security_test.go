package main

import (
	"net"
	"testing"
)

func TestNormalizeOrigin(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{name: "cloud HTTPS", input: "https://Print.Example.com", want: "https://print.example.com"},
		{name: "default HTTPS port", input: "https://print.example.com:443", want: "https://print.example.com"},
		{name: "localhost HTTP", input: "http://localhost:3000", want: "http://localhost:3000"},
		{name: "IPv4 loopback", input: "http://127.0.0.1:8888", want: "http://127.0.0.1:8888"},
		{name: "IPv6 loopback", input: "http://[::1]:8888", want: "http://[::1]:8888"},
		{name: "remote HTTP rejected", input: "http://print.example.com", wantErr: true},
		{name: "path rejected", input: "https://print.example.com/path", wantErr: true},
		{name: "opaque origin rejected", input: "null", wantErr: true},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got, err := normalizeOrigin(test.input)
			if test.wantErr {
				if err == nil {
					t.Fatalf("normalizeOrigin(%q) unexpectedly succeeded with %q", test.input, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeOrigin(%q): %v", test.input, err)
			}
			if got != test.want {
				t.Fatalf("normalizeOrigin(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

func TestValidateRequestHost(t *testing.T) {
	t.Parallel()
	loopback, err := parseListenAddress("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if err := validateRequestHost("127.0.0.1:17917", loopback, 17917); err != nil {
		t.Fatalf("configured loopback Host was rejected: %v", err)
	}
	for _, host := range []string{
		"localhost:17917",
		"127.0.0.2:17917",
		"127.0.0.1:80",
		"127.0.0.1",
		"evil.example:17917",
		"",
	} {
		if err := validateRequestHost(host, loopback, 17917); err == nil {
			t.Errorf("expected %q to be rejected", host)
		}
	}

	ipv6, err := parseListenAddress("fd00::25")
	if err != nil {
		t.Fatal(err)
	}
	if got := ipv6.hostPort(17917); got != "[fd00::25]:17917" {
		t.Fatalf("IPv6 bind address = %q, want %q", got, "[fd00::25]:17917")
	}
	if err := validateRequestHost("[fd00::25]:17917", ipv6, 17917); err != nil {
		t.Fatalf("configured IPv6 Host was rejected: %v", err)
	}
	if err := validateRequestHost("fd00::25:17917", ipv6, 17917); err == nil {
		t.Fatal("unbracketed IPv6 Host was accepted")
	}

	linkLocal, err := parseListenAddress("fe80::25%en0")
	if err != nil {
		t.Fatal(err)
	}
	if got := linkLocal.hostPort(17917); got != "[fe80::25%en0]:17917" {
		t.Fatalf("zoned IPv6 bind address = %q, want %q", got, "[fe80::25%en0]:17917")
	}
	for _, host := range []string{"[fe80::25%en0]:17917", "[fe80::25%25en0]:17917"} {
		if err := validateRequestHost(host, linkLocal, 17917); err != nil {
			t.Errorf("configured zoned IPv6 Host %q was rejected: %v", host, err)
		}
	}
}

func TestParseListenAddress(t *testing.T) {
	t.Parallel()
	allowed := []struct {
		value     string
		canonical string
		siteMode  bool
	}{
		{value: "127.0.0.1", canonical: "127.0.0.1", siteMode: false},
		{value: "::1", canonical: "::1", siteMode: false},
		{value: "192.168.50.10", canonical: "192.168.50.10", siteMode: true},
		{value: "169.254.50.10", canonical: "169.254.50.10", siteMode: true},
		{value: "fd00::25", canonical: "fd00::25", siteMode: true},
		{value: "fe80::25%en0", canonical: "fe80::25%en0", siteMode: true},
	}
	for _, test := range allowed {
		address, err := parseListenAddress(test.value)
		if err != nil {
			t.Errorf("parseListenAddress(%q): %v", test.value, err)
			continue
		}
		if address.value != test.canonical || address.siteMode != test.siteMode {
			t.Errorf(
				"parseListenAddress(%q) = (%q, %v), want (%q, %v)",
				test.value,
				address.value,
				address.siteMode,
				test.canonical,
				test.siteMode,
			)
		}
	}
	for _, value := range []string{
		"",
		"localhost",
		"0.0.0.0",
		"::",
		"8.8.8.8",
		"224.0.0.1",
		"169.254.169.254",
		"169.254.170.2",
		"192.168.50.10:17917",
		"fe80::25",
		"fd00::25%en0",
	} {
		if _, err := parseListenAddress(value); err == nil {
			t.Errorf("parseListenAddress(%q) unexpectedly succeeded", value)
		}
	}
}

func TestAllowedPrinterIP(t *testing.T) {
	t.Parallel()
	tests := map[string]bool{
		"192.168.50.50":   true,
		"10.1.2.3":        true,
		"172.16.0.10":     true,
		"169.254.4.2":     true,
		"169.254.169.254": false,
		"169.254.170.2":   false,
		"fd00::10":        true,
		"fd00:ec2::254":   false,
		"fe80::10":        true,
		"fe80::a9fe:a9fe": false,
		"127.0.0.1":       false,
		"0.0.0.0":         false,
		"8.8.8.8":         false,
		"224.0.0.1":       false,
		"2001:4860::1":    false,
	}
	for raw, want := range tests {
		if got := isAllowedPrinterIP(net.ParseIP(raw)); got != want {
			t.Errorf("isAllowedPrinterIP(%s) = %v, want %v", raw, got, want)
		}
	}
}

func TestTrustedZebraQueue(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		printer PrinterInfo
		want    bool
	}{
		{
			name: "ZDesigner driver",
			printer: PrinterInfo{
				Name:       "ZT610 Production",
				DriverName: "ZDesigner ZT610-300dpi ZPL",
				PortName:   "IP_192.168.50.50",
			},
			want: true,
		},
		{
			name: "Zebra in queue name",
			printer: PrinterInfo{
				Name:       "Zebra Packing Line",
				DriverName: "Generic / Text Only",
				PortName:   "USB001",
			},
			want: true,
		},
		{
			name: "generic queue",
			printer: PrinterInfo{
				Name:       "Office Printer",
				DriverName: "Generic / Text Only",
				PortName:   "LPT1",
			},
			want: false,
		},
		{
			name: "redirected Zebra queue",
			printer: PrinterInfo{
				Name:       "Zebra ZT610 (redirected 2)",
				DriverName: "ZDesigner ZT610",
				PortName:   "TS001",
			},
			want: false,
		},
		{
			name: "misleading PDF queue",
			printer: PrinterInfo{
				Name:       "Zebra Label PDF",
				DriverName: "Microsoft Print to PDF",
				PortName:   "PORTPROMPT:",
			},
			want: false,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := isTrustedZebraQueue(&test.printer); got != test.want {
				t.Fatalf("isTrustedZebraQueue() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestParseAllowedPorts(t *testing.T) {
	t.Parallel()
	ports, err := parseAllowedPorts("9100, 6101,9100")
	if err != nil {
		t.Fatal(err)
	}
	if len(ports) != 2 {
		t.Fatalf("got %d ports, want 2", len(ports))
	}
	if _, ok := ports[9100]; !ok {
		t.Fatal("port 9100 is missing")
	}
	for _, invalid := range []string{"", "0", "9100,nope", "65536"} {
		if _, err := parseAllowedPorts(invalid); err == nil {
			t.Errorf("parseAllowedPorts(%q) unexpectedly succeeded", invalid)
		}
	}
}
