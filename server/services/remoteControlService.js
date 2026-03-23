const {
    REMOTE_STOP_URL_BASE,
    REMOTE_START_URL,
    REMOTE_CONTROL_TOKEN
} = require('../config');

async function triggerRemoteStop(sessionId) {
    const apiResponse = await fetch(`${REMOTE_STOP_URL_BASE}/${sessionId}`, {
        method: 'POST',
        headers: {
            accept: 'application/json, text/plain, */*',
            authorization: REMOTE_CONTROL_TOKEN,
            'content-type': 'application/json'
        },
        body: JSON.stringify({ closed_by: 'CSMS' })
    });

    return apiResponse.json();
}

async function triggerRemoteStart({ chargePointId, connectorId, userId, source = 'CSMS' }) {
    const response = await fetch(REMOTE_START_URL, {
        method: 'POST',
        headers: {
            accept: 'application/json, text/plain, */*',
            authorization: REMOTE_CONTROL_TOKEN,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            charge_point_id: chargePointId,
            connector_id: parseInt(connectorId, 10),
            user_id: userId,
            source
        })
    });

    return response.json();
}

module.exports = {
    triggerRemoteStop,
    triggerRemoteStart
};
