// App State
const state = {
    cuffChart: null,
    pulseChart: null,
    isLogging: false,
    isPaused: false,
    isMonitoring: false, // New state for threshold logic
    monitoringThreshold: 25, // Default Threshold
    startTime: null, // For timer
    timerInterval: null // For live timer updates
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
    btnStart: document.getElementById('btn-start'),
    btnAbort: document.getElementById('btn-abort'),
    btnLinear: document.getElementById('btn-linear'),
    btnClearGraphs: document.getElementById('btn-clear-graphs'),

    // Readouts
    cuffValue: document.getElementById('cuff-pressure'),
    maxValue: document.getElementById('max-pressure'),
    durationValue: document.getElementById('duration-value'),
    btnFindMax: document.getElementById('btn-find-max'),
};

/**
 * Initialize Charts
 */
function initCharts() {
    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
            legend: { display: false },
            tooltip: { mode: 'index', intersect: false }
        },
        scales: {
            x: {
                grid: { display: false }, // No Grids
                ticks: { display: false }
            },
            y: {
                grid: { display: false }, // No Grids
                ticks: { color: '#94a3b8' },
            }
        }
    };

    // Cuff Chart
    const ctxCuff = document.getElementById('cuffChart').getContext('2d');
    const gradCuff = ctxCuff.createLinearGradient(0, 0, 0, 200);
    gradCuff.addColorStop(0, 'rgba(59, 130, 246, 0.5)'); // Blue
    gradCuff.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

    state.cuffChart = new Chart(ctxCuff, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                data: [],
                borderColor: '#3b82f6',
                backgroundColor: gradCuff,
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                tension: 0.3
            }, {
                data: [], // Marker Dataset
                borderColor: 'transparent',
                backgroundColor: '#ef4444',
                pointRadius: 6,
                pointHoverRadius: 8,
                fill: false,
                type: 'line' // or scatter
            }]
        },
        options: commonOptions
    });

    // Pulse Chart
    const ctxPulse = document.getElementById('pulseChart').getContext('2d');
    const gradPulse = ctxPulse.createLinearGradient(0, 0, 0, 200);
    gradPulse.addColorStop(0, 'rgba(16, 185, 129, 0.5)'); // Emerald Green
    gradPulse.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

    state.pulseChart = new Chart(ctxPulse, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                data: [],
                borderColor: '#10b981',
                backgroundColor: gradPulse,
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                tension: 0.3
            }, {
                data: [], // Marker Dataset
                borderColor: 'transparent',
                backgroundColor: '#ef4444',
                pointRadius: 6,
                pointHoverRadius: 8,
                fill: false,
                type: 'line'
            }]
        },
        options: commonOptions
    });
}

/**
 * Handle incoming serial data packet
 * @param {Object} data {cuff, pulse}
 */
function handleSerialData(data) {
    const { cuff, pulse } = data;

    // 1. Update Readout
    if (ui.cuffValue) {
        ui.cuffValue.textContent = cuff.toFixed(2);
    }

    // 2. Logging
    if (state.isLogging) {
        const time = new Date().toISOString();
        const csvLine = `${time},${cuff},${pulse}\n`;
        logger.write(csvLine);
        ui.logBytes.textContent = logger.bytesWritten.toLocaleString();
    }



    // 3. Update Charts
    // 3. Update Charts
    if (!state.isPaused) {
        // Threshold Check: Only start visualization if Cuff > Threshold
        if (cuff > state.monitoringThreshold) {
            state.isMonitoring = true;
        }

        // If monitoring started (or pressure allows), buffer data
        // Optimization: Buffer data instead of direct update
        if (state.isMonitoring) {
            requestChartUpdate(cuff, pulse);
        }

        // Reset monitoring if pressure drops very low? User didn't ask, but "happen only after 25" usually means "wait for start".
        // I will stick to "wait for start".
    }
}

// Data Buffers for Render Loop
const chartBuffer = {
    cuff: [],
    pulse: []
};
let animationFrameId = null;

function requestChartUpdate(cuff, pulse) {
    chartBuffer.cuff.push(cuff);
    chartBuffer.pulse.push(pulse);

    if (!animationFrameId) {
        animationFrameId = requestAnimationFrame(renderLoop);
    }
}

function renderLoop() {
    animationFrameId = null;

    // Batch Update
    const cuffData = chartBuffer.cuff;
    const pulseData = chartBuffer.pulse;

    if (cuffData.length === 0) return;

    updateChartBatch(state.cuffChart, cuffData);
    updateChartBatch(state.pulseChart, pulseData);

    // Clear buffers
    chartBuffer.cuff = [];
    chartBuffer.pulse = [];
}

