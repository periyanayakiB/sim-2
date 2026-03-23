const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const fs = require('fs');
const WebSocket = require('ws');
const fetch = require('node-fetch');

// Centralized Configuration
let token = process.env.JWT_TOKEN || "";
if (token && !token.startsWith("Bearer ")) {
    token = `Bearer ${token}`;
}
const AUTH_TOKEN = token;

const API_BASE = "https://hpyhkveb11.execute-api.ap-south-1.amazonaws.com/zeon-dev/api/v1";
const WS_BASE = "ws://13.202.14.45:9897/csms";
const USER_ID = "58e54a38-33aa-4fca-a4df-05bd15825d39+916369070422+CUSTOMER";
const METER_VALUE_INTERVAL = 5000; // 5 seconds

const DEFAULT_AUTOCHARGE_VID_TAG = (process.env.AUTOCHARGE_VID_TAG || "").trim();

function parseCliArgValue(name) {
    const argv = process.argv.slice(2);
    for (const arg of argv) {
        if (arg.startsWith(`--${name}=`)) return arg.split('=').slice(1).join('=');
    }
    const idx = argv.findIndex(a => a === `--${name}`);
    if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
    return null;
}

const AUTOCHARGE_MODE = (parseCliArgValue('mode') || process.env.SIM_MODE || '').toLowerCase() === 'autocharge';
const CLI_VID_TAG = (parseCliArgValue('vid') || '').trim();

// Parse CLI arguments
const args = process.argv.slice(2);
let limit = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
        limit = parseInt(args[i + 1], 10);
    } else if (args[i].startsWith('--limit=')) {
        limit = parseInt(args[i].split('=')[1], 10);
    }
}

// Read config.json to build TARGET_CONFIG dynamically
const rawConfig = fs.readFileSync(path.resolve(__dirname, '../config.json'));
let configs = JSON.parse(rawConfig);

if (limit && limit > 0) {
    console.log(`[Main] Limiting simulation to ${limit} charge points.`);
    configs = configs.slice(0, limit);
}

const TARGET_CONFIG = [];
for (const cp of configs) {
    const count = parseInt(cp.connectors_count, 10) || 1;
    // You can customize logic here if you want to use cp.peak_power to derive limitWh
    for (let i = 1; i <= count; i++) {
        const vidFromArray = Array.isArray(cp.vid_tags) ? cp.vid_tags[i - 1] : undefined;
        const vidTag = (vidFromArray || cp.vid_tag || DEFAULT_AUTOCHARGE_VID_TAG || "").trim();
        TARGET_CONFIG.push({
            id: cp.charge_point_id,
            connectorId: i,
            limitWh: 24000, // Default limit
            vidTag
        });
    }
}

// --- Report Tracking ---
const sessionResults = [];
let completedCount = 0;
const totalSessionsToRun = TARGET_CONFIG.length;

function formatLocalApiError(error, endpoint) {
    if (error?.name === 'AbortError') {
        return `Timeout calling ${endpoint}`;
    }
    const code = error?.code || error?.cause?.code;
    if (code === 'ECONNREFUSED') {
        return `Cannot reach ${endpoint} (control server is not running on localhost:3000)`;
    }
    return error?.message || `Unknown error calling ${endpoint}`;
}

function recordResult(cpId, result, socStart, socEnd, error = null) {
    sessionResults.push({ cpId, result, socRange: `${socStart}% → ${socEnd}%`, error });
    completedCount++;

    if (completedCount >= totalSessionsToRun) {
        setTimeout(() => printReport(), 3000);
    }
}

