function receiveStatusNotification(req, res) {
    const {
        charge_point_id: chargePointId,
        connector_id: connectorId,
        status,
        timestamp
    } = req.body;

    if (!chargePointId || !connectorId || !status) {
        return res.status(400).json({
            success: false,
            message: 'Missing charge_point_id, connector_id, or status'
        });
    }

    console.log(`[ChargerEvent] StatusNotification ${chargePointId}:${connectorId} -> ${status} @ ${timestamp || new Date().toISOString()}`);

    return res.json({
        success: true,
        message: 'StatusNotification received',
        timestamp: new Date().toISOString()
    });
}

function receiveMeterValues(req, res) {
    const {
        charge_point_id: chargePointId,
        connector_id: connectorId,
        transaction_id: transactionId,
        meter_values: meterValues
    } = req.body;

    if (!chargePointId || !connectorId || !meterValues) {
        return res.status(400).json({
            success: false,
            message: 'Missing charge_point_id, connector_id, or meter_values'
        });
    }

    console.log(
        `[ChargerEvent] MeterValues ${chargePointId}:${connectorId} Tx:${transactionId || 'N/A'} Samples:${Array.isArray(meterValues) ? meterValues.length : 1}`
    );

    return res.json({
        success: true,
        message: 'MeterValues received',
        timestamp: new Date().toISOString()
    });
}

module.exports = {
    receiveStatusNotification,
    receiveMeterValues
};
