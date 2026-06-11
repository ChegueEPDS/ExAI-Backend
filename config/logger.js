const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const logger = createLogger({
  level,
  format: format.combine(
    format.timestamp(),
    format.json(),
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf((info) => {
          const { level, message, timestamp, ...rest } = info || {};
          const metaKeys = Object.keys(rest || {}).filter(k => rest[k] !== undefined);
          const meta = metaKeys.length ? ` ${JSON.stringify(rest)}` : '';
          return `${timestamp} [${level}]: ${message}${meta}`;
        })
      )
    }),
    new DailyRotateFile({
      filename: 'logs/application-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
    }),
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      level: 'error',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
    }),
  ],
});

module.exports = logger;