function printReport() {
    const success = sessionResults.filter(r => r.result === 'SUCCESS').length;
    const failure = sessionResults.filter(r => r.result === 'FAILURE').length;
    const timestamp = new Date().toISOString();

    console.log('\n');
    console.log('='.repeat(70));
    console.log('                    CUSTOM SIMULATION REPORT');
    console.log('='.repeat(70));
    console.log(`  Total Sessions : ${totalSessionsToRun}`);
    console.log(`  \x1b[32mSuccess        : ${success}\x1b[0m`);
    console.log(`  \x1b[31mFailure        : ${failure}\x1b[0m`);
    console.log('-'.repeat(70));

    const hCpId = 'CP ID'.padEnd(18);
    const hSoC = 'SoC Range'.padEnd(18);
    const hResult = 'Result'.padEnd(10);
    const hError = 'Error';
    console.log(`  ${hCpId} ${hSoC} ${hResult} ${hError}`);
    console.log('-'.repeat(70));

    for (const r of sessionResults) {
        const cpId = String(r.cpId).padEnd(18);
        const soc = r.socRange.padEnd(18);
        const color = r.result === 'SUCCESS' ? '\x1b[32m' : '\x1b[31m';
        const result = `${color}${r.result.padEnd(10)}\x1b[0m`;
        const err = r.error || '-';
        console.log(`  ${cpId} ${soc} ${result} ${err}`);
    }
    console.log('='.repeat(70));

    const reportJson = {
        timestamp,
        summary: {
            total: totalSessionsToRun,
            success,
            failure
        },
        sessions: sessionResults.map(r => ({
            cpId: r.cpId,
            socRange: r.socRange,
            result: r.result,
            error: r.error || null
        }))
    };

    const jsonPath = path.join(__dirname, 'report.json');
    fs.writeFileSync(jsonPath, JSON.stringify(reportJson, null, 2), 'utf8');
    console.log(`\n[Main] Report JSON saved to ${jsonPath}`);
    setTimeout(() => process.exit(0), 1000);
}

// --- Simulator Class (Resilient Version) ---
class ChargePointSimulator {
    constructor(cpId, connectorId, limitWh, vidTag = '') {
        this.cpId = cpId;
        this.connectorId = connectorId;
        this.limitWh = limitWh;
        // Precedence: connector-specific vidTag (from config.json) -> env default -> CLI override
        // This ensures vid_tags[0]->connectorId 1, vid_tags[1]->connectorId 2 works as intended.
        this.vidTag = (vidTag || DEFAULT_AUTOCHARGE_VID_TAG || CLI_VID_TAG || '').trim();
        this.wsUrl = `${WS_BASE}/${cpId}`;
        this.transactionId = null;
        this.energyValue = 1000;
        this.socStart = 51.0;
        this.socValue = 51.0;
        this.voltageValue = 375;
        this.nextMessageId = 1;
        this.ws = null;
        this.finished = false;
        this.connectAttempts = 0;

        this.pendingCalls = new Map(); // msgId -> { action, resolve, reject }
    }

    log(msg) {
        console.log(`[${this.cpId}] ${msg}`);
    }

    error(msg) {
        console.error(`\x1b[31m[${this.cpId}] Error: ${msg}\x1b[0m`);
    }

    getTimestamp() {
        return new Date().toISOString();
    }

    nextId() {
        return (this.nextMessageId++).toString();
    }

    sendCall(action, payload) {
        if (!this.ws || this.ws.readyState !== 1) {
            return Promise.reject(new Error('WebSocket not open'));
        }
        const msgId = this.nextId();
        const msg = [2, msgId, action, payload];
        return new Promise((resolve, reject) => {
            this.pendingCalls.set(msgId, { action, resolve, reject });
            try {
                this.ws.send(JSON.stringify(msg));
            } catch (e) {
                this.pendingCalls.delete(msgId);
                reject(e);
            }
        });
    }

    async sendStatus(status) {
        this.log(`<- [StatusNotification] ${status}`);
        return await this.sendCall("StatusNotification", {
            connectorId: this.connectorId,
            errorCode: "NoError",
            status,
            timestamp: this.getTimestamp()
        });
    }

    async sendAuthorize(idTag) {
        this.log(`<- [AuthorizeRequest] idTag=${idTag}`);
        return await this.sendCall("Authorize", { idTag });
    }

    markDone(result, errorMsg = null) {
        if (this.finished) return;
        this.finished = true;
        recordResult(this.cpId, result, this.socStart.toFixed(1), this.socValue.toFixed(1), errorMsg);
    }

