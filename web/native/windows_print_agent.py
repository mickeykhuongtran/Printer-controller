from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 17917
MAX_JSON_BYTES = 48 * 1024 * 1024
MAX_PAYLOAD_BYTES = 32 * 1024 * 1024

try:
    import win32print  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover - depends on Windows host setup
    win32print = None  # type: ignore[assignment]
    WIN32PRINT_IMPORT_ERROR = exc
else:
    WIN32PRINT_IMPORT_ERROR = None


class AgentError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def require_win32print() -> Any:
    if os.name != "nt":
        raise AgentError(501, "Windows RAW printing is only available on Windows.")
    if win32print is None:
        raise AgentError(
            500,
            "pywin32 is not installed. Run: python -m pip install -r native/requirements-windows.txt",
        )
    return win32print


def clean_text(
    value: Any,
    fallback: str,
    max_len: int = 160,
    collapse_whitespace: bool = True,
) -> str:
    if not isinstance(value, str):
        return fallback
    cleaned = value.strip()
    if collapse_whitespace:
        cleaned = " ".join(cleaned.split())
    return cleaned[:max_len] or fallback


def list_printers() -> list[dict[str, Any]]:
    wp = require_win32print()
    default_name = ""
    try:
        default_name = wp.GetDefaultPrinter()
    except Exception:
        default_name = ""

    flags = wp.PRINTER_ENUM_LOCAL | wp.PRINTER_ENUM_CONNECTIONS
    printers: list[dict[str, Any]] = []

    try:
        rows = wp.EnumPrinters(flags, None, 2)
    except Exception:
        rows = []

    for row in rows:
        if isinstance(row, dict):
            name = row.get("pPrinterName", "")
            description = row.get("pShareName") or ""
            comment = row.get("pComment") or ""
            port_name = row.get("pPortName") or ""
            driver_name = row.get("pDriverName") or ""
        else:
            name = row[2] if len(row) > 2 else ""
            description = row[1] if len(row) > 1 and row[1] else ""
            comment = row[3] if len(row) > 3 and row[3] else ""
            port_name = row[4] if len(row) > 4 and row[4] else ""
            driver_name = row[5] if len(row) > 5 and row[5] else ""
        if not name:
            continue
        printers.append(
            {
                "name": name,
                "description": description,
                "comment": comment,
                "portName": port_name,
                "driverName": driver_name,
                "isDefault": bool(default_name and name == default_name),
            },
        )

    if printers:
        printers.sort(key=lambda item: (not item["isDefault"], item["name"].lower()))
        return printers

    rows = wp.EnumPrinters(flags, None, 1)
    for row in rows:
        try:
            _flags, description, name, comment = row
        except ValueError:
            continue
        if not name:
            continue
        printers.append(
            {
                "name": name,
                "description": description or "",
                "comment": comment or "",
                "portName": "",
                "driverName": "",
                "isDefault": bool(default_name and name == default_name),
            },
        )
    printers.sort(key=lambda item: (not item["isDefault"], item["name"].lower()))
    return printers


def printer_info_by_name(printer_name: str) -> dict[str, Any] | None:
    wanted = printer_name.strip().lower()
    if not wanted:
        return None
    for printer in list_printers():
        if str(printer.get("name", "")).strip().lower() == wanted:
            return printer
    return None


def raw_zpl_warning(printer: dict[str, Any] | None) -> str:
    if not printer:
        return ""
    name = str(printer.get("name", "")).lower()
    driver = str(printer.get("driverName", "")).lower()
    port = str(printer.get("portName", "")).upper()
    if "(redirected" in name or "remote desktop easy print" in driver or port.startswith("TS"):
        return "Remote Desktop redirected printer queue; RAW ZPL may not reach the physical Zebra printer."
    if (
        "pdf" in name
        or "onenote" in name
        or "pdf" in driver
        or "xps" in driver
        or "ipp class" in driver
    ):
        return "Printer queue is not a raw Zebra queue."
    if "zebra" not in name and "zebra" not in driver and "zdesigner" not in driver and "seagull" not in driver:
        return "Printer queue does not look like Zebra/ZDesigner/Seagull."
    return ""


