const path = require('path');
const { spawn } = require('child_process');
const { startServer } = require('./server/server');

const simulatorArgs = process.argv.slice(2);
const simulatorEntry = path.resolve(__dirname, 'simulator/multi.js');

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