    async apiCall(endpoint, method = 'GET', body = null, attempt = 1) {
        const url = `${API_BASE}${endpoint}`;
        const MAX_ATTEMPTS = 3;

        try {
            const response = await fetch(url, {
                method,
                headers: {
                    'accept': 'application/json, text/plain, */*',
                    'Authorization': AUTH_TOKEN,
                    'content-type': 'application/json'
                },
                body: body ? JSON.stringify(body) : null
            });

            if (response.status === 403 || response.status === 401) {
                this.error('Authentication failed (token expired?)');
                this.markDone('FAILURE', 'Auth Error ' + response.status);
                return null;
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            if (attempt < MAX_ATTEMPTS) {
                const backoff = Math.pow(2, attempt) * 1000;
                this.error(`API Call failed (${error.message}). Retrying in ${backoff}ms...`);
                await new Promise(r => setTimeout(r, backoff));
                return this.apiCall(endpoint, method, body, attempt + 1);
            }
            this.error(`API Call failed after ${MAX_ATTEMPTS} attempts: ${error.message}`);
            this.markDone('FAILURE', error.message);
            return null;
        }
    }

    async triggerRemoteStart() {
        this.log(`Triggering Remote Start for Connector ${this.connectorId}...`);
        try {
            const response = await fetch('http://localhost:3000/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    charge_point_id: this.cpId,
                    connector_id: this.connectorId,
                    user_id: USER_ID,
                    source: 'CSMS'
                }),
                signal: AbortSignal.timeout(10000)
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (error) {
            const message = formatLocalApiError(error, '/start');
            this.error(`Local start failed: ${message}`);
            this.markDone('FAILURE', `Start failed: ${message}`);
        }
    }

    async runStartupSequence() {
        // Default flow: Available -> Preparing -> RemoteStart API
        // AutoCharge flow: Available -> Preparing -> Authorize(VID) -> RemoteStart API
        await this.sendStatus("Available");
        await this.sendStatus("Preparing");

        if (AUTOCHARGE_MODE) {
            if (!this.vidTag) {
                this.error("AutoCharge enabled but no VID tag provided. Set AUTOCHARGE_VID_TAG, add vid_tag(s) in config.json, or pass --vid.");
            } else {
                try {
                    const authRes = await this.sendAuthorize(this.vidTag);
                    const status = authRes?.idTagInfo?.status;
                    this.log(`[AuthorizeResponse] VID status: ${status || 'N/A'}`);
                } catch (e) {
                    this.error(`VID Authorize failed: ${e.message}`);
                }
            }
        }

        await new Promise(r => setTimeout(r, 1000));
        return this.triggerRemoteStart();
    }

    async sendSingleMeterValue(isFinal = false) {
        if (!this.ws || this.ws.readyState !== 1) return;

        const mvMsg = [
            2,
            this.nextId(),
            "MeterValues",
            {
                connectorId: this.connectorId,
                transactionId: this.transactionId,
                meterValue: [{
                    timestamp: this.getTimestamp(),
                    sampledValue: [
                        { context: "Sample.Periodic", measurand: "Current.Import", unit: "A", value: "94" },
                        { value: this.energyValue.toString(), context: "Sample.Periodic", format: "Raw", measurand: "Energy.Active.Import.Register", location: "Outlet", unit: "Wh" },
                        { value: "35250", context: "Sample.Periodic", measurand: "Power.Active.Import", unit: "W" },
                        { value: this.socValue.toFixed(1), context: "Sample.Periodic", measurand: "SoC", location: "EV", unit: "Percent" },
                        { value: this.voltageValue.toString(), context: "Sample.Periodic", measurand: "Voltage", unit: "V" }
                    ]
                }]
            }
        ];

        try {
            this.ws.send(JSON.stringify(mvMsg));
            const type = isFinal ? "Final " : "";
            this.log(`<- [${type}MeterValue] Energy: ${this.energyValue} Wh, SoC: ${this.socValue.toFixed(1)}%`);
        } catch (e) {
            this.error(`Failed to send MeterValue: ${e.message}`);
        }
    }

    async fetchAndTriggerStop() {
        this.log("Triggering local stop and finishing session...");
        const MAX_STOP_RETRIES = 3;
        let apiSuccess = false;

        for (let attempt = 1; attempt <= MAX_STOP_RETRIES; attempt++) {
            try {
                // In the mean time, send a meter value if connection alive
                if (this.ws && this.ws.readyState === 1) {
                    await this.sendSingleMeterValue(attempt === MAX_STOP_RETRIES);
                }

                const response = await fetch(`http://localhost:3000/stop`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ charge_point_id: this.cpId, connector_id: this.connectorId }),
                    signal: AbortSignal.timeout(10000)
                });

                if (response.ok) {
                    this.log(`Local stop successful on attempt ${attempt}`);
                    apiSuccess = true;
                    break;
                } else {
                    this.error(`Local stop failed (Attempt ${attempt}): HTTP ${response.status}`);
                }
            } catch (err) {
                this.error(`Local stop attempt ${attempt} failed: ${err.message}`);
            }

