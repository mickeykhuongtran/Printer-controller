import type { Metadata } from "next";

import { PrinterConfigClient } from "./PrinterConfigClient";

export const metadata: Metadata = {
    title: "Printer Config",
};

export default function PrinterConfigPage() {
    return <PrinterConfigClient />;
}
