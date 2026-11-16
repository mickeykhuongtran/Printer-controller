// Excel-style formula engine for the data feed.
// Pure module — no React deps. Public surface: `evaluateExpression(src, ctx)`.

import { encodeSgtin96FromBarcode } from "./rfid";

export type FormulaValue = string | number | boolean;

export type FormulaError = {
    error: true;
    code: "PARSE" | "REF" | "CYCLE" | "FN" | "ARG" | "TYPE";
    message: string;
};

export type FormulaResult = FormulaValue | FormulaError;

export function isFormulaError(v: FormulaResult): v is FormulaError {
    return typeof v === "object" && v !== null && (v as FormulaError).error === true;
}

export type EvalContext = {
    rowIndex: number;
    rowCount: number;
    resolveVar: (name: string) => FormulaResult;
};

// ── Tokenizer ─────────────────────────────────────────────────────────────

type TokKind =
    | "num"
    | "str"
    | "ident"
    | "var"
    | "lparen"
    | "rparen"
    | "comma"
    | "op";

type Tok = { kind: TokKind; value: string };

function tokenize(src: string): Tok[] | FormulaError {
    const tokens: Tok[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) {
            i += 1;
            continue;
        }
        if (c === "(" || c === ")" || c === "," || c === ";") {
            // `;` is accepted as an argument separator alongside `,` (some
            // locales use it as the default in Google Sheets / Excel).
            tokens.push({
                kind: c === "(" ? "lparen" : c === ")" ? "rparen" : "comma",
                value: c,
            });
            i += 1;
            continue;
        }
        // Multi-char ops first
        if (src.startsWith("<=", i) || src.startsWith(">=", i) || src.startsWith("<>", i)) {
            tokens.push({ kind: "op", value: src.slice(i, i + 2) });
            i += 2;
            continue;
        }
        if ("+-*/%&^=<>".includes(c)) {
            tokens.push({ kind: "op", value: c });
            i += 1;
            continue;
        }
        // String literal: "..." or '...'
        if (c === '"' || c === "'") {
            const quote = c;
            i += 1;
            let s = "";
            while (i < src.length && src[i] !== quote) {
                if (src[i] === "\\" && i + 1 < src.length) {
                    s += src[i + 1];
                    i += 2;
                } else {
                    s += src[i];
                    i += 1;
                }
            }
            if (src[i] !== quote) {
                return { error: true, code: "PARSE", message: "Unterminated string" };
            }
            i += 1;
            tokens.push({ kind: "str", value: s });
            continue;
        }
        // Number
        if (/[0-9]/.test(c)) {
            let s = "";
            while (i < src.length && /[0-9.]/.test(src[i])) {
                s += src[i];
                i += 1;
            }
            tokens.push({ kind: "num", value: s });
            continue;
        }
        // Variable reference: {name}
        if (c === "{") {
            i += 1;
            let s = "";
            while (i < src.length && src[i] !== "}") {
                s += src[i];
                i += 1;
            }
            if (src[i] !== "}") {
                return { error: true, code: "PARSE", message: "Unterminated {var}" };
            }
            i += 1;
            tokens.push({ kind: "var", value: s });
            continue;
        }
        // Identifier (function name, true/false)
        if (/[A-Za-z_]/.test(c)) {
            let s = "";
            while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) {
                s += src[i];
                i += 1;
            }
            tokens.push({ kind: "ident", value: s });
            continue;
        }
        return {
            error: true,
            code: "PARSE",
            message: `Unexpected character "${c}" at position ${i}`,
        };
    }
    return tokens;
}

// ── Parser (Pratt) ────────────────────────────────────────────────────────

type Node =
    | { type: "num"; value: number }
    | { type: "str"; value: string }
    | { type: "bool"; value: boolean }
    | { type: "var"; name: string }
    | { type: "call"; name: string; args: Node[] }
    | { type: "unary"; op: string; arg: Node }
    | { type: "bin"; op: string; lhs: Node; rhs: Node };

