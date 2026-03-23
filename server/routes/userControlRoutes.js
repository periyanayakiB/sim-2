const express = require('express');
const { startFromUser, stopFromUser } = require('../controllers/userControlController');

const router = express.Router();

router.post('/start', startFromUser);
router.post('/stop', stopFromUser);

module.exports = router;
