import pc from "picocolors";
import { createInterface } from "readline";

// ---- Styled output helpers ----

export function error(msg: string): void {
  console.error(pc.red(`  ✗ ${msg}`));
}

export function errorBold(msg: string): void {
  console.error(pc.red(pc.bold(`Error: ${msg}`)));
}

export function warn(msg: string): void {
  console.log(pc.yellow(`  ⚠ ${msg}`));
}

export function success(msg: string): void {
  console.log(pc.green(`  ✓ ${msg}`));
}

export function skip(msg: string): void {
  console.log(pc.dim(`  – ${msg}`));
}

export function info(msg: string): void {
  console.log(pc.dim(`  ${msg}`));
}

export function heading(msg: string): void {
  console.log(pc.bold(msg));
}

// ---- Interactive prompts ----

export function ask(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt the user for a port when the current one is in use.
 * Returns the chosen port number, or null if the user wants to cancel.
 */
export async function askPort(currentPort: number): Promise<number | null> {
  // Loop instead of recursion to avoid stack overflow on repeated invalid input
  while (true) {
    const suggested = currentPort + 1;
    const answer = await ask(
      pc.yellow(`  Port ${pc.bold(String(currentPort))} is already in use.\n`) +
      `  Enter a different port ${pc.dim(`(Enter for ${suggested}, q to quit)`)}: `
    );

    if (answer === "" || answer === undefined) return suggested;
    if (answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") return null;

    const parsed = parseInt(answer, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.log(pc.red(`  Invalid port '${answer}'. Must be a number between 1 and 65535.`));
      continue;
    }
    return parsed;
  }
}

/**
 * Validate a port number. Returns an error message or null if valid.
 */
export function validatePort(value: unknown, rawInput?: string): string | null {
  if (typeof value === "number" && !isNaN(value) && value >= 1 && value <= 65535) {
    return null;
  }
  const display = rawInput ?? String(value);
  return `Invalid port '${display}'. Port must be a number between 1 and 65535.`;
}
