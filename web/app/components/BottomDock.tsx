"use client";

/* eslint-disable react-hooks/set-state-in-effect -- persisted dock dimensions are restored after hydration. */

import { memo, useEffect, useRef, useState } from "react";
import {
    ChevronDown,
    ChevronUp,
    Maximize2,
    Minimize2,
    Printer,
    ScanSearch,
    Table,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type {
    DataFeed,
    DesignerAction,
    LabelSettings,
    RfidSettings,
    SerialSettings,
} from "../types";
import { DataFeedSheet } from "./DataFeedSheet";
import { PrinterControlPanel } from "./PrinterControlPanel";
import { PrinterConfigPanel } from "./PrinterConfigPanel";
import type { PrinterSettings } from "../storage";

interface Props {
    settings: LabelSettings;
    printerSettings: PrinterSettings;
    onUpdatePrinterSettings: (patch: Partial<PrinterSettings>) => void;
    feed: DataFeed;
    feedOpen: boolean;
    feedFullscreen: boolean;
    previewRowId: string | null;
    serial?: SerialSettings;
    rfid?: RfidSettings;
    showDataTab?: boolean;
    showConfigTab?: boolean;
    showControlTab?: boolean;
    dispatch: React.Dispatch<DesignerAction>;
}

type Tab = "data" | "config" | "control";

const DOCK_HEIGHT_STORAGE_KEY = "nextwaves.bottomDock.bodyHeight";
const DEFAULT_DOCK_BODY_HEIGHT = 280;
const MIN_DOCK_BODY_HEIGHT = 140;

function maxDockBodyHeight() {
    if (typeof window === "undefined") return 520;
    const byViewport = Math.floor(window.innerHeight * 0.68);
    const keepWorkspaceVisible = window.innerHeight - 180;
    return Math.max(MIN_DOCK_BODY_HEIGHT, Math.min(byViewport, keepWorkspaceVisible));
}

function clampDockBodyHeight(height: number) {
    return Math.max(MIN_DOCK_BODY_HEIGHT, Math.min(maxDockBodyHeight(), Math.round(height)));
}

// Moving or editing canvas objects does not change the dock's data/settings.
// Keep the visible spreadsheet out of those render passes.
export const BottomDock = memo(function BottomDock({
    settings,
    printerSettings,
    onUpdatePrinterSettings,
    feed,
    feedOpen,
    feedFullscreen,
    previewRowId,
    serial,
    rfid,
    showDataTab = true,
    showConfigTab = true,
    showControlTab = true,
    dispatch,
}: Props) {
    const [activeTab, setActiveTab] = useState<Tab>(
        showDataTab ? "data" : showConfigTab ? "config" : "control",
    );
    const [configOpen, setConfigOpen] = useState(false);
    const [controlOpen, setControlOpen] = useState(false);
    const [fullscreenTab, setFullscreenTab] = useState<"config" | "control" | null>(null);
    const [dockBodyHeight, setDockBodyHeight] = useState(DEFAULT_DOCK_BODY_HEIGHT);
    const [dockMaxHeight, setDockMaxHeight] = useState(520);
    const dockBodyHeightRef = useRef(DEFAULT_DOCK_BODY_HEIGHT);

    const open =
        activeTab === "data"
            ? feedOpen
            : activeTab === "config"
              ? configOpen
              : controlOpen;
    const modalTab: Tab | null = showDataTab && feedFullscreen ? "data" : fullscreenTab;

    useEffect(() => {
        const stored = Number(window.localStorage.getItem(DOCK_HEIGHT_STORAGE_KEY));
        if (Number.isFinite(stored) && stored > 0) {
            const next = clampDockBodyHeight(stored);
            dockBodyHeightRef.current = next;
            setDockBodyHeight(next);
        }
    }, []);

    useEffect(() => {
        const syncMaxHeight = () => {
            const nextMax = maxDockBodyHeight();
            setDockMaxHeight(nextMax);
            setDockBodyHeight((current) => {
                const next = Math.min(current, nextMax);
                dockBodyHeightRef.current = next;
                return next;
            });
        };
        syncMaxHeight();
        window.addEventListener("resize", syncMaxHeight);
        return () => window.removeEventListener("resize", syncMaxHeight);
    }, []);

    useEffect(() => {
        dockBodyHeightRef.current = dockBodyHeight;
    }, [dockBodyHeight]);

    const setResizableDockHeight = (height: number) => {
        const next = clampDockBodyHeight(height);
        dockBodyHeightRef.current = next;
        setDockBodyHeight(next);
        try {
            window.localStorage.setItem(DOCK_HEIGHT_STORAGE_KEY, String(next));
        } catch {
            /* ignore storage failures */
        }
    };

    const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!open) return;
        e.preventDefault();
        const startY = e.clientY;
        const startHeight = dockBodyHeightRef.current;
        const prevCursor = document.body.style.cursor;
        const prevSelect = document.body.style.userSelect;
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";

        const onMove = (ev: PointerEvent) => {
            setResizableDockHeight(startHeight + (startY - ev.clientY));
        };
        const onUp = () => {
            document.body.style.cursor = prevCursor;
            document.body.style.userSelect = prevSelect;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    const onResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (!open) return;
        if (e.key === "ArrowUp") {
            e.preventDefault();
            setResizableDockHeight(dockBodyHeightRef.current + (e.shiftKey ? 80 : 24));
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setResizableDockHeight(dockBodyHeightRef.current - (e.shiftKey ? 80 : 24));
        } else if (e.key === "Home") {
            e.preventDefault();
            setResizableDockHeight(MIN_DOCK_BODY_HEIGHT);
        } else if (e.key === "End") {
            e.preventDefault();
            setResizableDockHeight(maxDockBodyHeight());
        }
    };

    const onClickData = () => {
        if (activeTab === "data") {
            dispatch({ type: "feed/setOpen", open: !feedOpen });
        } else {
            setActiveTab("data");
            dispatch({ type: "feed/setOpen", open: true });
        }
    };

    const onClickConfig = () => {
        if (activeTab === "config") {
            setConfigOpen((v) => !v);
        } else {
            setActiveTab("config");
            setConfigOpen(true);
        }
    };

    const onClickControl = () => {
        if (activeTab === "control") {
            setControlOpen((v) => !v);
        } else {
            setActiveTab("control");
            setControlOpen(true);
        }
    };

    const showDataPanel = activeTab === "data" && open;
    const showConfigPanel = activeTab === "config" && open;
    const showControlPanel = activeTab === "control" && open;
    const closeFullscreen = () => {
        if (showDataTab && feedFullscreen) {
            dispatch({ type: "feed/setFullscreen", fullscreen: false });
        }
        setFullscreenTab(null);
    };
    const openFullscreen = () => {
        if (!open) return;
        if (activeTab === "data") {
            dispatch({ type: "feed/setFullscreen", fullscreen: true });
        } else {
            setFullscreenTab(activeTab);
        }
    };

    return (
        <>
            <div className="isolate flex min-h-0 w-full shrink-0 flex-col overflow-hidden border-t border-border bg-muted overscroll-contain text-foreground">
                {open && (
                    <div
                        role="separator"
                        aria-label="Resize bottom panel"
                        aria-orientation="horizontal"
                        aria-valuemin={MIN_DOCK_BODY_HEIGHT}
                        aria-valuemax={dockMaxHeight}
                        aria-valuenow={dockBodyHeight}
                        tabIndex={0}
                        className="group flex h-1.5 cursor-row-resize items-center justify-center bg-muted outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset"
                        onPointerDown={onResizePointerDown}
                        onKeyDown={onResizeKeyDown}
                        onDoubleClick={() => setResizableDockHeight(DEFAULT_DOCK_BODY_HEIGHT)}
                        title="Drag to resize panel height. Double-click to reset."
                    >
                        <div className="h-0.5 w-12 rounded-full bg-foreground/15 transition-colors group-hover:bg-blue-500/60 dark:group-hover:bg-blue-400/70" />
                    </div>
                )}
                {/* Tab bar */}
                <div className="flex h-8 min-h-8 flex-shrink-0 items-center gap-1 overflow-hidden px-2 py-0.5">
                    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain">
                        {showDataTab && (
                            <TabBtn
                                active={activeTab === "data" && open}
                                onClick={onClickData}
                            >
                                {activeTab === "data" && open ? (
                                    <ChevronDown className="w-3.5 h-3.5" />
                                ) : (
                                    <ChevronUp className="w-3.5 h-3.5" />
                                )}
                                <Table className="w-3.5 h-3.5" />
                                <span className="text-xs uppercase tracking-wider font-semibold">
                                    Data Feed
                                    {feed.rows.length > 0 && (
                                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                                            ({feed.rows.length} rows)
                                        </span>
                                    )}
                                </span>
                            </TabBtn>
                        )}
                        {showConfigTab && (
                            <TabBtn
                                active={activeTab === "config" && open}
                                onClick={onClickConfig}
                            >
                                {activeTab === "config" && open ? (
                                    <ChevronDown className="w-3.5 h-3.5" />
                                ) : (
                                    <ChevronUp className="w-3.5 h-3.5" />
                                )}
                                <Printer className="w-3.5 h-3.5" />
                                <span className="text-xs uppercase tracking-wider font-semibold">
                                    Printer Config
                                </span>
                            </TabBtn>
                        )}
                        {showControlTab && (
                            <TabBtn
                                active={activeTab === "control" && open}
                                onClick={onClickControl}
                            >
                                {activeTab === "control" && open ? (
                                    <ChevronDown className="w-3.5 h-3.5" />
                                ) : (
                                    <ChevronUp className="w-3.5 h-3.5" />
                                )}
                                <ScanSearch className="w-3.5 h-3.5" />
                                <span className="text-xs uppercase tracking-wider font-semibold">
                                    Printer Control
                                </span>
                            </TabBtn>
                        )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                        {open && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={openFullscreen}
                                className="h-7"
                                title="View all"
                            >
                                <Maximize2 className="w-3.5 h-3.5" />
                                <span className="ml-1.5 hidden sm:inline text-xs">View all</span>
                            </Button>
                        )}
                    </div>
                </div>

                {/* Panel body */}
                {open && (
                    <div
                        className="min-h-0 overflow-hidden border-t border-border bg-background overscroll-contain"
                        style={{ height: dockBodyHeight }}
                    >
                        {showDataTab && showDataPanel && !feedFullscreen && (
                            <DataFeedSheet
                                feed={feed}
                                fullscreen={false}
                                previewRowId={previewRowId}
                                serial={serial}
                                rfid={rfid}
                                showFullscreenToggle={false}
                                dispatch={
                                    dispatch as unknown as React.Dispatch<
                                        { type: string } & Record<string, unknown>
                                    >
                                }
                            />
                        )}

                        {showConfigTab && showConfigPanel && (
                            <PrinterConfigPanel
                                settings={settings}
                                printerSettings={printerSettings}
                                onUpdatePrinterSettings={onUpdatePrinterSettings}
                                rfid={rfid}
                                onUpdateSettings={(patch, options) =>
                                    dispatch({
                                        type: "updateSettings",
                                        patch,
                                        resizePolicy: options?.resizePolicy,
                                    })
                                }
                                onUpdateRfid={(patch) =>
                                    dispatch({ type: "updateRfid", patch })
                                }
                            />
                        )}

                        {showControlTab && showControlPanel && (
                            <PrinterControlPanel printerSettings={printerSettings} />
                        )}
                    </div>
                )}
            </div>

            {/* Full-screen modal */}
            <Dialog
                open={modalTab !== null}
                onOpenChange={(v) => {
                    if (v) return;
                    closeFullscreen();
                }}
            >
                <DialogContent
                    showCloseButton={false}
                    className="p-0 gap-0 flex flex-col sm:rounded-lg overflow-hidden"
                    style={{
                        width: "95vw",
                        maxWidth: "95vw",
                        height: "95vh",
                        maxHeight: "95vh",
                    }}
                >
                    <DialogTitle className="sr-only">
                        {modalTab === "config"
                            ? "Printer Config"
                            : modalTab === "control"
                                ? "Printer Control"
                                : "Data Feed"}
                    </DialogTitle>
                    {modalTab && (
                        <FullscreenFrame
                            tab={modalTab}
                            rowCount={feed.rows.length}
                            columnCount={feed.columns.length}
                            onClose={closeFullscreen}
                        >
                            {showDataTab && modalTab === "data" && (
                                <DataFeedSheet
                                    feed={feed}
                                    fullscreen={true}
                                    previewRowId={previewRowId}
                                    serial={serial}
                                    rfid={rfid}
                                    showFullscreenToggle={false}
                                    dispatch={
                                        dispatch as unknown as React.Dispatch<
                                            { type: string } & Record<string, unknown>
                                        >
                                    }
                                />
                            )}
                            {showConfigTab && modalTab === "config" && (
                                <PrinterConfigPanel
                                    settings={settings}
                                    printerSettings={printerSettings}
                                    onUpdatePrinterSettings={onUpdatePrinterSettings}
                                    rfid={rfid}
                                    fullscreen
                                    onUpdateSettings={(patch, options) =>
                                        dispatch({
                                            type: "updateSettings",
                                            patch,
                                            resizePolicy: options?.resizePolicy,
                                        })
                                    }
                                    onUpdateRfid={(patch) =>
                                        dispatch({ type: "updateRfid", patch })
                                    }
                                />
                            )}
                            {showControlTab && modalTab === "control" && (
                                <PrinterControlPanel
                                    printerSettings={printerSettings}
                                    fullscreen
                                />
                            )}
                        </FullscreenFrame>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
});

function FullscreenFrame({
    tab,
    rowCount,
    columnCount,
    onClose,
    children,
}: {
    tab: Tab;
    rowCount: number;
    columnCount: number;
    onClose: () => void;
    children: React.ReactNode;
}) {
    const iconClass = "h-4 w-4 text-muted-foreground";
    const title =
        tab === "config"
            ? "Printer Config"
            : tab === "control"
                ? "Printer Control"
                : "Data Feed";
    const meta =
        tab === "config"
            ? "Media, print and RFID setup"
            : tab === "control"
                ? "Feed, pause and printer status"
                : `${rowCount} rows · ${columnCount} cols`;
    const Icon =
        tab === "config"
            ? Printer
            : tab === "control"
                ? ScanSearch
                : Table;

    return (
        <div className="flex h-full min-h-0 flex-col bg-background">
            <div className="flex min-h-12 flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                <Icon className={iconClass} />
                <div className="min-w-0">
                    <div className="truncate text-xs font-semibold uppercase tracking-wider text-foreground">
                        {title}
                    </div>
                    <div className="truncate text-[11px] font-mono text-muted-foreground">
                        {meta}
                    </div>
                </div>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={onClose}
                    className="ml-auto h-8"
                    title="Close full-screen panel"
                >
                    <Minimize2 className="w-3.5 h-3.5" />
                    <span className="ml-1.5 text-xs">Close</span>
                </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </div>
    );
}

function TabBtn({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            data-active={active ? "true" : "false"}
            className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border px-2 py-1 transition-colors",
                active
                    ? "border-border bg-accent text-accent-foreground shadow-sm"
                    : "border-transparent text-muted-foreground hover:border-border/70 hover:bg-accent/70 hover:text-accent-foreground",
            )}
        >
            {children}
        </button>
    );
}
