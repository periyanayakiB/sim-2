const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const token = process.env.JWT_TOKEN;

const dbConfig = {
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'zeon-dev-serverless.cuviqcx7bcl6.ap-south-1.rds.amazonaws.com',
    database: process.env.DB_NAME || 'zeon_staging',
    password: process.env.DB_PASSWORD || 'OciONDULPTiC',
    port: process.env.DB_PORT || 5432,
    ssl: {
        rejectUnauthorized: false
    }
};

const REMOTE_STOP_URL_BASE = 'https://hpyhkveb11.execute-api.ap-south-1.amazonaws.com/zeon-dev/api/v1/charging-sessions/stop';
const REMOTE_START_URL = 'https://hpyhkveb11.execute-api.ap-south-1.amazonaws.com/zeon-dev/api/v1/charging-sessions';
const REMOTE_CONTROL_TOKEN = `Bearer ${token}`;

module.exports = {
    dbConfig,
    REMOTE_STOP_URL_BASE,
    REMOTE_START_URL,
    REMOTE_CONTROL_TOKEN
};