            if (attempt < MAX_STOP_RETRIES) {
                this.log(`Retrying local stop in 5s...`);
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        if (!apiSuccess) {
            this.error("Failed to confirm local stop after all retries. Proceeding anyway.");
        }

        // Only send OCPP StopTransaction to the CSMS if we actually had a transactionId
        if (this.transactionId) {
            this.log("Sending StopTransaction to CSMS...");
            const stopTxMsg = [
                2,
                this.nextId(),
                "StopTransaction",
                {
                    transactionId: this.transactionId,
                    meterStop: this.energyValue,
                    timestamp: this.getTimestamp()
                }
            ];

            try {
                if (this.ws && this.ws.readyState === 1) {
                    this.ws.send(JSON.stringify(stopTxMsg));
                }
            } catch (e) {
                this.error(`Failed to send StopTransaction: ${e.message}`);
            }
        } else {
            this.log("No Transaction ID. Skipping OCPP StopTransaction.");
        }

        this.markDone('SUCCESS');
        if (this.ws) this.ws.close();
    }

    async sendMeterValueSequence() {
        this.log(`Starting 20x sequence. Limit: ${this.limitWh} Wh`);

        const totalIncrement = Math.max(0, this.limitWh - 1000);
        const stepIncrement = Math.floor(totalIncrement / 10);

        for (let i = 1; i <= 10; i++) {
            if (this.finished) break;
            this.energyValue += stepIncrement;
            this.socValue += 1.0;

            await this.sendSingleMeterValue();
            await new Promise(r => setTimeout(r, METER_VALUE_INTERVAL));
        }

        if (!this.finished) {
            this.log("Sequence done. Triggering stop flow in 2s...");
            setTimeout(() => this.fetchAndTriggerStop(), 2000);
        }
    }

