const {test} = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../src/extension-support/tw-host-sandboxed-extension');
const Dispatcher = require('../../src/dispatch/central-dispatch').constructor;

const setup = ({metadataId = 'sample', silent = false, duplicate = false} = {}) => {
    const dispatch = new Dispatcher();
    const manager = {nextExtensionWorker: 0,
        workerURLs: [],
        _loadedExtensions: new Map(),
        isBuiltinExtension: () => false};
    const workers = [];
    class Worker {
        constructor () {
            this.isRemote = true;
            this.iframe = {dataset: {}};
            this.callbacks = new Map();
            this.nextId = 10000;
            this.terminated = false;
            workers.push(this);
        }
        postMessage (message) {
            if (silent) return;
            if (message.service) {
                queueMicrotask(() => this.onmessage({data: {responseId: message.responseId,
                    result: message.method === 'getInfo' ? {id: metadataId, blocks: []} : 42}}));
                if (message.method === 'handshake') this.run().catch(() => {});
            } else {
                const callback = this.callbacks.get(message.responseId);
                if (!callback) return;
                this.callbacks.delete(message.responseId);
                if (message.error) callback.reject(new Error(message.error));
                else callback.resolve(message.result);
            }
        }
        request (service, method, args = []) {
            return new Promise((resolve, reject) => {
                const responseId = this.nextId++;
                this.callbacks.set(responseId, {resolve, reject});
                queueMicrotask(() => this.onmessage({data: {service, method, args, responseId}}));
            });
        }
        async run () {
            const [id] = await this.request('extensions', 'allocateWorker');
            const service = `extension.${id}.0`;
            await this.request('dispatch', 'setService', [service]);
            if (duplicate) await this.request('dispatch', 'setService', [service]);
            await this.request('extensions', 'registerExtensionService', [service]);
            await this.request('extensions', 'onWorkerInit', [id]);
        }
        terminate () {
            this.terminated = true;
            this.onmessage = () => {};
        }
    }
    return {dispatch, manager, Worker, workers};
};

test('owned sandbox RPC registers only its ID and releases service, worker URL and frame', async () => {
    const {manager, dispatch, Worker, workers} = setup();
    const owned = await load(manager, dispatch, {id: 'sample', code: 'verified code'}, Worker);
    assert.equal(owned.id, 'sample');
    assert.equal(owned.info.id, 'sample');
    assert.equal(dispatch.workers.length, 1);
    assert.equal(await dispatch.call(owned.service, 'value'), 42);
    assert.equal(workers[0].iframe.dataset.testid, 'tw-plus-sandbox-frame');
    assert.equal(workers[0].iframe.dataset.extensionId, 'sample');
    await assert.rejects(workers[0].request('runtime', 'getEditingTarget'),
        /PERMISSION_DENIED|cannot call host services/);
    owned.dispose();
    owned.dispose();
    assert.equal(workers[0].terminated, true);
    assert.deepEqual(Object.keys(dispatch.services), []);
    assert.deepEqual(Object.keys(dispatch.callbacks), []);
    assert.equal(dispatch.workers.length, 0);
    assert.deepEqual(Object.keys(manager.workerURLs), []);
});

test('ID mismatch and extra registration remove all owned resources without VM registration', async () => {
    for (const options of [{metadataId: 'impostor'}, {duplicate: true}]) {
        const {manager, dispatch, Worker, workers} = setup(options);
        await assert.rejects(load(manager, dispatch, {id: 'sample', code: 'verified code'}, Worker),
            error => ['REGISTRATION_ID_MISMATCH', 'REGISTRATION_FAILED'].includes(error.code));
        assert.equal(workers[0].terminated, true);
        assert.equal(manager._loadedExtensions.size, 0);
        assert.deepEqual(Object.keys(dispatch.services), []);
        assert.equal(dispatch.workers.length, 0);
        assert.deepEqual(Object.keys(manager.workerURLs), []);
    }
});

test('sandbox responses cannot resolve or remove a different channel callback', async () => {
    const {manager, dispatch, Worker, workers} = setup();
    const owned = await load(manager, dispatch, {id: 'sample', code: 'verified code'}, Worker);
    let injected = false;
    const foreignId = dispatch._storeCallbacks(() => {
        injected = true;
    }, () => {
        injected = true;
    });
    const foreignCallback = dispatch.callbacks[foreignId];
    workers[0].onmessage({data: {responseId: foreignId, result: 'forged'}});
    workers[0].onmessage({data: {responseId: 999999, result: 'unknown'}});
    assert.equal(injected, false);
    assert.equal(dispatch.callbacks[foreignId], foreignCallback);
    assert.equal(await dispatch.call(owned.service, 'value'), 42);
    owned.dispose();
    assert.equal(dispatch.callbacks[foreignId], foreignCallback);
    delete dispatch.callbacks[foreignId];
});

test('timeout and cancellation dispose a stalled worker and reject pending RPC', async () => {
    for (const abort of [false, true]) {
        const {manager, dispatch, Worker, workers} = setup({silent: true});
        const controller = new AbortController();
        const loading = load(manager, dispatch, {id: 'sample',
            code: 'verified code',
            signal: controller.signal,
            timeoutMs: 5}, Worker);
        if (abort) controller.abort();
        await assert.rejects(loading, {code: abort ? 'CANCELLED' : 'REGISTRATION_TIMEOUT'});
        assert.equal(workers[0].terminated, true);
        assert.deepEqual(Object.keys(dispatch.callbacks), []);
        assert.deepEqual(Object.keys(dispatch.services), []);
        assert.equal(dispatch.workers.length, 0);
    }
});
