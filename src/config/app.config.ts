import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  database: {
    autoSave: process.env.DB_AUTO_SAVE === 'true',
    location: process.env.DB_LOCATION || 'time-off.db',
    logging: process.env.DB_LOGGING === 'true',
  },
  hcm: {
    baseUrl: process.env.HCM_BASE_URL || 'http://localhost:4000',
    apiKey: process.env.HCM_API_KEY || 'hcm-api-key',
    timeoutMs: parseInt(process.env.HCM_TIMEOUT_MS || '5000', 10),
    batchSyncCron: process.env.HCM_BATCH_SYNC_CRON || '0 2 * * *',
  },
}));