function updateChartBatch(chart, newValues) {
    const data = chart.data.datasets[0].data;
    const labels = chart.data.labels;
    const MAX_POINTS = 3000; // Optimized history limit

    // Bulk push
    for (let i = 0; i < newValues.length; i++) {
        labels.push('');
        data.push(newValues[i]);
    }

    // Bulk shift
    const removeCount = labels.length - MAX_POINTS;
    if (removeCount > 0) {
        labels.splice(0, removeCount);
        data.splice(0, removeCount);

        // Also shift marker dataset if it exists and has data
        if (chart.data.datasets[1] && chart.data.datasets[1].data.length > 0) {
            // If we have sparse data, this is tricky. State-based marker (one point) is easier to just re-calc or clear.
            // If we rely on index, shifting data breaks index.
            // Given "Find Max" pauses graph, shifting shouldn't happen while marker is visible!
            // So we can safely ignore marker shifting for now as it's cleared on Resume.
        }
    }

    chart.update('none');
}

/**
 * Connect Button Logic
 */
ui.btnConnect.addEventListener('click', async () => {
    if (serial.port) {
        // Disconnect
        await serial.disconnect();
        return;
    }

    if (!SerialManager.isSupported()) {
        alert('Web Serial API not supported in this browser. Please use Chrome or Edge.');
        return;
    }

    const baud = ui.baudRate.value;
    const result = await serial.connect(baud);

    // Check if result is object (new logic) or boolean (fallback)
    const success = (typeof result === 'object') ? result.success : result;

    if (success) {
        ui.statusLight.classList.remove('disconnected');
        ui.statusLight.classList.add('connected');
        ui.statusText.textContent = 'Connected';
        ui.btnConnect.innerHTML = '<span class="icon">❌</span> Disconnect';
        ui.btnConnect.classList.replace('btn-primary', 'btn-secondary');
        ui.baudRate.disabled = true;
        ui.btnLog.disabled = false; // Enable Logging

        // Toast Message
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
    // 1. Try to show popup
    console.log("Showing Toast:", msg, type);
    const toast = document.getElementById('toast');
    const msgEl = document.getElementById('toast-message');
    if (toast && msgEl) {
        msgEl.textContent = msg;
        toast.className = 'toast'; // reset
        if (type === 'error') toast.classList.add('error');
        void toast.offsetWidth; // trigger reflow
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // 2. LOG TO TERMINAL (Backup)
    const timestamp = new Date().toLocaleTimeString();
    const prefix = type === 'error' ? '❌' : '✅';
    updateTerminal(`\n[${timestamp}] ${prefix} ${msg}\n`);
}

serial.onDataCallback = handleSerialData;
serial.onDisconnectCallback = () => {
    ui.statusLight.classList.remove('connected');
    ui.statusLight.classList.add('disconnected');
    ui.statusText.textContent = 'Disconnected';
    ui.btnConnect.innerHTML = '<span class="icon">🔌</span> Connect Device';
    ui.btnConnect.classList.replace('btn-secondary', 'btn-primary');
    ui.baudRate.disabled = false;
    ui.btnLog.disabled = true; // Disable Logging

    // Stop logging if active
    if (state.isLogging) stopLogging();

    showToast('Device Disconnected', 'error');
};

/**
 * Logging Button Logic
 */
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
        // Write CSV Header
        await logger.write("Timestamp,CuffPressure,PulsePressure\n");

        state.isLogging = true;
        ui.btnLog.innerHTML = '<span class="icon">⏹</span> Stop Logging';
        ui.btnLog.classList.add('btn-primary'); // Make it active looking
        ui.logFilename.textContent = logger.fileName;
        ui.logBytes.textContent = '0';
    }
}

async function stopLogging() {
    await logger.stop();
    state.isLogging = false;
    ui.btnLog.innerHTML = '<span class="icon">💾</span> Start Logging';
    ui.btnLog.classList.remove('btn-primary');
    ui.logFilename.textContent = '--';
}

/**
 * Misc UI
 */
ui.btnClearTerm.addEventListener('click', () => {
    ui.terminal.textContent = '';
});

/**
 * Timer Helpers
 */
function startTimer() {
    // Clear existing
    if (state.timerInterval) clearInterval(state.timerInterval);

    state.startTime = Date.now();
    ui.durationValue.textContent = "0.0s";

    // Update every 100ms
    state.timerInterval = setInterval(() => {
        const diff = (Date.now() - state.startTime) / 1000;
        ui.durationValue.textContent = diff.toFixed(1) + "s";
    }, 100);
}

function stopTimer() {
    if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
    }

    // Final update for precision
    if (state.startTime) {
        const diff = (Date.now() - state.startTime) / 1000;
        ui.durationValue.textContent = diff.toFixed(1) + "s";
        state.startTime = null;
    } else {
        ui.durationValue.textContent = "--";
    }
}

