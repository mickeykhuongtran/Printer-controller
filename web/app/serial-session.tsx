"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import {
    disconnect as closeSerialPort,
    isWebSerialSupported,
    openSelectedPort,
    selectPort as requestSerialPort,
    type ConnectedPort,
    type SelectedPort,
} from "./webserial";
import type { SerialFlowControl } from "./storage";

export type SerialSessionAction = "select" | "connect" | "disconnect" | null;

type SerialSessionValue = {
    supported: boolean;
    selectedPort: SelectedPort | null;
    connection: ConnectedPort | null;
    action: SerialSessionAction;
    selectPort: () => Promise<SelectedPort>;
    connect: (
        baudRate: number,
        flowControl?: SerialFlowControl,
    ) => Promise<ConnectedPort>;
    disconnect: () => Promise<void>;
};

const SerialSessionContext = createContext<SerialSessionValue | null>(null);

export function SerialSessionProvider({ children }: { children: ReactNode }) {
    const [supported] = useState(() => isWebSerialSupported());
    const [selectedPort, setSelectedPort] = useState<SelectedPort | null>(null);
    const [connection, setConnection] = useState<ConnectedPort | null>(null);
    const [action, setAction] = useState<SerialSessionAction>(null);
    const connectionRef = useRef<ConnectedPort | null>(null);

    useEffect(() => {
        return () => {
            if (connectionRef.current) {
                void closeSerialPort(connectionRef.current);
                connectionRef.current = null;
            }
        };
    }, []);

    const selectPort = useCallback(async () => {
        if (connectionRef.current) {
            throw new Error("Disconnect the current COM port before selecting another port.");
        }
        setAction("select");
        try {
            const selected = await requestSerialPort();
            setSelectedPort(selected);
            return selected;
        } finally {
            setAction(null);
        }
    }, []);

    const connect = useCallback(async (
        baudRate: number,
        flowControl: SerialFlowControl = "none",
    ) => {
        if (connectionRef.current) return connectionRef.current;
        if (!selectedPort) throw new Error("Select a COM port first.");
        setAction("connect");
        try {
            const connected = await openSelectedPort(selectedPort, baudRate, flowControl);
            connectionRef.current = connected;
            setConnection(connected);
            return connected;
        } finally {
            setAction(null);
        }
    }, [selectedPort]);

    const disconnect = useCallback(async () => {
        const connected = connectionRef.current;
        if (!connected) return;
        setAction("disconnect");
        try {
            await closeSerialPort(connected);
            connectionRef.current = null;
            setConnection(null);
        } finally {
            setAction(null);
        }
    }, []);

    return (
        <SerialSessionContext.Provider
            value={{
                supported,
                selectedPort,
                connection,
                action,
                selectPort,
                connect,
                disconnect,
            }}
        >
            {children}
        </SerialSessionContext.Provider>
    );
}

export function useSerialSession(): SerialSessionValue {
    const value = useContext(SerialSessionContext);
    if (!value) {
        throw new Error("useSerialSession must be used inside SerialSessionProvider.");
    }
    return value;
}
