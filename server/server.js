const express = require('express');
const userControlRoutes = require('./routes/userControlRoutes');
const chargerEventRoutes = require('./routes/chargerEventRoutes');

const app = express();
const port = 3000;

app.use(express.json());
app.use(userControlRoutes);
app.use(chargerEventRoutes);

app.get('/', (req, res) => {
    res.send('OCPP Simulator Control Server is running.');
});

function startServer() {
    return app.listen(port, () => {
        console.log(`\x1b[32m[Server] Simulator Control Server listening at http://localhost:${port}\x1b[0m`);
        console.log('[Server] Endpoints available: POST /start, POST /stop');
        console.log('[Server] Charger event endpoints: POST /charger/status-notification, POST /charger/meter-values');
    });
}

if (require.main === module) {
    startServer();
}

module.exports = {
    app,
    startServer
};
