"use client";

import { cn } from "@/lib/utils";

export type Step = "choose" | "edit" | "print";

interface Props {
    current: Step;
    canVisit: Record<Step, boolean>;
    onJump: (step: Step) => void;
}

const ORDER: Step[] = ["choose", "edit", "print"];
const LABELS: Record<Step, string> = {
    choose: "Choose",
    edit: "Edit",
    print: "Print",
};

function indexOf(step: Step): number {
    return ORDER.indexOf(step);
}

export function Stepper({ current, canVisit, onJump }: Props) {
    const currentIdx = indexOf(current);
    return (
        <ol className="flex items-center gap-2">
            {ORDER.map((step, idx) => {
                const isCurrent = step === current;
                const isPast = idx < currentIdx;
                const isFuture = idx > currentIdx;
                const enabled = canVisit[step] && !isCurrent;
                return (
                    <li key={step} className="flex items-center gap-2">
                        <button
                            type="button"
                            disabled={!enabled}
                            onClick={() => enabled && onJump(step)}
                            className={cn(
                                "flex items-center gap-2 h-9 px-3 rounded-full text-sm font-medium transition-all",
                                isCurrent &&
                                    "bg-primary text-primary-foreground shadow-sm ring-2 ring-primary/40",
                                isPast &&
                                    "bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer",
                                isFuture &&
                                    "bg-muted text-muted-foreground cursor-not-allowed opacity-60",
                            )}
                        >
                            <span
                                className={cn(
                                    "flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-bold",
                                    isCurrent
                                        ? "bg-white/25"
                                        : "bg-muted-foreground/20",
                                )}
                            >
                                {idx + 1}
                            </span>
                            <span>{LABELS[step]}</span>
                        </button>
                        {idx < ORDER.length - 1 && (
                            <div
                                className={cn(
                                    "w-6 h-px",
                                    idx < currentIdx
                                        ? "bg-primary/40"
                                        : "bg-border",
                                )}
                            />
                        )}
                    </li>
                );
            })}
        </ol>
    );
}
