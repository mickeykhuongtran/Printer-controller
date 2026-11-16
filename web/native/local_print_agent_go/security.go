package main

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type listenAddress struct {
	ip       net.IP
	zone     string
	value    string
	siteMode bool
}

func parseListenAddress(raw string) (listenAddress, error) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		raw = strings.TrimSuffix(strings.TrimPrefix(raw, "["), "]")
	}
	ip, zone, err := parseIPLiteral(raw)
	if err != nil {
		return listenAddress{}, fmt.Errorf("--listen-address must be one explicit IP address: %w", err)
	}
	if ip.IsUnspecified() {
		return listenAddress{}, fmt.Errorf("--listen-address must not be a wildcard or unspecified address")
	}
	if ip.IsMulticast() {
		return listenAddress{}, fmt.Errorf("--listen-address must not be multicast")
	}
	if isMetadataServiceIP(ip) {
		return listenAddress{}, fmt.Errorf("--listen-address must not be a cloud metadata address")
	}
	if !ip.IsLoopback() && !ip.IsPrivate() && !ip.IsLinkLocalUnicast() {
		return listenAddress{}, fmt.Errorf("--listen-address must be loopback, private, or link-local unicast")
	}
	value := ip.String()
	if zone != "" {
		value += "%" + zone
	}
	return listenAddress{
		ip:       ip,
		zone:     zone,
		value:    value,
		siteMode: !ip.IsLoopback(),
	}, nil
}

func parseIPLiteral(raw string) (net.IP, string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, "", fmt.Errorf("address is empty")
	}
	zone := ""
	if separator := strings.LastIndex(raw, "%"); separator >= 0 {
		zone = raw[separator+1:]
		raw = raw[:separator]
		if zone == "" || len(zone) > 64 {
			return nil, "", fmt.Errorf("IPv6 zone is invalid")
		}
		for _, character := range zone {
			if (character < 'a' || character > 'z') &&
				(character < 'A' || character > 'Z') &&
				(character < '0' || character > '9') &&
				character != '_' && character != '-' && character != '.' {
				return nil, "", fmt.Errorf("IPv6 zone is invalid")
			}
		}
	}
	ip := net.ParseIP(raw)
	if ip == nil {
		return nil, "", fmt.Errorf("hostnames and host:port values are not accepted")
	}
	if zone != "" && (ip.To4() != nil || !ip.IsLinkLocalUnicast()) {
		return nil, "", fmt.Errorf("a zone is allowed only for an IPv6 link-local address")
	}
	if ip.To4() == nil && ip.IsLinkLocalUnicast() && zone == "" {
		return nil, "", fmt.Errorf("an IPv6 link-local address requires an interface zone")
	}
	return ip, zone, nil
}

func (address listenAddress) hostPort(port int) string {
	return net.JoinHostPort(address.value, strconv.Itoa(port))
}

func normalizeOrigin(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" {
		return "", fmt.Errorf("origin is empty or opaque")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("invalid origin")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("origin contains unsupported components")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", fmt.Errorf("origin must not contain a path")
	}
	scheme := strings.ToLower(parsed.Scheme)
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return "", fmt.Errorf("origin host is required")
	}
	if scheme != "https" && !(scheme == "http" && isLoopbackHost(host)) {
		return "", fmt.Errorf("origin must use HTTPS unless it is localhost")
	}
	port := parsed.Port()
	if port != "" {
		value, parseErr := strconv.Atoi(port)
		if parseErr != nil || value < 1 || value > 65535 {
			return "", fmt.Errorf("origin port is invalid")
		}
		if (scheme == "https" && value == 443) || (scheme == "http" && value == 80) {
			port = ""
		}
	}
	if ip := net.ParseIP(host); ip != nil {
		host = ip.String()
	} else if !validDNSName(host) {
		return "", fmt.Errorf("origin hostname is invalid")
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		host = net.JoinHostPort(strings.Trim(host, "[]"), port)
	}
	return scheme + "://" + host, nil
}

func isLoopbackOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	return err == nil && isLoopbackHost(parsed.Hostname())
}

func isHTTPSOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	return err == nil && strings.EqualFold(parsed.Scheme, "https")
}

func isLoopbackHost(host string) bool {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func validDNSName(host string) bool {
	if len(host) == 0 || len(host) > 253 || strings.HasSuffix(host, ".") {
		return false
	}
	labels := strings.Split(host, ".")
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, ch := range label {
			if (ch < 'a' || ch > 'z') && (ch < '0' || ch > '9') && ch != '-' {
				return false
			}
		}
	}
	return true
}

func validateRequestHost(hostHeader string, expectedAddress listenAddress, expectedPort int) error {
	hostHeader = strings.TrimSpace(hostHeader)
	if hostHeader == "" || strings.ContainsAny(hostHeader, `/\@`) {
		return forbidden("Invalid Host header.")
	}
	host, port, err := net.SplitHostPort(hostHeader)
	if err != nil {
		return forbidden("Host must contain the configured IP address and port.")
	}
	numericPort, err := strconv.Atoi(port)
	if err != nil || numericPort != expectedPort {
		return forbidden("Host port does not match the connector port.")
	}
	// RFC 6874 serializes the '%' introducing an IPv6 zone as '%25' in URLs.
	host = strings.Replace(host, "%25", "%", 1)
	ip, zone, err := parseIPLiteral(host)
	if err != nil || !ip.Equal(expectedAddress.ip) || zone != expectedAddress.zone {
		return forbidden("Host must exactly match the configured listen IP and port.")
	}
	return nil
}

func bearerToken(request *http.Request) (string, error) {
	authorization := strings.TrimSpace(request.Header.Get("Authorization"))
	explicit := strings.TrimSpace(request.Header.Get("X-Nextwaves-Token"))
	token := ""
	if authorization != "" {
		const prefix = "Bearer "
		if len(authorization) <= len(prefix) || !strings.EqualFold(authorization[:len(prefix)], prefix) {
			return "", &apiError{Status: 401, Message: "Authorization must use a Bearer token."}
		}
		token = strings.TrimSpace(authorization[len(prefix):])
	}
	if explicit != "" {
		if token != "" && token != explicit {
			return "", &apiError{Status: 401, Message: "Conflicting connector tokens."}
		}
		token = explicit
	}
	return token, nil
}

func allowedPreflightHeaders(value string) bool {
	if strings.TrimSpace(value) == "" {
		return true
	}
	allowed := map[string]bool{
		"authorization":          true,
		"content-type":           true,
		"x-nextwaves-token":      true,
		"x-requested-with":       true,
		"private-network-access": true,
	}
	for _, header := range strings.Split(value, ",") {
		if !allowed[strings.ToLower(strings.TrimSpace(header))] {
			return false
		}
	}
	return true
}
