const { Client } = require('pg');
const { dbConfig } = require('../config');

async function withDbClient(work) {
    const client = new Client(dbConfig);
    try {
        await client.connect();
        return await work(client);
    } finally {
        await client.end();
    }
}

async function findLatestSession(chargePointId, connectorId) {
    const query = `
        SELECT id, ocpp_transaction_id
        FROM public.saev_charging_session
        WHERE charge_point_id IN (
            SELECT id FROM public.saev_charge_point WHERE ocpp_charge_point_id = $1
        ) AND connector_id = $2
        ORDER BY id DESC
        LIMIT 1
    `;

    return withDbClient(async (client) => {
        const res = await client.query(query, [chargePointId, parseInt(connectorId, 10)]);
        return res.rows[0] || null;
    });
}

async function stopActiveSessions(chargePointId, connectorId) {
    const query = `
        UPDATE public.saev_charging_session
        SET
            status = 'STOPPED',
            end_time = COALESCE(end_time, NOW()),
            updated_at = NOW()
        WHERE charge_point_id IN (
            SELECT id FROM public.saev_charge_point WHERE ocpp_charge_point_id = $1
        ) AND connector_id = $2 AND status != 'STOPPED'
    `;

    return withDbClient(async (client) => {
        const res = await client.query(query, [chargePointId, parseInt(connectorId, 10)]);
        return res.rowCount;
    });
}

module.exports = {
    findLatestSession,
    stopActiveSessions
};
