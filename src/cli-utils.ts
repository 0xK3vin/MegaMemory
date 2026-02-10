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

export async function multiSelect(
  prompt: string,
  options: Array<{ label: string; value: string; description?: string }>
): Promise<string[]> {
  if (options.length === 0) return [];

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const answer = await ask(
      `${prompt}\n` +
      options
        .map((opt, idx) => `  ${idx + 1}. ${opt.label}${opt.description ? ` - ${opt.description}` : ""}`)
        .join("\n") +
      "\n\n  Enter numbers (comma-separated) or 'a' for all: "
    );

    if (answer.toLowerCase() === "a") {
      return options.map((opt) => opt.value);
    }

    const picks = new Set<string>();
    for (const piece of answer.split(",")) {
      const raw = piece.trim();
      if (!raw) continue;
      const index = parseInt(raw, 10);
      if (isNaN(index) || index < 1 || index > options.length) continue;
      picks.add(options[index - 1].value);
    }
    return [...picks];
  }

  const selected = new Array<boolean>(options.length).fill(false);
  let renderedLineCount = 0;

  const render = () => {
    const lines = [
      "",
      `  ${prompt}`,
      "",
      ...options.map((opt, idx) => {
        const check = selected[idx] ? "x" : " ";
        const number = String(idx + 1);
        const label = opt.label.padEnd(15);
        const desc = opt.description ? `  ${pc.dim(opt.description)}` : "";
        return `    [${check}] ${number}. ${label}${desc}`;
      }),
      "",
      `  ${pc.dim(`Toggle: 1-${options.length} | All: a | Confirm: Enter`)}`,
    ];

    if (renderedLineCount > 0) {
      process.stdout.write(`\r\x1b[${Math.max(renderedLineCount - 1, 0)}A\x1b[J`);
    }
    process.stdout.write(lines.join("\n"));
    renderedLineCount = lines.length;
  };

  return new Promise<string[]>((resolve) => {
    let finished = false;

    const cleanup = () => {
      if (!process.stdin.isTTY) return;
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h");
    };

    const finish = (values: string[]) => {
      if (finished) return;
      finished = true;
      cleanup();
      process.stdout.write("\n\n");
      resolve(values);
    };

    const onData = (chunk: string | Buffer) => {
      const input = chunk.toString("utf8");

      for (const ch of input) {
        if (ch === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }

        if (ch === "\r" || ch === "\n") {
          const values = options
            .filter((_, idx) => selected[idx])
            .map((opt) => opt.value);
          finish(values);
          return;
        }

        if (ch.toLowerCase() === "a") {
          const shouldSelectAll = selected.some((val) => !val);
          for (let i = 0; i < selected.length; i += 1) {
            selected[i] = shouldSelectAll;
          }
          render();
          continue;
        }

        const numeric = parseInt(ch, 10);
        if (!isNaN(numeric) && numeric >= 1 && numeric <= options.length) {
          const idx = numeric - 1;
          selected[idx] = !selected[idx];
          render();
        }
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdout.write("\x1b[?25l");
    render();
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