def print_raw(printer_name: str, document_name: str, payload: bytes) -> dict[str, Any]:
    wp = require_win32print()
    if not printer_name:
        raise AgentError(400, "printerName is required.")
    if not payload:
        raise AgentError(400, "payloadBase64 decoded to an empty payload.")
    if len(payload) > MAX_PAYLOAD_BYTES:
        raise AgentError(413, f"Payload is too large. Max is {MAX_PAYLOAD_BYTES} bytes.")

    handle = None
    doc_started = False
    page_started = False
    job_id = None
    printer_info = printer_info_by_name(printer_name)
    warning = raw_zpl_warning(printer_info)
    driver = printer_info.get("driverName", "") if printer_info else ""
    port = printer_info.get("portName", "") if printer_info else ""
    sys.stderr.write(
        f"[print-agent] RAW job request printer={printer_name!r} port={port!r} "
        f"driver={driver!r} document={document_name!r} bytes={len(payload)}\n",
    )
    if warning:
        sys.stderr.write(f"[print-agent] WARNING: {warning}\n")
    try:
        handle = wp.OpenPrinter(printer_name)
        job_id = wp.StartDocPrinter(handle, 1, (document_name, None, "RAW"))
        doc_started = True
        wp.StartPagePrinter(handle)
        page_started = True
        bytes_written = 0
        while bytes_written < len(payload):
            accepted = wp.WritePrinter(handle, payload[bytes_written:])
            if accepted is None:
                accepted = len(payload) - bytes_written
            accepted = int(accepted)
            if accepted <= 0:
                raise AgentError(
                    502,
                    f"WritePrinter accepted zero bytes after {bytes_written} bytes.",
                )
            bytes_written += accepted
        wp.EndPagePrinter(handle)
        page_started = False
        wp.EndDocPrinter(handle)
        doc_started = False
        return {
            "ok": True,
            "printerName": printer_name,
            "documentName": document_name,
            "jobId": job_id,
            "bytesWritten": int(bytes_written),
            "portName": port,
            "driverName": driver,
            "warning": warning,
        }
    except Exception:
        # EndDocPrinter can commit a truncated RAW stream. Abort the current
        # spool document on failure; bytes already forwarded by a port monitor
        # may still have an uncertain physical outcome and must not be retried
        # blindly by callers.
        if handle is not None and doc_started:
            try:
                wp.AbortPrinter(handle)
            except Exception:
                pass
        raise
    finally:
        if handle is not None:
            wp.ClosePrinter(handle)


class PrintAgentHandler(BaseHTTPRequestHandler):
    server_version = "ZbrePrinterPrintAgent/1.0"

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        try:
            if self.path == "/health":
                self.write_json(
                    200,
                    {
                        "ok": True,
                        "platform": sys.platform,
                        "win32print": win32print is not None,
                        "host": self.server.server_address[0],
                        "port": self.server.server_address[1],
                    },
                )
            elif self.path == "/printers":
                self.write_json(200, {"printers": list_printers()})
            else:
                raise AgentError(404, "Unknown endpoint.")
        except AgentError as exc:
            self.write_json(exc.status, {"ok": False, "error": exc.message})
        except Exception as exc:
            self.write_json(500, {"ok": False, "error": str(exc)})

    def do_POST(self) -> None:
        try:
            if self.path != "/print":
                raise AgentError(404, "Unknown endpoint.")
            body = self.read_json_body()
            printer_name = clean_text(
                body.get("printerName"),
                "",
                260,
                collapse_whitespace=False,
            )
            document_name = clean_text(body.get("documentName"), "Nextwaves label", 160)
            payload_b64 = body.get("payloadBase64")
            if not isinstance(payload_b64, str):
                raise AgentError(400, "payloadBase64 is required.")
            try:
                payload = base64.b64decode(payload_b64, validate=True)
            except Exception:
                raise AgentError(400, "payloadBase64 is not valid base64.")
            self.write_json(200, print_raw(printer_name, document_name, payload))
        except AgentError as exc:
            self.write_json(exc.status, {"ok": False, "error": exc.message})
        except Exception as exc:
            self.write_json(500, {"ok": False, "error": str(exc)})

    def read_json_body(self) -> dict[str, Any]:
        raw_len = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_len)
        except ValueError:
            raise AgentError(400, "Invalid Content-Length.")
        if length <= 0:
            raise AgentError(400, "Request body is empty.")
        if length > MAX_JSON_BYTES:
            raise AgentError(413, f"Request JSON is too large. Max is {MAX_JSON_BYTES} bytes.")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            raise AgentError(400, "Request body is not valid JSON.")
        if not isinstance(data, dict):
            raise AgentError(400, "Request JSON must be an object.")
        return data

    def write_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[print-agent] " + fmt % args + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="ZbrePrinter Windows RAW print agent")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    if args.host not in ("127.0.0.1", "localhost"):
        print(
            "Refusing to bind outside localhost. Use 127.0.0.1 for the local browser bridge.",
            file=sys.stderr,
        )
        return 2

    server = ThreadingHTTPServer((args.host, args.port), PrintAgentHandler)
    print(f"ZbrePrinter Windows RAW print agent listening on http://{args.host}:{args.port}")
    print("Endpoints: GET /health, GET /printers, POST /print")
    if WIN32PRINT_IMPORT_ERROR is not None:
        print(f"Warning: pywin32 unavailable: {WIN32PRINT_IMPORT_ERROR}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping print agent.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
