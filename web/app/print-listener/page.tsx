import type { Metadata } from "next";

import { PrintListenerClient } from "./PrintListenerClient";

export const metadata: Metadata = {
    title: "Print Listener",
};

export default function PrintListenerPage() {
    return <PrintListenerClient />;
}
