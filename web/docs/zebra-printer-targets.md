# Zebra printer targets and transport behavior

## Coordinate model

Templates store physical geometry in millimetres. Changing printhead DPI must not
change an object's physical position or size. The selected DPI changes only the
printer-dot grid used by rasterization and ZPL compilation:

| Printhead | Project grid | 60 x 40 mm output |
| --- | ---: | ---: |
| 203 dpi | 8 dots/mm | 480 x 320 dots |
| 300 dpi | 12 dots/mm | 720 x 480 dots |
| 600 dpi | 24 dots/mm | 1440 x 960 dots |

The editor's `1 dot = 1 px` view makes the selected grid visible on screen. The
physical WYSIWYG/Fit view keeps the label fitted while preserving millimetres.

## Validated printer catalog

| Model | Supported heads | Max print width | Max speed by head |
| --- | --- | --- | --- |
| Zebra ZT610R | 203 / 300 / 600 dpi | 104 mm | 14 / 12 / 6 ips |
| Zebra ZD621R | 203 / 300 dpi | 104 mm at 203; 108 mm at 300 | 8 / 6 ips |

`Auto / Other Zebra Link-OS` remains available for legacy templates, but it does
not assert a model-specific width or speed limit. Add verified limits to
`app/printer-models.ts` before treating another model as fully validated.

## Transport capability matrix

| Transport | Print/SET | GET/status | Delivery semantics |
| --- | --- | --- | --- |
| COM / Web Serial | Yes | Yes | Direct; the write itself is not read-back verification |
| TCP/IP (normally port 9100) | Yes | Yes | Direct; SGD/ZPL response can be read |
| Windows RAW queue (USB or TCP-backed spooler) | Yes | No | Queued and unverified |

A Windows printer queue is intentionally treated as write-only even if its port
is network-backed. Select direct TCP/IP when status or configuration read-back is
required. Queueing a command means Windows accepted a RAW job; it does not prove
that the printer applied the command.

## Identity and media read order

1. Read identity/resolution (`~HI`) or the Link-OS head-resolution SGD value.
2. Resolve the installed head to 203, 300, or 600 dpi.
3. Read media settings.
4. Convert `^PW`/`^LL` dots with the detected 8/12/24 dots-per-mm grid.
5. Apply media geometry while keeping existing objects at their physical size.

RFID settings are accepted only when `rfid.reader_1.model` returns a usable
value. Unsupported `?` SGD responses no longer create a false calibrated state.

## Configuration persistence

The current SET actions are job/runtime commands. They do not automatically send
`^JUS` to save settings in printer non-volatile memory. Persistence must remain an
explicit user action because it changes the physical printer's stored defaults.

## Integration routing

Printer aliases carry authoritative `modelId` and `dpi` metadata. The browser
listener and native route apply this explicit target before compiling. Queue-name
resolution is used only as a mismatch guard; it is never allowed to silently
rewrite a template/job DPI.

