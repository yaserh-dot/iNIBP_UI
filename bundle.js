/**
 * BUNDLED UART VIZ APPLICATION
 * Combines SerialManager, Logger, and App Logic for file:// compatibility.
 */

/* =========================================
   1. LOGGER CLASS
   ========================================= */
class Logger {
    constructor() {
        this.fileHandle = null;
        this.writable = null;
        this.bytesWritten = 0;
        this.fileName = null;
    }

    async selectFile() {
        try {
            const options = {
                suggestedName: `serial_log_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
                types: [{
                    description: 'CSV File',
                    accept: { 'text/csv': ['.csv'] },
                }],
            };
            this.fileHandle = await window.showSaveFilePicker(options);
            this.fileName = this.fileHandle.name;
            return true;
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('File selection failed:', error);
            }
            return false;
        }
    }

    async start() {
        if (!this.fileHandle) return false;
        this.writable = await this.fileHandle.createWritable();
        this.bytesWritten = 0;
        return true;
    }

    async write(data) {
        if (!this.writable) return;
        await this.writable.write(data);
        this.bytesWritten += data.length;
    }

    async stop() {
        if (this.writable) {
            await this.writable.close();
            this.writable = null;
        }
        this.fileHandle = null;
        this.fileName = null;
    }
}

/* =========================================
   2. SERIAL MANAGER CLASS
   ========================================= */
class SerialManager {
    constructor() {
        this.port = null;
        this.reader = null;
        this.readableStreamClosed = null;
        this.isReading = false;
        this.onDataCallback = null;
        this.onDisconnectCallback = null;

        // Protocol Buffer
        this.rxBuffer = new Uint8Array(4096);
        this.rxHead = 0;
    }

    static isSupported() {
        return 'serial' in navigator;
    }

    async connect(baudRate = 9600) {
        try {
            this.port = await navigator.serial.requestPort();
            await this.port.open({ baudRate: parseInt(baudRate) });

            this.startReading();

            const info = this.port.getInfo();

            this.port.addEventListener('disconnect', () => {
                this.disconnectFromHardware();
            });

            return { success: true, info };
        } catch (error) {
            console.warn('Connection failed or cancelled:', error);
            return { success: false, error };
        }
    }

    async startReading() {
        this.isReading = true;
        this.reader = this.port.readable.getReader();

        try {
            while (true) {
                const { value, done } = await this.reader.read();
                if (done) { break; }
                if (value) {
                    this.processIncomingChunk(value);
                }
            }
        } catch (error) {
            console.error('Read error:', error);
        } finally {
            this.reader.releaseLock();
        }
    }

    processIncomingChunk(chunk) {
        if (this.rxHead + chunk.length > this.rxBuffer.length) {
            console.warn('Buffer overflow, resetting');
            this.rxHead = 0;
        }
        this.rxBuffer.set(chunk, this.rxHead);
        this.rxHead += chunk.length;

        let searchIdx = 0;
        while (searchIdx <= this.rxHead - 11) {
            if (this.rxBuffer[searchIdx] === 0xAA) {
                const payloadLen = this.rxBuffer[searchIdx + 1];
                if (payloadLen === 8) {
                    if (this.verifyChecksum(searchIdx)) {
                        this.parsePacket(searchIdx);
                        searchIdx += 11;
                        continue;
                    }
                }
            }
            searchIdx++;
        }

        if (searchIdx > 0) {
            this.rxBuffer.copyWithin(0, searchIdx, this.rxHead);
            this.rxHead -= searchIdx;
        }
    }

    verifyChecksum(idx) {
        let checksum = 0;
        for (let i = 0; i < 10; i++) {
            checksum ^= this.rxBuffer[idx + i];
        }
        return checksum === this.rxBuffer[idx + 10];
    }

    parsePacket(idx) {
        const view = new DataView(this.rxBuffer.buffer, idx, 11);
        const cuffInt = view.getInt32(2, true);
        const pulseInt = view.getInt32(6, true);
        const cuff = cuffInt / 100.0;
        const pulse = pulseInt / 100.0;

        if (this.onDataCallback) {
            this.onDataCallback({ cuff, pulse });
        }
    }

    async disconnect() {
        if (this.reader) {
            await this.reader.cancel();
        }
        if (this.port) {
            await this.port.close();
            this.port = null;
        }
        this.isReading = false;
        if (this.onDisconnectCallback) this.onDisconnectCallback();
    }

    disconnectFromHardware() {
        if (this.onDisconnectCallback) this.onDisconnectCallback();
        this.port = null;
        this.reader = null;
    }
}

/* =========================================
   3. MAIN APPLICATION LOGIC
   ========================================= */

// App State
const state = {
    cuffChart: null,
    pulseChart: null,
    isLogging: false,
    // Buffer for batch rendering
    pendingData: [],
    lastRender: 0
};

// Modules
const serial = new SerialManager();
const logger = new Logger();

// UI Elements
const ui = {
    btnConnect: document.getElementById('btn-connect'),
    statusLight: document.getElementById('status-light'),
    statusText: document.getElementById('connection-status'),
    baudRate: document.getElementById('baud-rate'),
    terminal: document.getElementById('terminal-view'),
    btnClearTerm: document.getElementById('btn-clear-terminal'),
    autoscroll: document.getElementById('autoscroll'),
    btnLog: document.getElementById('btn-log'),
    logBytes: document.getElementById('log-bytes'),
    logFilename: document.getElementById('log-filename'),
    cuffValue: document.getElementById('cuff-pressure'),
    btnClearGraphs: document.getElementById('btn-clear-graphs'),
};

function initCharts() {
    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false, // CRITICAL: Disable parsing for raw speed
        plugins: {
            legend: { display: false },
            tooltip: { enabled: false } // Disable tooltips for performance
        },
        scales: {
            x: {
                type: 'linear', // Linear scale is faster for numbers
                display: false,
                grid: { display: false }
            },
            y: {
                grid: { display: false },
                ticks: { color: '#94a3b8' },
                title: { display: true, color: '#94a3b8', font: { size: 11, weight: 'bold' } }
            }
        },
        elements: {
            point: { radius: 0 }, // Ensure points are never drawn
            line: { borderWidth: 2, tension: 0.1 }
        }
    };

    const ctxCuff = document.getElementById('cuffChart').getContext('2d');
    const gradCuff = ctxCuff.createLinearGradient(0, 0, 0, 200);
    // Vibrant Fuchsia Gradient
    gradCuff.addColorStop(0, 'rgba(217, 70, 239, 0.5)');
    gradCuff.addColorStop(1, 'rgba(217, 70, 239, 0.0)');

    const cuffOptions = JSON.parse(JSON.stringify(commonOptions));
    cuffOptions.scales.y.title.text = 'Pressure (mmHg)';
    cuffOptions.scales.y.grid = { display: false };

    state.cuffChart = new Chart(ctxCuff, {
        type: 'line',
        data: {
            datasets: [{
                data: [], // Stores objects {x, y}
                borderColor: '#d946ef', // Fuchsia-500
                backgroundColor: gradCuff,
                fill: true
            }]
        },
        options: cuffOptions
    });

    const ctxPulse = document.getElementById('pulseChart').getContext('2d');
    const gradPulse = ctxPulse.createLinearGradient(0, 0, 0, 200);
    // Electric Cyan Gradient
    gradPulse.addColorStop(0, 'rgba(6, 182, 212, 0.5)');
    gradPulse.addColorStop(1, 'rgba(6, 182, 212, 0.0)');

    const pulseOptions = JSON.parse(JSON.stringify(commonOptions));
    pulseOptions.scales.y.title.text = 'Amplitude';
    pulseOptions.scales.y.grid = { display: false };

    state.pulseChart = new Chart(ctxPulse, {
        type: 'line',
        data: {
            datasets: [{
                data: [],
                borderColor: '#06b6d4', // Cyan-500
                backgroundColor: gradPulse,
                fill: true
            }]
        },
        options: pulseOptions
    });

    // Start Render Loop
    requestAnimationFrame(renderLoop);
}

// Global X-counter for linear scale performance
let globalDataPointCount = 0;

function handleSerialData(data) {
    // Just buffer the data. Do NOT update DOM/Charts here.
    state.pendingData.push(data);
}

/**
 * HIGH PERFORMANCE RENDER LOOP
 * Batches updates to 30fps to prevent browser freezing.
 */
function renderLoop(timestamp) {
    if (state.pendingData.length > 0) {

        const chunk = state.pendingData.splice(0, state.pendingData.length);
        const lastItem = chunk[chunk.length - 1];

        // 1. Logging (Always log if active, unrelated to graph trigger)
        if (state.isLogging) {
            const time = new Date().toISOString();
            let bigStr = "";
            for (const d of chunk) {
                bigStr += `${time},${d.cuff},${d.pulse}\n`;
            }
            logger.write(bigStr);
            ui.logBytes.textContent = logger.bytesWritten.toLocaleString();
        }

        // 2. DOM Readout (Always update live)
        if (ui.cuffValue) {
            ui.cuffValue.textContent = lastItem.cuff.toFixed(2);
        }

        // 3. Chart Trigger Logic
        // Checks if we should start plotting
        if (!state.hasTriggered) {
            // Check if any point in this chunk exceeds 20
            for (const d of chunk) {
                if (d.cuff >= 20.0) {
                    state.hasTriggered = true;
                    break;
                }
            }
        }

        // 4. Chart Updates (Only if triggered)
        if (state.hasTriggered) {
            const cuffArr = state.cuffChart.data.datasets[0].data;
            const pulseArr = state.pulseChart.data.datasets[0].data;

            for (const d of chunk) {
                // Determine start point inside chunk if just triggered
                // (Simplification: if triggered, plot all future points. 
                //  Strictly speaking we might drop a few points before 20 in this specific chunk, 
                //  but 20mmHg is just a threshold, plotting the whole chunk is fine for continuity).
                globalDataPointCount++;
                cuffArr.push({ x: globalDataPointCount, y: d.cuff });
                pulseArr.push({ x: globalDataPointCount, y: d.pulse });
            }

            // Safety Limit
            const MAX_POINTS = 4000;
            if (cuffArr.length > MAX_POINTS) {
                const removeCount = cuffArr.length - MAX_POINTS;
                cuffArr.splice(0, removeCount);
                pulseArr.splice(0, removeCount);
            }

            state.cuffChart.update('none');
            state.pulseChart.update('none');
        }
    }

    requestAnimationFrame(renderLoop);
}

// Obsolete individual update function
function updateChart(chart, val) { } // No-op now

/* TERMINAL HELPER */
function updateTerminal(text) {
    const shouldScroll = ui.autoscroll.checked;
    ui.terminal.textContent += text;
    if (shouldScroll) {
        ui.terminal.scrollTop = ui.terminal.scrollHeight;
    }
}

/* UI EVENT LISTENERS */
ui.btnConnect.addEventListener('click', async () => {
    if (serial.port) {
        await serial.disconnect();
        return;
    }

    if (!SerialManager.isSupported()) {
        alert('Web Serial API not supported in this browser.');
        return;
    }

    const baud = ui.baudRate.value;
    const result = await serial.connect(baud);
    const success = (typeof result === 'object') ? result.success : result;

    if (success) {
        ui.statusLight.classList.remove('disconnected');
        ui.statusLight.classList.add('connected');
        ui.statusText.textContent = 'Connected';
        ui.btnConnect.innerHTML = '<span class="icon">❌</span> Disconnect';
        ui.btnConnect.classList.replace('btn-primary', 'btn-secondary');
        ui.baudRate.disabled = true;

        // ENABLE LOGGING
        ui.btnLog.disabled = false;

        let msg = 'Device Connected Successfully!';
        if (result.info) {
            const { usbVendorId, usbProductId } = result.info;
            if (usbVendorId && usbProductId) {
                const vid = usbVendorId.toString(16).toUpperCase().padStart(4, '0');
                const pid = usbProductId.toString(16).toUpperCase().padStart(4, '0');
                msg = `Device Connected (ID: ${vid}:${pid})`;
            }
        }
        showToast(msg, 'success');
    }
});

function showToast(msg, type = 'success') {
    // 1. Popup
    const toast = document.getElementById('toast');
    const msgEl = document.getElementById('toast-message');
    if (toast && msgEl) {
        msgEl.textContent = msg;
        toast.className = 'toast';
        if (type === 'error') toast.classList.add('error');
        // Trigger reflow
        void toast.offsetWidth;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // 2. Terminal Log
    const timestamp = new Date().toLocaleTimeString();
    const prefix = type === 'error' ? '❌' : '✅';
    updateTerminal(`[${timestamp}] ${prefix} ${msg}\n`);
}

serial.onDataCallback = handleSerialData;
serial.onDisconnectCallback = () => {
    ui.statusLight.classList.remove('connected');
    ui.statusLight.classList.add('disconnected');
    ui.statusText.textContent = 'Disconnected';
    ui.btnConnect.innerHTML = '<span class="icon">🔌</span> Connect Device';
    ui.btnConnect.classList.replace('btn-secondary', 'btn-primary');
    ui.baudRate.disabled = false;

    // DISABLE LOGGING
    ui.btnLog.disabled = true;

    if (state.isLogging) stopLogging();

    showToast('Device Disconnected', 'error');
};

if (ui.btnClearGraphs) {
    ui.btnClearGraphs.addEventListener('click', () => {
        // Reset Global Counter and Trigger
        globalDataPointCount = 0;
        state.hasTriggered = false; // Reset trigger so it waits for 20mmHg again

        if (state.cuffChart) {
            state.cuffChart.data.datasets[0].data = [];
            state.cuffChart.update();
        }
        if (state.pulseChart) {
            state.pulseChart.data.datasets[0].data = [];
            state.pulseChart.update();
        }
        updateTerminal(`[SYSTEM] Graphs cleared.\n`);
    });
}

ui.btnLog.addEventListener('click', async () => {
    if (state.isLogging) {
        await stopLogging();
    } else {
        await startLogging();
    }
});

async function startLogging() {
    const success = await logger.selectFile();
    if (success) {
        await logger.start();
        await logger.write("Timestamp,CuffPressure,PulsePressure\n");
        state.isLogging = true;
        ui.btnLog.innerHTML = '<span class="icon">⏹</span> Stop Logging';
        ui.btnLog.classList.add('btn-primary');
        ui.logFilename.textContent = logger.fileName;
        ui.logBytes.textContent = '0';
        updateTerminal(`[SYSTEM] Logging started: ${logger.fileName}\n`);
    }
}

async function stopLogging() {
    await logger.stop();
    state.isLogging = false;
    ui.btnLog.innerHTML = '<span class="icon">💾</span> Start Logging';
    ui.btnLog.classList.remove('btn-primary');
    ui.logFilename.textContent = '--';
    updateTerminal(`[SYSTEM] Logging saved.\n`);
}

ui.btnClearTerm.addEventListener('click', () => {
    ui.terminal.textContent = '';
});

// INITIALIZATION
window.addEventListener('DOMContentLoaded', () => {
    initCharts();
    console.log("App Initialized (Bundled)");
    // Small delay to ensure styles are applied
    setTimeout(() => {
        showToast("System Ready", "success");
    }, 500);
});
