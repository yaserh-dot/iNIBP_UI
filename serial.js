/**
 * SerialManager class
 * Encapsulates Web Serial API logic with Binary Protocol support.
 */
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

    /**
     * Checks if Web Serial is supported.
     */
    static isSupported() {
        return 'serial' in navigator;
    }

    /**
     * Request a port and connect.
     * @param {number} baudRate 
     */
    async connect(baudRate = 9600) {
        try {
            // Request port (user gesture required)
            this.port = await navigator.serial.requestPort();

            // Open port
            await this.port.open({ baudRate: parseInt(baudRate) });

            // Setup read loop
            this.startReading();

            // Get Info (VID/PID)
            const info = this.port.getInfo();

            // Handle unplanned disconnects (cable pulled)
            this.port.addEventListener('disconnect', () => {
                this.disconnectFromHardware();
            });

            return { success: true, info };
        } catch (error) {
            console.warn('Connection failed or cancelled:', error);
            return { success: false, error };
        }
    }

    /**
     * Start the read loop.
     */
    async startReading() {
        this.isReading = true;
        this.reader = this.port.readable.getReader();

        try {
            while (true) {
                const { value, done } = await this.reader.read();
                if (done) {
                    break;
                }
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

    /**
     * Handle incoming raw bytes and look for packets.
     * Packet format: Start(0xAA) | Len(8) | Cuff(4) | Pulse(4) | Checksum
     * Total = 11 bytes
     * @param {Uint8Array} chunk 
     */
    processIncomingChunk(chunk) {
        // Append to buffer
        if (this.rxHead + chunk.length > this.rxBuffer.length) {
            // Simple safety: Reset if buffer overflows
            // Ideally, we should shift data or use a ring buffer, but for typical packet sizes 4096 is plenty
            console.warn('Buffer overflow, resetting');
            this.rxHead = 0;
        }
        this.rxBuffer.set(chunk, this.rxHead);
        this.rxHead += chunk.length;

        // Try to find packets
        let searchIdx = 0;

        // Loop while we have enough bytes for at least one packet (11 bytes)
        while (searchIdx <= this.rxHead - 11) {
            // Check for Start Byte
            if (this.rxBuffer[searchIdx] === 0xAA) {
                // Check Packet Length (Byte 1, should be 8)
                const payloadLen = this.rxBuffer[searchIdx + 1];
                if (payloadLen === 8) {
                    // Check Checksum
                    if (this.verifyChecksum(searchIdx)) {
                        // Found a valid packet!
                        this.parsePacket(searchIdx);
                        searchIdx += 11; // Move past this packet
                        continue;
                    }
                }
            }
            // If not a packet, move forward one byte
            searchIdx++;
        }

        // Shift remaining bytes to start of buffer
        if (searchIdx > 0) {
            // rxHead - searchIdx = bytes remaining
            this.rxBuffer.copyWithin(0, searchIdx, this.rxHead);
            this.rxHead -= searchIdx;
        }
    }

    verifyChecksum(idx) {
        let checksum = 0;
        // XOR first 10 bytes (0 to 9)
        for (let i = 0; i < 10; i++) {
            checksum ^= this.rxBuffer[idx + i];
        }
        // Compare with 11th byte (index 10)
        return checksum === this.rxBuffer[idx + 10];
    }

    parsePacket(idx) {
        const view = new DataView(this.rxBuffer.buffer, idx, 11);

        // Structure: [AA] [08] [Cuff:4] [Pulse:4] [CS]
        // Bytes 2-5: Cuff Pressure (int32)
        // Bytes 6-9: Pulse Pressure (int32)

        // User code: packet[idx++] = (a >> 0) & 0xFF; -> Little Endian
        const cuffInt = view.getInt32(2, true);
        const pulseInt = view.getInt32(6, true);

        // Convert back to float
        const cuff = cuffInt / 100.0;
        const pulse = pulseInt / 100.0;

        if (this.onDataCallback) {
            this.onDataCallback({ cuff, pulse });
        }
    }

    /**
     * Disconnect gracefully.
     */
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

    /**
     * Internal helper when hardware disconnects externally.
     */
    disconnectFromHardware() {
        if (this.onDisconnectCallback) this.onDisconnectCallback();
        this.port = null;
        this.reader = null; // Port already closed by browser logic usually
    }
    /**
     * Send data to the device.
     * @param {string|Uint8Array} data 
     */
    async write(data) {
        if (!this.port || !this.port.writable) {
            console.warn('Port not writable');
            return false;
        }

        const writer = this.port.writable.getWriter();
        try {
            if (typeof data === 'string') {
                const encoder = new TextEncoder();
                await writer.write(encoder.encode(data));
            } else {
                await writer.write(data);
            }
            return true;
        } catch (error) {
            console.error('Write error:', error);
            return false;
        } finally {
            writer.releaseLock();
        }
    }
}