function resetSessionUI() {
    // Auto-resume if paused (e.g. by Find Max)
    if (state.isPaused) {
        state.isPaused = false;
        // Reset Find Max Button UI
        ui.btnFindMax.innerHTML = '<span class="icon">🎯</span> Find Max';
        ui.btnFindMax.classList.remove('btn-primary');
        ui.cuffValue.previousElementSibling.textContent = "Cuff Pressure";

        // Clear Markers
        state.cuffChart.data.datasets[1].data = [];
        state.pulseChart.data.datasets[1].data = [];

        state.cuffChart.update();
        state.pulseChart.update();
    }
    ui.maxValue.textContent = "--"; // Reset Max
}

/**
 * Control Buttons logic
 */
ui.btnStart.addEventListener('click', async () => {
    if (serial.port) {
        resetSessionUI();

        await serial.write(new Uint8Array([1]));
        state.monitoringThreshold = 25; // Set threshold for Start

        startTimer();
        showToast('Sent: START (1)', 'success');
    } else {
        showToast('Device not connected', 'error');
    }
});

ui.btnAbort.addEventListener('click', async () => {
    if (serial.port) {
        await serial.write(new Uint8Array([2]));

        stopTimer();

        // Stop logging if active
        if (state.isLogging) {
            await stopLogging();
        }

        showToast('Sent: ABORT (2)', 'error');
    } else {
        showToast('Device not connected', 'error');
    }
});

ui.btnLinear.addEventListener('click', async () => {
    if (serial.port) {
        resetSessionUI();

        await serial.write(new Uint8Array([3]));
        state.monitoringThreshold = 250; // Set threshold for Linear Deflation

        startTimer();
        showToast('Sent: LINEAR DEFLATION (3)', 'success');
    } else {
        showToast('Device not connected', 'error');
    }
});



/**
 * Clear Graphs Button Logic
 */
ui.btnClearGraphs.addEventListener('click', () => {
    // Clear data buffers
    state.cuffChart.data.labels = [];
    state.cuffChart.data.datasets.forEach(ds => ds.data = []);
    state.pulseChart.data.labels = [];
    state.pulseChart.data.datasets.forEach(ds => ds.data = []);

    // Reset Logic
    state.isMonitoring = false; // Wait for Threshold again
    chartBuffer.cuff = [];
    chartBuffer.pulse = [];

    // Update charts
    state.cuffChart.update();
    state.pulseChart.update();
});

/**
 * Find Max Button Logic
 */
ui.btnFindMax.addEventListener('click', () => {
    if (state.isPaused) {
        // RESUME
        state.isPaused = false;
        ui.btnFindMax.innerHTML = '<span class="icon">🎯</span> Find Max';
        ui.btnFindMax.classList.remove('btn-primary');
        ui.maxValue.textContent = "--"; // Reset Max Display
        ui.cuffValue.previousElementSibling.textContent = "Cuff Pressure"; // Reset Label

        // Clear Markers
        state.cuffChart.data.datasets[1].data = [];
        state.pulseChart.data.datasets[1].data = [];

        state.cuffChart.update();
        state.pulseChart.update();
    } else {
        // PAUSE & FIND MAX
        state.isPaused = true;
        ui.btnFindMax.innerHTML = '<span class="icon">▶</span> Resume';
        ui.btnFindMax.classList.add('btn-primary');

        // Logic
        const pulseData = state.pulseChart.data.datasets[0].data;
        const cuffData = state.cuffChart.data.datasets[0].data;

        if (pulseData.length === 0) return;

        // Find Max in Pulse
        let maxVal = -Infinity;
        let maxIdx = -1;
        for (let i = 0; i < pulseData.length; i++) {
            if (pulseData[i] > maxVal) {
                maxVal = pulseData[i];
                maxIdx = i;
            }
        }

        if (maxIdx !== -1) {
            // Get corresponding values
            const targetCuffVal = cuffData[maxIdx];

            // Setup Marker Arrays (same length as main data, filled with nulls usually, but Chart.js sparse is better)
            // Actually, for line chart with category/index axis, we can just spare array or use object {x, y} but here x is index.
            // Simplest for sync: Create array of nulls, set one value.

            const markerDataPulse = new Array(pulseData.length).fill(null);
            markerDataPulse[maxIdx] = maxVal;

            const markerDataCuff = new Array(cuffData.length).fill(null);
            markerDataCuff[maxIdx] = targetCuffVal;

            state.pulseChart.data.datasets[1].data = markerDataPulse;
            state.cuffChart.data.datasets[1].data = markerDataCuff;

            state.pulseChart.update();
            state.cuffChart.update();

            // Show Value
            ui.maxValue.textContent = targetCuffVal.toFixed(2);
            showToast(`MAP Found! Pressure: ${targetCuffVal.toFixed(2)}`, 'success');
        }
    }
});

// Init
initCharts();
console.log("App Initialized");
setTimeout(() => showToast("System Ready - Test Popup", "success"), 1000);