class Parser {
    pos = 0;
    constructor(private tokens: Tok[]) {}
    peek() {
        return this.tokens[this.pos];
    }
    next() {
        return this.tokens[this.pos++];
    }
    expect(kind: TokKind, value?: string) {
        const t = this.next();
        if (!t || t.kind !== kind || (value !== undefined && t.value !== value)) {
            throw new Error(
                `Expected ${value ?? kind} but got ${t?.value ?? "EOF"}`,
            );
        }
        return t;
    }

    parse(): Node {
        const expr = this.parseExpr(0);
        if (this.pos < this.tokens.length) {
            throw new Error(`Unexpected token "${this.tokens[this.pos].value}"`);
        }
        return expr;
    }

    parseExpr(minBP: number): Node {
        let left = this.parsePrefix();
        while (true) {
            const t = this.peek();
            if (!t) break;
            if (t.kind !== "op") break;
            const bp = OP_BP[t.value];
            if (!bp || bp.lbp < minBP) break;
            this.next();
            const right = this.parseExpr(bp.rbp);
            left = { type: "bin", op: t.value, lhs: left, rhs: right };
        }
        return left;
    }

    parsePrefix(): Node {
        const t = this.next();
        if (!t) throw new Error("Unexpected end of expression");
        if (t.kind === "num") return { type: "num", value: parseFloat(t.value) };
        if (t.kind === "str") return { type: "str", value: t.value };
        if (t.kind === "var") return { type: "var", name: t.value };
        if (t.kind === "lparen") {
            const inner = this.parseExpr(0);
            this.expect("rparen");
            return inner;
        }
        if (t.kind === "op" && (t.value === "-" || t.value === "+")) {
            const arg = this.parseExpr(100);
            return { type: "unary", op: t.value, arg };
        }
        if (t.kind === "ident") {
            // Boolean literals
            if (t.value.toUpperCase() === "TRUE") return { type: "bool", value: true };
            if (t.value.toUpperCase() === "FALSE") return { type: "bool", value: false };
            // Function call
            if (this.peek()?.kind === "lparen") {
                this.next();
                const args: Node[] = [];
                if (this.peek()?.kind !== "rparen") {
                    args.push(this.parseExpr(0));
                    while (this.peek()?.kind === "comma") {
                        this.next();
                        args.push(this.parseExpr(0));
                    }
                }
                this.expect("rparen");
                return { type: "call", name: t.value.toUpperCase(), args };
            }
            // Bare ident — treat as variable
            return { type: "var", name: t.value };
        }
        throw new Error(`Unexpected token "${t.value}"`);
    }
}

const OP_BP: Record<string, { lbp: number; rbp: number }> = {
    "=": { lbp: 5, rbp: 5 },
    "<>": { lbp: 5, rbp: 5 },
    "<": { lbp: 5, rbp: 5 },
    "<=": { lbp: 5, rbp: 5 },
    ">": { lbp: 5, rbp: 5 },
    ">=": { lbp: 5, rbp: 5 },
    "&": { lbp: 10, rbp: 11 },
    "+": { lbp: 20, rbp: 21 },
    "-": { lbp: 20, rbp: 21 },
    "*": { lbp: 30, rbp: 31 },
    "/": { lbp: 30, rbp: 31 },
    "%": { lbp: 30, rbp: 31 },
    "^": { lbp: 40, rbp: 39 },
};

// ── Coercion helpers ──────────────────────────────────────────────────────

function toNum(v: FormulaValue): number {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : NaN;
}

function toStr(v: FormulaValue): string {
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (Number.isInteger(v)) return String(v);
    return String(v);
}

function toBool(v: FormulaValue): boolean {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    return v.length > 0 && v !== "0" && v.toUpperCase() !== "FALSE";
}

// ── Built-in functions ────────────────────────────────────────────────────