    start() {
        const MAX_CONNECT_ATTEMPTS = 3;
        this.connectAttempts++;

        this.log(`Connecting (Attempt ${this.connectAttempts}/${MAX_CONNECT_ATTEMPTS}) to ${this.wsUrl}...`);

        try {
            this.ws = new WebSocket(this.wsUrl, "ocpp1.6");
        } catch (e) {
            this.error(`Sync WS Error: ${e.message}`);
            return this.handleConnectError(e.message);
        }

        const connectTimeout = setTimeout(() => {
            if (!this.finished) {
                this.error("Timed out waiting for connection/transaction. Proceeding to stop flow...");
                this.handleConnectError("Start Timeout");
            }
        }, 45000);

        this.ws.addEventListener('open', () => {
            this.log("Connected to CSMS");
            this.runStartupSequence().catch(e => this.error(`Startup sequence error: ${e.message}`));
        });

        this.ws.addEventListener('message', async (event) => {
            try {
                const message = JSON.parse(event.data);
                const type = message[0];
                const msgId = message[1];

                if (type === 2) {
                    const action = message[2];
                    const payload = message[3];

                    if (action === "RemoteStartTransaction") {
                        this.log("RemoteStart received. Accepting...");
                        this.ws.send(JSON.stringify([3, msgId, { status: "Accepted" }]));

                        const remoteIdTag = payload.idTag || "abc";
                        try {
                            const authRes = await this.sendAuthorize(remoteIdTag);
                            const status = authRes?.idTagInfo?.status;
                            this.log(`[AuthorizeResponse] Remote idTag status: ${status || 'N/A'}`);
                        } catch (e) {
                            this.error(`RemoteStart authorize failed: ${e.message}. Proceeding to StartTransaction...`);
                        }

                        const startTxMsg = [
                            2,
                            this.nextId(),
                            "StartTransaction",
                            {
                                connectorId: payload.connectorId || this.connectorId,
                                idTag: remoteIdTag,
                                meterStart: this.energyValue,
                                timestamp: this.getTimestamp()
                            }
                        ];
                        this.ws.send(JSON.stringify(startTxMsg));
                    }
                    else if (action === "RemoteStopTransaction") {
                        this.log("RemoteStop received. Accepting...");
                        this.ws.send(JSON.stringify([3, msgId, { status: "Accepted" }]));

                        const stopTxMsg = [
                            2,
                            this.nextId(),
                            "StopTransaction",
                            {
                                transactionId: this.transactionId,
                                meterStop: this.energyValue,
                                timestamp: this.getTimestamp()
                            }
                        ];
                        this.ws.send(JSON.stringify(stopTxMsg));
                        this.markDone('SUCCESS');
                    } else {
                        // Respond accepted to any other calls
                        this.ws.send(JSON.stringify([3, msgId, { status: "Accepted" }]));
                    }
                }
                else if (type === 3) {
                    const payload = message[2];

                    const pending = this.pendingCalls.get(msgId);
                    if (pending) {
                        this.pendingCalls.delete(msgId);
                        pending.resolve(payload);
                    }

                    if (payload && payload.transactionId) {
                        clearTimeout(connectTimeout);
                        this.transactionId = payload.transactionId;
                        this.log(`Transaction ID: ${this.transactionId}`);

                        const statusMsg = [
                            2,
                            this.nextId(),
                            "StatusNotification",
                            {
                                connectorId: this.connectorId,
                                errorCode: "NoError",
                                status: "Charging",
                                timestamp: this.getTimestamp()
                            }
                        ];
                        this.ws.send(JSON.stringify(statusMsg));
                        await this.sendMeterValueSequence();
                    }
                }
                else if (type === 4) {
                    const errCode = message[2];
                    const errDesc = message[3];
                    const pending = this.pendingCalls.get(msgId);
                    if (pending) {
                        this.pendingCalls.delete(msgId);
                        pending.reject(new Error(`${pending.action} failed: ${errCode} ${errDesc}`));
                    }
                }
            } catch (e) {
                this.error(`Message parsing error: ${e.message}`);
            }
        });

        this.ws.addEventListener('close', () => {
            this.log("Disconnected.");
        });

        this.ws.addEventListener('error', (e) => {
            this.error(`Socket Error: ${e.message}`);
            if (!this.transactionId) {
                clearTimeout(connectTimeout);
                this.handleConnectError(e.message);
            }
        });
    }

    async handleConnectError(msg) {
        if (this.finished) return;
        const MAX_CONNECT_ATTEMPTS = 3;
        if (this.connectAttempts < MAX_CONNECT_ATTEMPTS) {
            const backoff = Math.pow(2, this.connectAttempts) * 2000;
            this.error(`Connection failed. Retrying in ${backoff}ms...`);
            await new Promise(r => setTimeout(r, backoff));
            this.start();
        } else {
            this.error(`Final connection failure after ${MAX_CONNECT_ATTEMPTS} attempts. Triggering stop flow cleanup.`);
            await this.fetchAndTriggerStop();
            this.markDone('FAILURE', `Max retries reached: ${msg}`);
        }
    }
}

async function run() {
    if (typeof WebSocket === 'undefined') {
        process.exit(1);
    }

    const activeSims = new Set();
    const totalToRun = TARGET_CONFIG.length;

    console.log(`[Main] Launching custom simulation for ${totalToRun} targeted connectors from config.json...`);

    for (let i = 0; i < totalToRun; i++) {
        // Concurrency limit
        while (activeSims.size >= 5) {
            await new Promise(r => setTimeout(r, 100));
        }

        const item = TARGET_CONFIG[i];
        const sim = new ChargePointSimulator(item.id, item.connectorId, item.limitWh, item.vidTag);
        activeSims.add(sim);

        const originalMarkDone = sim.markDone;
        sim.markDone = function (result, errorMsg) {
            originalMarkDone.call(this, result, errorMsg);
            activeSims.delete(sim);
        };

        sim.start();
        await new Promise(r => setTimeout(r, 100)); // Stagger

        if ((i + 1) % 10 === 0) {
            console.log(`[Main] Progress: ${i + 1}/${totalToRun} launched`);
        }
    }

    while (activeSims.size > 0) {
        await new Promise(r => setTimeout(r, 1000));
    }
}

run().catch(err => console.error(`[Main] Fatal Error: ${err.message}`));
