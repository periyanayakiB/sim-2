const path = require('path');
const { spawn } = require('child_process');
const { startServer } = require('./server/server');

const rawArgs = process.argv.slice(2);
const simArgIndex = rawArgs.findIndex(arg => arg === '--sim' || arg.startsWith('--sim='));
let simMode = 'multi';

if (simArgIndex !== -1) {
    if (rawArgs[simArgIndex].startsWith('--sim=')) {
        simMode = rawArgs[simArgIndex].split('=').slice(1).join('=') || 'multi';
        rawArgs.splice(simArgIndex, 1);
    } else {
        const value = rawArgs[simArgIndex + 1];
        if (value && !value.startsWith('--')) {
            simMode = value;
            rawArgs.splice(simArgIndex, 2);
        } else {
            rawArgs.splice(simArgIndex, 1);
        }
    }
}

const simulatorArgs = rawArgs;
const simulatorMap = {
    multi: 'simulator/multi.js',
    dual: 'simulator/dual-gun.js',
    'dual-gun': 'simulator/dual-gun.js'
};
const simulatorRelativeEntry = simulatorMap[simMode] || simulatorMap.multi;
const simulatorEntry = path.resolve(__dirname, simulatorRelativeEntry);

let simulatorProcess = null;
let isShuttingDown = false;

const serverInstance = startServer();

function shutdown(code = 0) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    if (simulatorProcess && !simulatorProcess.killed) {
        simulatorProcess.kill('SIGINT');
    }

    serverInstance.close(() => {
        process.exit(code);
    });
}

serverInstance.on('listening', () => {
    console.log(`[Runner] Starting simulator mode: ${simMode}`);
    simulatorProcess = spawn(process.execPath, [simulatorEntry, ...simulatorArgs], {
        cwd: __dirname,
        stdio: 'inherit'
    });

    simulatorProcess.on('exit', (code, signal) => {
        if (signal) {
            console.log(`[Runner] Simulator exited with signal ${signal}`);
            shutdown(1);
            return;
        }
        shutdown(code || 0);
    });
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
