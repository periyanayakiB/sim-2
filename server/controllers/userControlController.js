const { findLatestSession, stopActiveSessions } = require('../services/sessionService');
const { triggerRemoteStop, triggerRemoteStart } = require('../services/remoteControlService');

function validateChargePointAndConnector(body) {
    const { charge_point_id: chargePointId, connector_id: connectorId } = body;
    if (!chargePointId || !connectorId) {
        return { valid: false, error: 'Missing charge_point_id or connector_id' };
    }
    return { valid: true, chargePointId, connectorId };
}

async function stopFromUser(req, res) {
    const validation = validateChargePointAndConnector(req.body);
    if (!validation.valid) {
        return res.status(400).json({ success: false, message: validation.error });
    }

    const { chargePointId, connectorId } = validation;
    console.log(`[Server] Received stop request for CP ID: ${chargePointId}, Connector: ${connectorId}`);

    let remoteStopAttempted = false;
    let remoteStopResult = null;

    try {
        const session = await findLatestSession(chargePointId, connectorId);

        if (session?.ocpp_transaction_id && session.ocpp_transaction_id > 0) {
            console.log(`[Server] Found Session ID ${session.id} with Transaction ID ${session.ocpp_transaction_id}. Invoking Remote Stop...`);

            try {
                remoteStopAttempted = true;
                remoteStopResult = await triggerRemoteStop(session.id);
                console.log('[Server] Remote Stop API Response:', remoteStopResult);
            } catch (apiError) {
                console.error('[Server] Remote Stop API call failed:', apiError.message);
            }
        }

        console.log(`[Server] Applying manual DB update for ${chargePointId}:${connectorId} (Safeguard)`);
        const rowCount = await stopActiveSessions(chargePointId, connectorId);
        console.log(`[DB] Manual update complete for ${chargePointId}:${connectorId}. Rows affected: ${rowCount}`);

        return res.json({
            success: true,
            message: `Stop processed for CP ${chargePointId}:${connectorId}.`,
            remoteStop: {
                attempted: remoteStopAttempted,
                result: remoteStopResult
            },
            dbResult: { rowCount },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error(`[DB] Error in /stop route for ${chargePointId}:`, error.stack);
        return res.status(500).json({
            success: false,
            message: 'Failed to process stop request.',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
}

async function startFromUser(req, res) {
    const validation = validateChargePointAndConnector(req.body);
    if (!validation.valid) {
        return res.status(400).json({ success: false, message: validation.error });
    }

    const { chargePointId, connectorId } = validation;
    const { user_id: userId, source = 'CSMS' } = req.body;

    if (!userId) {
        return res.status(400).json({ success: false, message: 'Missing user_id' });
    }

    console.log(`[Server] Received start request for CP ID: ${chargePointId}, Connector: ${connectorId}, User: ${userId}`);

    try {
        console.log(`[Server] Triggering remote start for CP ID: ${chargePointId}, Connector: ${connectorId}, User: ${userId}`);
        const remoteStartResult = await triggerRemoteStart({
            chargePointId,
            connectorId,
            userId,
            source
        });
        console.log('[Server] Remote start result:', JSON.stringify(remoteStartResult, null, 2));        return res.json({
            success: true,
            message: `Start processed for CP ${chargePointId}:${connectorId}.`,
            remoteStart: {
                attempted: true,
                result: remoteStartResult
            },
            timestamp: new Date().toISOString()
        });
        console.log(`[Server] Response sent for CP ${chargePointId}:${connectorId}.`);
    } catch (error) {
        console.error(`[Server] Error in /start route for ${chargePointId}:`, error.stack);
        return res.status(500).json({
            success: false,
            message: 'Failed to process start request.',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
}

module.exports = {
    startFromUser,
    stopFromUser
};
