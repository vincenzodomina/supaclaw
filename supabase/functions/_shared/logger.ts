type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

function normalizeLogLevel(value: string | undefined): LogLevel {
  switch ((value ?? '').toLowerCase()) {
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
      return value!.toLowerCase() as LogLevel
    default:
      return 'info'
  }
}

const minLogLevel = normalizeLogLevel(Deno.env.get('LOG_LEVEL'))

function shouldLog(level: LogLevel) {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[minLogLevel]
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return error
}

function writeLog(
  level: LogLevel,
  message: string,
  meta: Record<string, unknown> = {},
) {
  if (!shouldLog(level)) return

  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...meta,
  }
  const line = JSON.stringify(payload)

  if (level === 'error') {
    console.error(line)
    return
  }
  if (level === 'warn') {
    console.warn(line)
    return
  }
  console.log(line)
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) =>
    writeLog('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) =>
    writeLog('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) =>
    writeLog('warn', message, meta),
  error: (
    message: string,
    meta?: Record<string, unknown> & { error?: unknown },
  ) =>
    writeLog('error', message, {
      ...meta,
      error: meta?.error ? serializeError(meta.error) : undefined,
    }),
}
