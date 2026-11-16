type GtagFn = (...args: unknown[]) => void;

declare global {
    interface Window {
        gtag?: GtagFn;
        dataLayer?: unknown[];
    }
}

export type AnalyticsEvent =
    | "step_changed"
    | "template_selected"
    | "template_imported"
    | "template_exported"
    | "custom_template_deleted"
    | "template_saved"
    | "element_added"
    | "element_duplicated"
    | "element_deleted"
    | "elements_locked_toggled"
    | "undo"
    | "redo"
    | "zoom_changed"
    | "printer_connect_attempt"
    | "printer_connect_success"
    | "printer_connect_failed"
    | "printer_disconnect"
    | "print_started"
    | "print_succeeded"
    | "print_failed"
    | "print_cancelled"
    | "test_print_started"
    | "test_print_succeeded"
    | "test_print_failed"
    | "zpl_downloaded"
    | "pdf_export_started"
    | "pdf_export_completed"
    | "theme_changed";

export function track(event: AnalyticsEvent, params?: Record<string, unknown>): void {
    if (typeof window === "undefined") return;
    window.gtag?.("event", event, params);
}
