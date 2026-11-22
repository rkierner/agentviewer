export function scrub(input: string): string;
export function clip(s: string | undefined, n: number): string | undefined;
export function safeCommand(cmd: string | undefined, n?: number): string | undefined;
export function hostOf(url: string | undefined): string | undefined;
export function redactPayload(raw: unknown): Record<string, any>;
