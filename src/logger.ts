type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const activeLevel: Level = (process.env.LOG_LEVEL as Level) || 'info';

/** Values that must never reach stdout, matched by key name. */
const SECRET_KEYS = /token|secret|password|authorization|api_key|apikey/i;

function redact(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v);
  }
  return out;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[activeLevel]) return;
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
  };
  if (meta) Object.assign(line, redact(meta) as Record<string, unknown>);
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
  /** Loud, unmissable banner for safety-critical state changes. */
  banner: (lines: string[]) => {
    const width = Math.max(...lines.map((l) => l.length)) + 4;
    const bar = '='.repeat(width);
    process.stdout.write(`\n${bar}\n`);
    for (const l of lines) process.stdout.write(`  ${l}\n`);
    process.stdout.write(`${bar}\n\n`);
  },
};
