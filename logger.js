/**
 * Logger class
 * Handles writing data streams to a local file using the File System Access API.
 */
class Logger {
    constructor() {
        this.fileHandle = null;
        this.writable = null;
        this.bytesWritten = 0;
        this.fileName = null;
    }

    /**
     * Open a file picker to save a new file.
     * @returns {Promise<boolean>} Success status
     */
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

    /**
     * Start the write stream.
     */
    async start() {
        if (!this.fileHandle) return false;
        this.writable = await this.fileHandle.createWritable();
        this.bytesWritten = 0;
        return true;
    }

    /**
     * Append text data to the file.
     * @param {string} data 
     */
    async write(data) {
        if (!this.writable) return;
        await this.writable.write(data);
        this.bytesWritten += data.length;
    }

    /**
     * Close the file.
     */
    async stop() {
        if (this.writable) {
            await this.writable.close();
            this.writable = null;
        }
        this.fileHandle = null;
        this.fileName = null;
    }
}