type FnImpl = (args: FormulaValue[], ctx: EvalContext) => FormulaResult;

function argCount(name: string, args: FormulaValue[], min: number, max?: number): FormulaError | null {
    const cap = max ?? min;
    if (args.length < min || args.length > cap) {
        return {
            error: true,
            code: "ARG",
            message: `${name}() expects ${min}${cap !== min ? "–" + cap : ""} arguments`,
        };
    }
    return null;
}

const FUNCS: Record<string, FnImpl> = {
    ROW: (args, ctx) => ctx.rowIndex + 1,
    STEP: (args, ctx) => ctx.rowIndex + 1,
    N: (args, ctx) => ctx.rowIndex + 1,
    PAD: (args) => {
        const err = argCount("PAD", args, 2, 3);
        if (err) return err;
        const s = toStr(args[0]);
        const w = Math.floor(toNum(args[1]));
        const ch = args[2] !== undefined ? toStr(args[2]) : "0";
        if (s.length >= w) return s;
        return ch.repeat(w - s.length) + s;
    },
    CONCAT: (args) => args.map(toStr).join(""),
    UPPER: (args) => {
        const err = argCount("UPPER", args, 1);
        if (err) return err;
        return toStr(args[0]).toUpperCase();
    },
    LOWER: (args) => {
        const err = argCount("LOWER", args, 1);
        if (err) return err;
        return toStr(args[0]).toLowerCase();
    },
    LEFT: (args) => {
        const err = argCount("LEFT", args, 1, 2);
        if (err) return err;
        const s = toStr(args[0]);
        const n = args[1] !== undefined ? Math.floor(toNum(args[1])) : 1;
        return s.slice(0, Math.max(0, n));
    },
    RIGHT: (args) => {
        const err = argCount("RIGHT", args, 1, 2);
        if (err) return err;
        const s = toStr(args[0]);
        const n = args[1] !== undefined ? Math.floor(toNum(args[1])) : 1;
        return n <= 0 ? "" : s.slice(-n);
    },
    MID: (args) => {
        const err = argCount("MID", args, 3);
        if (err) return err;
        const s = toStr(args[0]);
        const start = Math.max(0, Math.floor(toNum(args[1])) - 1);
        const len = Math.max(0, Math.floor(toNum(args[2])));
        return s.slice(start, start + len);
    },
    LEN: (args) => {
        const err = argCount("LEN", args, 1);
        if (err) return err;
        return toStr(args[0]).length;
    },
    IF: (args) => {
        const err = argCount("IF", args, 2, 3);
        if (err) return err;
        return toBool(args[0]) ? args[1] : args[2] ?? "";
    },
    SGTIN: (args) => {
        const err = argCount("SGTIN", args, 2, 4);
        if (err) return err;
        const barcode = toStr(args[0]);
        const serial = toStr(args[1]);
        const filter = args[2] !== undefined ? Math.floor(toNum(args[2])) : 1;
        const partition = args[3] !== undefined ? Math.floor(toNum(args[3])) : undefined;
        const result = encodeSgtin96FromBarcode(barcode, serial, filter, partition);
        if ("error" in result) {
            return { error: true, code: "FN", message: `SGTIN: ${result.error}` };
        }
        return result.hex;
    },
    EAN13_CHECK: (args) => {
        const err = argCount("EAN13_CHECK", args, 1);
        if (err) return err;
        const digits = toStr(args[0]).replace(/\D/g, "");
        if (digits.length !== 12) {
            return {
                error: true,
                code: "ARG",
                message: "EAN13_CHECK expects 12 digits",
            };
        }
        let sum = 0;
        for (let i = 0; i < 12; i += 1) {
            sum += parseInt(digits[i], 10) * (i % 2 === 0 ? 1 : 3);
        }
        return String((10 - (sum % 10)) % 10);
    },
    GTIN_CHECK: (args) => {
        const err = argCount("GTIN_CHECK", args, 1);
        if (err) return err;
        const digits = toStr(args[0]).replace(/\D/g, "");
        if (digits.length === 0) {
            return { error: true, code: "ARG", message: "GTIN_CHECK needs digits" };
        }
        // Mod-10: rightmost (excluding check) is weighted 3, alternating.
        let sum = 0;
        for (let i = 0; i < digits.length; i += 1) {
            const d = parseInt(digits[digits.length - 1 - i], 10);
            sum += d * (i % 2 === 0 ? 3 : 1);
        }
        return String((10 - (sum % 10)) % 10);
    },
};

