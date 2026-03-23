const express = require('express');
const {
    receiveStatusNotification,
    receiveMeterValues
} = require('../controllers/chargerEventsController');

const router = express.Router();

router.post('/charger/status-notification', receiveStatusNotification);
router.post('/charger/meter-values', receiveMeterValues);

module.exports = router;
