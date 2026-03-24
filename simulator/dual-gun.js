const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const WebSocket = require('ws');
const fetch = require('node-fetch');

const WS_BASE = process.env.WS_BASE || 'ws://13.202.14.45:9897/csms';
const LOCAL_CONTROL_BASE = process.env.LOCAL_CONTROL_BASE || 'http://localhost:3000';
const USER_ID = process.env.DUAL_GUN_USER_ID || '58e54a38-33aa-4fca-a4df-05bd15825d39+916369070422+CUSTOMER';
const DEFAULT_VID_TAG = (process.env.AUTOCHARGE_VID_TAG || '').trim();

function parseCliArgValue(name) {
    const argv = process.argv.slice(2);
    for (const arg of argv) {
        if (arg.startsWith(`--${name}=`)) return arg.split('=').slice(1).join('=');
    }
    const idx = argv.findIndex(a => a === `--${name}`);
    if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
    return null;
}

class DualGunSimulator {
    constructor(cpId, vidTag1, vidTag2) {
        this.cpId = cpId;
        this.vidTagByConnector = {
            1: (vidTag1 || DEFAULT_VID_TAG || '').trim(),
            2: (vidTag2 || vidTag1 || DEFAULT_VID_TAG || '').trim()
        };
        this.wsUrl = `${WS_BASE}/${cpId}`;
        this.ws = null;
        this.nextMessageId = 1;
        this.pendingCalls = new Map();
        this.transactions = new Map();
    }

    log(message) {
        console.log(`[${this.cpId}] ${message}`);
    }

    error(message) {
        console.error(`\x1b[31m[${this.cpId}] Error: ${message}\x1b[0m`);
    }

    nextId() {
        return String(this.nextMessageId++);
    }

    getTimestamp() {
        return new Date().toISOString();
    }

    sendCall(action, payload) {
        if (!this.ws || this.ws.readyState !== 1) {
            return Promise.reject(new Error('WebSocket not open'));
        }

        const msgId = this.nextId();
        const message = [2, msgId, action, payload];

        return new Promise((resolve, reject) => {
            this.pendingCalls.set(msgId, { action, resolve, reject });
            try {
                this.ws.send(JSON.stringify(message));
            } catch (error) {
                this.pendingCalls.delete(msgId);
                reject(error);
            }
        });
    }

    async sendStatus(connectorId, status) {
        this.log(`status notification ${connectorId} ${status}`);
        await this.sendCall('StatusNotification', {
            connectorId,
            errorCode: 'NoError',
            status,
            timestamp: this.getTimestamp()
        });
    }

    // Per OCPP 1.6, Authorize request does not contain connectorId.
    async authorizeWithVidTag(idTag) {
        this.log('Authorize (with vid_tag)');
        this.log('Authorize (with vid_tag)');
        return this.sendCall('Authorize', { idTag });
    }

    async authorizeWithRemoteStartIdTag(idTag) {
        this.log(`Authorize (with remote start id_tag)`);
        this.log('Authorize (with remote start id_tag)');
        return this.sendCall('Authorize', { idTag });
    }