// ── Evaluator ─────────────────────────────────────────────────────────────

function evalNode(node: Node, ctx: EvalContext): FormulaResult {
    switch (node.type) {
        case "num":
            return node.value;
        case "str":
            return node.value;
        case "bool":
            return node.value;
        case "var":
            return ctx.resolveVar(node.name);
        case "unary": {
            const v = evalNode(node.arg, ctx);
            if (isFormulaError(v)) return v;
            if (node.op === "-") return -toNum(v);
            return toNum(v);
        }
        case "bin": {
            const l = evalNode(node.lhs, ctx);
            if (isFormulaError(l)) return l;
            const r = evalNode(node.rhs, ctx);
            if (isFormulaError(r)) return r;
            return applyBin(node.op, l, r);
        }
        case "call": {
            const fn = FUNCS[node.name];
            if (!fn) {
                return { error: true, code: "FN", message: `Unknown function ${node.name}` };
            }
            const argVals: FormulaValue[] = [];
            for (const a of node.args) {
                const v = evalNode(a, ctx);
                if (isFormulaError(v)) return v;
                argVals.push(v);
            }
            return fn(argVals, ctx);
        }
    }
}

function applyBin(op: string, l: FormulaValue, r: FormulaValue): FormulaResult {
    switch (op) {
        case "+":
            return toNum(l) + toNum(r);
        case "-":
            return toNum(l) - toNum(r);
        case "*":
            return toNum(l) * toNum(r);
        case "/": {
            const d = toNum(r);
            if (d === 0) return { error: true, code: "ARG", message: "Divide by zero" };
            return toNum(l) / d;
        }
        case "%":
            return toNum(l) % toNum(r);
        case "^":
            return Math.pow(toNum(l), toNum(r));
        case "&":
            return toStr(l) + toStr(r);
        case "=":
            return cmp(l, r) === 0;
        case "<>":
            return cmp(l, r) !== 0;
        case "<":
            return cmp(l, r) < 0;
        case "<=":
            return cmp(l, r) <= 0;
        case ">":
            return cmp(l, r) > 0;
        case ">=":
            return cmp(l, r) >= 0;
    }
    return { error: true, code: "PARSE", message: `Unknown operator ${op}` };
}

function cmp(a: FormulaValue, b: FormulaValue): number {
    if (typeof a === "number" && typeof b === "number") return a - b;
    const an = parseFloat(toStr(a));
    const bn = parseFloat(toStr(b));
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return toStr(a).localeCompare(toStr(b));
}

// ── Public ────────────────────────────────────────────────────────────────

export function evaluateExpression(src: string, ctx: EvalContext): FormulaResult {
    const stripped = src.startsWith("=") ? src.slice(1) : src;
    const toks = tokenize(stripped);
    if (!Array.isArray(toks)) return toks;
    if (toks.length === 0) return "";
    const parser = new Parser(toks);
    let ast: Node;
    try {
        ast = parser.parse();
    } catch (e) {
        return {
            error: true,
            code: "PARSE",
            message: e instanceof Error ? e.message : "Parse error",
        };
    }
    return evalNode(ast, ctx);
}

export function formatFormulaValue(v: FormulaResult): string {
    if (isFormulaError(v)) {
        return `#${v.code}`;
    }
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (typeof v === "number") {
        if (Number.isInteger(v)) return String(v);
        return String(v);
    }
    return v;
}
