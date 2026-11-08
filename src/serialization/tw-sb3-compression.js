const CompressedObject = require('@turbowarp/jszip/lib/compressedObject');
const GenericWorker = require('@turbowarp/jszip/lib/stream/GenericWorker');
const crc32 = require('@turbowarp/jszip/lib/crc32');
const {utf8encode} = require('@turbowarp/jszip/lib/utf8');

const MIN_PROJECT_BYTES = 256 * 1024;
const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 1000;
// Match JSZip DataWorker's string chunk boundaries when encoding project JSON.
const CHUNK_SIZE = 64 * 1024;
const COMPRESSION_SLICE_MS = 8;

const yieldToBrowser = () => {
    const scheduler = typeof window === 'undefined' ? null : window.scheduler;
    return scheduler && typeof scheduler.yield === 'function' ?
        scheduler.yield() : new Promise(resolve => setTimeout(resolve, 0));
};

/**
 * Prepare a compressed source before JSZip emits any bytes for the entry.
 * Keep the stream info object JSZip assigned to this file, even if the underlying source changes.
 */
class ProjectCompressionWorker extends GenericWorker {
    constructor (prepare, compression) {
        super('Prepare project.json compression');
        this.prepare = prepare;
        this.controller = new AbortController();
        this.withStreamInfo('compression', compression);
    }

    resume () {
        if (!super.resume()) return false;
        if (this.prepare) {
            const prepare = this.prepare;
            this.prepare = null;
            prepare(this.controller.signal).then(source => {
                if (this.isFinished || this.generatedError) return;
                this.previous = source;
                Object.assign(this.streamInfo, source.streamInfo);
                source.on('data', chunk => this.push(chunk));
                source.on('end', () => {
                    Object.assign(this.streamInfo, source.streamInfo);
                    this.end();
                });
                source.on('error', error => this.error(error));
                if (this.isLocked) source.lock();
                if (!this.isPaused) source.resume();
            })
                .catch(error => this.error(error));
        }
        return true;
    }

    error (error) {
        this.controller.abort();
        return super.error(error);
    }
}

const nativeSource = async (entry, compression, signal) => {
    const data = await entry._data;
    const text = typeof data === 'string';
    if (text ? entry._dataBinary : !entry._dataBinary || !(data instanceof Uint8Array)) return;
    // A string's length is a lower bound on its encoded size.
    if (data.length < MIN_PROJECT_BYTES || data.length > MAX_PROJECT_BYTES) return;
    const compressor = new CompressionStream('deflate-raw');
    signal.throwIfAborted();
    let offset = 0;
    let uncompressedSize = 0;
    let checksum = 0;
    let sliceStart = performance.now();
    const input = new ReadableStream({
        async pull (controller) {
            if (offset === data.length) {
                controller.close();
                return;
            }
            // CompressionStream can process many consecutive writes in one browser task.
            if (performance.now() - sliceStart >= COMPRESSION_SLICE_MS) {
                await yieldToBrowser();
                signal.throwIfAborted();
                // The stream waits for this pull to finish before calling it again.
                // eslint-disable-next-line require-atomic-updates
                sliceStart = performance.now();
            }
            const end = Math.min(offset + CHUNK_SIZE, data.length);
            const chunk = text ? utf8encode(data.substring(offset, end)) : data.subarray(offset, end);
            uncompressedSize += chunk.length;
            if (uncompressedSize > MAX_PROJECT_BYTES) {
                controller.error(new Error('Native compression input is too large'));
                return;
            }
            checksum = crc32(chunk, checksum);
            controller.enqueue(chunk);
            offset = end;
        }
    });
    const compressed = new Uint8Array(await new Response(input.pipeThrough(compressor, {signal})).arrayBuffer());
    // A different encoder must not push an entry over the project's ZIP expansion limit.
    if (compressed.length >= uncompressedSize || uncompressedSize > compressed.length * MAX_EXPANSION_RATIO) return;
    const content = new CompressedObject(compressed.length, uncompressedSize, checksum, compression, compressed);
    return content.getCompressedWorker();
};

/**
 * Use native DEFLATE for the final project JSON where the browser and entry permit it.
 * @param {JSZip} zip The project ZIP after host hooks have added or replaced its entries.
 * @returns {JSZip} The project ZIP.
 */
module.exports = function useNativeProjectCompression (zip) {
    if (typeof CompressionStream !== 'function' || typeof AbortController !== 'function') return zip;
    const project = zip.file('project.json');
    if (!project || typeof project._compressWorker !== 'function') return zip;
    const legacy = project._compressWorker.bind(project);
    project._compressWorker = (compression, options) => {
        if (compression.magic !== '\x08\x00' || 'level' in options) return legacy(compression, options);
        return new ProjectCompressionWorker(async signal => {
            const source = await nativeSource(project, compression, signal).catch(() => null);
            if (!signal.aborted) return source || legacy(compression, options);
        }, compression);
    };
    return zip;
};