    async triggerRemoteStart(connectorId) {
        this.log(`Remote start ${connectorId}`);
        const response = await fetch(`${LOCAL_CONTROL_BASE}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                charge_point_id: this.cpId,
                connector_id: connectorId,
                user_id: USER_ID,
                source: 'CSMS'
            }),
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            throw new Error(`Remote start ${connectorId} failed with HTTP ${response.status}`);
        }
    }

    async runOrderedDualGunFlow() {
        await this.sendStatus(1, 'Available');
        await this.sendStatus(2, 'Available');
        await this.sendStatus(1, 'Preparing');
        await this.sendStatus(2, 'Preparing');

        const vid1 = this.vidTagByConnector[1];
        const vid2 = this.vidTagByConnector[2];

        if (vid1) {
            await this.authorizeWithVidTag(vid1);
        } else {
            this.log('Skipping Authorize 1 because vid_tag is empty.');
        }

        if (vid2) {
            await this.authorizeWithVidTag(vid2);
        } else {
            this.log('Skipping Authorize 2 because vid_tag is empty.');
        }

        await this.triggerRemoteStart(1);
        await new Promise(r => setTimeout(r, 300));
        await this.triggerRemoteStart(2);
    }

    async handleRemoteStart(msgId, payload) {
        const connectorId = payload?.connectorId || 1;
        const remoteIdTag = payload?.idTag || this.vidTagByConnector[connectorId] || this.vidTagByConnector[1] || 'abc';

        this.log(`Remote start ${connectorId} accepted`);
        this.ws.send(JSON.stringify([3, msgId, { status: 'Accepted' }]));

        await this.authorizeWithRemoteStartIdTag(remoteIdTag);

        this.log(`start ${connectorId}`);
        this.ws.send(JSON.stringify([
            2,
            this.nextId(),
            'StartTransaction',
            {
                connectorId,
                idTag: remoteIdTag,
                meterStart: 1000,
                timestamp: this.getTimestamp()
            }
        ]));
    }

    async connectAndRun() {
        this.log(`Connecting to ${this.wsUrl}`);
        this.ws = new WebSocket(this.wsUrl, 'ocpp1.6');

        this.ws.on('open', async () => {
            this.log('Connected to CSMS');
            try {
                await this.runOrderedDualGunFlow();
            } catch (error) {
                this.error(error.message);
            }
        });

        // `ws` library passes the message payload as the first argument (not `{ data: ... }`).
        this.ws.on('message', async (data) => {
            try {
                const raw = Buffer.isBuffer(data) ? data.toString('utf8') : (data?.toString?.() ?? '');
                if (!raw) return;

                let message;
                try {
                    message = JSON.parse(raw);
                } catch (e) {
                    // Avoid crashing on non-JSON frames (or partial/undefined payloads).
                    this.log(`Ignoring non-JSON frame: ${raw.slice(0, 120)}`);
                    return;
                }
                const type = message[0];
                const msgId = message[1];

                if (type === 2) {
                    const action = message[2];
                    const payload = message[3];

                    if (action === 'RemoteStartTransaction') {
                        await this.handleRemoteStart(msgId, payload);
                    } else {
                        this.ws.send(JSON.stringify([3, msgId, { status: 'Accepted' }]));
                    }
                    return;
                }

                if (type === 3) {
                    const payload = message[2];
                    const pending = this.pendingCalls.get(msgId);
                    if (pending) {
                        this.pendingCalls.delete(msgId);
                        pending.resolve(payload);
                    }

                    if (payload?.transactionId) {
                        this.transactions.set(payload.transactionId, payload);
                        this.log(`Start accepted with transactionId=${payload.transactionId}`);
                        if (this.transactions.size >= 2) {
                            this.log('Dual-gun start flow completed for connectors 1 and 2.');
                        }
                    }
                    return;
                }

                if (type === 4) {
                    const errCode = message[2];
                    const errDesc = message[3];
                    const pending = this.pendingCalls.get(msgId);
                    if (pending) {
                        this.pendingCalls.delete(msgId);
                        pending.reject(new Error(`${pending.action} failed: ${errCode} ${errDesc}`));
                    }
                }
            } catch (error) {
                this.error(`Message handling error: ${error.message}`);
            }
        });

        this.ws.on('close', () => this.log('Disconnected.'));
        this.ws.on('error', error => this.error(`Socket error: ${error.message}`));
    }
}

async function run() {
    const cpId = (parseCliArgValue('cp') || '').trim();
    const vid = (parseCliArgValue('vid') || DEFAULT_VID_TAG || '').trim();
    const vid1 = (parseCliArgValue('vid1') || vid).trim();
    const vid2 = (parseCliArgValue('vid2') || vid).trim();

    if (!cpId) {
        console.error('Usage: node dual-gun.js --cp=<charge_point_id> [--vid=<VID:...>] [--vid1=<VID:...> --vid2=<VID:...>]');
        process.exit(1);
    }

    const simulator = new DualGunSimulator(cpId, vid1, vid2);
    await simulator.connectAndRun();
}

run().catch(error => {
    console.error(`[Main] Fatal error: ${error.message}`);
    process.exit(1);
});
