// Web App File Handling API — not yet in lib.dom.d.ts as of TS 5.x.
// https://developer.mozilla.org/docs/Web/API/Window/launchQueue

interface LaunchParams {
    readonly targetURL?: string;
    readonly files: ReadonlyArray<FileSystemFileHandle>;
}

interface LaunchQueue {
    setConsumer(consumer: (params: LaunchParams) => unknown): void;
}

interface Window {
    readonly launchQueue?: LaunchQueue;
}
