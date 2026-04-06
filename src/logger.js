const { createLogger, format, transports } = require('winston');

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}`
    )
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'bot.log', maxsize: 5_000_000, maxFiles: 3 }),
  ],
});

module.exports = logger;
