"use client";
import { useCallback, useSyncExternalStore } from "react";
import type { FleetSnapshot } from "./fleet-spool";

const empty: FleetSnapshot = { jobs: [], stale: true };
const snapshots = new Map<string, FleetSnapshot>();
// Selections survive Edit/Print and printer switches, but not an app restart.
// The connector still validates that this roll is open and belongs to the IP.
const selectedRolls = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function publishFleetSnapshot(agent: string, snapshot?: FleetSnapshot) {
    snapshots.set(agent, snapshot ?? { jobs: snapshots.get(agent)?.jobs ?? [], stale: true });
    for (const listener of listeners) listener();
}
export function useFleetSnapshot(agent: string) {
    return useSyncExternalStore(subscribe, () => snapshots.get(agent) ?? empty, () => empty);
}

export function useProductionRollSelection(agent: string, host: string, port: number) {
    const key = JSON.stringify([agent, host.trim().toLowerCase(), port]);
    const rollId = useSyncExternalStore(subscribe, () => selectedRolls.get(key) ?? "", () => "");
    const select = useCallback((next: string, expected?: string) => {
        if (expected !== undefined && selectedRolls.get(key) !== expected) return;
        if (next) selectedRolls.set(key, next); else selectedRolls.delete(key);
        for (const listener of listeners) listener();
    }, [key]);
    return { rollId, select };
}
