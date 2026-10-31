/* global AggregateError */
const failure = (code, message) => Object.assign(new Error(message), {code});

/**
 * Create an owned iframe service from host-verified code. The caller supplies the
 * host's authorization boundary; this module never decides URL trust or mode.
 * Worker initialization is scoped to this channel instead of the shared FIFO.
 * @param {object} manager Owning extension manager.
 * @param {object} dispatch Owning central dispatcher.
 * @param {object} options Verified code, ID and lifecycle settings.
 * @param {Function} createWorker Optional test factory.
 * @returns {Promise<object>} Owned remote service and disposal boundary.
 */
const loadHostSandboxedExtension = (manager, dispatch, {id, code, signal, timeoutMs = 30000}, createWorker) => {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(id) || typeof code !== 'string' ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        return Promise.reject(failure('INVALID_SANDBOX_REQUEST', 'A verified ID and code are required'));
    }
    if (signal && signal.aborted) return Promise.reject(failure('CANCELLED', 'Sandbox registration cancelled'));
    // Static require keeps the iframe bootstrap inside single-HTML scaffolding.
    const Worker = createWorker || require('./tw-iframe-extension-worker');
    const worker = new Worker();
    const workerId = manager.nextExtensionWorker++;
    const url = `data:application/javascript;charset=utf-8,${encodeURIComponent(code)}`;
    manager.workerURLs[workerId] = url;
    if (worker.iframe) {
        worker.iframe.dataset.testid = 'tw-plus-sandbox-frame';
        worker.iframe.dataset.extensionId = id;
    }
    const names = new Set();
    const responses = new Set();
    const post = worker.postMessage.bind(worker);
    let active = true;
    let allocated = false;
    let info;
    let service;
    let registration;
    let initialized = false;
    let resolve;
    let reject;
    const ready = new Promise((yes, no) => {
        resolve = yes; reject = no;
    });
    let settled = false;
    const waiting = {};
    const stopWaiting = () => {
        clearTimeout(waiting.timer);
        if (signal) signal.removeEventListener('abort', waiting.abort);
    };
    const dispose = () => {
        if (!active) return;
        active = false;
        stopWaiting();
        const errors = [];
        for (const name of names) {
            if (dispatch.services[name] === worker) {
                delete dispatch.services[name];
            } else {
                errors.push(failure('HOST_RECOVERY_REQUIRED', 'Owned sandbox service was replaced'));
            }
        }
        dispatch.workers = dispatch.workers.filter(item => item !== worker);
        for (const responseId of responses) {
            const callbacks = dispatch.callbacks[responseId];
            if (callbacks) {
                delete dispatch.callbacks[responseId];
                callbacks[1](failure('EXTENSION_UNLOADED', 'The sandbox service was unloaded'));
            }
        }
        responses.clear();
        if (manager.workerURLs[workerId] === url) delete manager.workerURLs[workerId];
        worker.terminate();
        if (errors.length) throw new AggregateError(errors, 'Sandbox service cleanup failed');
    };
    const fail = cause => {
        if (settled) return;
        settled = true;
        try {
            dispose();
        } catch (cleanupError) {
            cause = new AggregateError([cause, cleanupError], 'Sandbox initialization and cleanup failed');
        }
        reject(cause);
    };
    waiting.abort = () => fail(failure('CANCELLED', 'Sandbox registration cancelled'));
    const reply = (message, result, error) => {
        if (active) {
            post(error ? {responseId: message.responseId, error: String(error)} :
                {responseId: message.responseId, result});
        }
    };
    const complete = () => {
        if (settled || !initialized || !info || !service) return;
        settled = true;
        stopWaiting();
        resolve(Object.freeze({id, info, service, workerId, dispose}));
    };
    worker.postMessage = (message, transfer) => {
        if (!active) throw failure('EXTENSION_UNLOADED', 'The sandbox service was unloaded');
        if (message.service && typeof message.responseId !== 'undefined') responses.add(message.responseId);
        return post(message, transfer);
    };
    worker.onmessage = event => {
        if (!active) return;
        const message = event.data;
        if (!message || typeof message !== 'object') return;
        if (!message.service) {
            // A sandbox cannot inject a response into another channel's pending call.
            if (!responses.has(message.responseId)) return;
            responses.delete(message.responseId);
            dispatch._onMessage(worker, event);
            return;
        }
        const args = message.args || [];
        try {
            if (message.service === 'extensions' && message.method === 'allocateWorker') {
                if (allocated) throw failure('REGISTRATION_FAILED', 'Sandbox allocated twice');
                allocated = true;
                reply(message, [workerId, url]);
            } else if (message.service === 'dispatch' && message.method === 'setService') {
                const name = args[0];
                if (!allocated || name !== `extension.${workerId}.0` || names.size ||
                    Object.prototype.hasOwnProperty.call(dispatch.services, name)) {
                    throw failure('REGISTRATION_FAILED', 'Exactly one owned sandbox service must register');
                }
                names.add(name);
                dispatch.setServiceSync(name, worker);
                reply(message);
            } else if (message.service === 'extensions' && message.method === 'registerExtensionService') {
                const name = args[0];
                if (!names.has(name) || registration) {
                    throw failure('REGISTRATION_FAILED', 'Sandbox registration is not owned');
                }
                registration = dispatch.call(name, 'getInfo').then(metadata => {
                    if (!active) return;
                    if (!metadata || metadata.id !== id) {
                        throw failure('REGISTRATION_ID_MISMATCH', 'Extension getInfo().id differs from its Manifest');
                    }
                    if (manager.isBuiltinExtension(id) || manager._loadedExtensions.has(id)) {
                        throw failure('ID_CONFLICT', 'Extension ID is already registered');
                    }
                    info = metadata;
                    service = name;
                    reply(message);
                    complete();
                })
                    .catch(error => {
                        reply(message, null, error); fail(error);
                    });
            } else if (message.service === 'extensions' && message.method === 'onWorkerInit') {
                if (args[0] !== workerId || args[1]) {
                    throw failure('REGISTRATION_FAILED', String(args[1] || 'Sandbox worker ID differs'));
                }
                initialized = true;
                reply(message);
                complete();
            } else {
                // No worker may select another VM service or reconstruct Scratch.vm through RPC.
                reply(message, null, failure('PERMISSION_DENIED', 'This sandbox cannot call host services'));
            }
        } catch (error) {
            reply(message, null, error); fail(error);
        }
    };
    dispatch.workers.push(worker);
    waiting.timer = setTimeout(() => fail(failure('REGISTRATION_TIMEOUT',
        'Sandbox extension did not register')), timeoutMs);
    if (signal) signal.addEventListener('abort', waiting.abort, {once: true});
    dispatch._remoteCall(worker, 'dispatch', 'handshake').catch(fail);
    return ready;
};

module.exports = loadHostSandboxedExtension;
