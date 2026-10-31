/* global AggregateError */
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const failure = (code, message) => Object.assign(new Error(message), {code});
const active = new WeakSet();
const TABLES = ['_primitives', '_hats', '_flowing'];
const parseService = service => {
    if (typeof service !== 'string') return null;
    const match = /^(unsandboxed|extension)\.([0-9]+)\.([a-zA-Z0-9]+)$/.exec(service);
    return match && Number.isSafeInteger(Number(match[2])) ?
        {kind: match[1], workerId: Number(match[2]), suffix: match[3]} : null;
};
const properties = (object, prefix) => Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(object))
    .filter(([key]) => key.startsWith(prefix)));

/**
 * Detach legacy registrations while retaining their services until a host commits.
 * The caller must have reviewed the replacement's exact bytes before invoking this port.
 * This boundary never authorizes or evaluates replacement JavaScript.
 * @param {object} manager Owning extension manager.
 * @param {object} dispatch Owning dispatcher.
 * @param {string[]} ids Complete legacy IDs to replace, including shared worker siblings.
 * @param {Map} owned Services already owned by the Plus host port.
 * @returns {object} Commit and rollback boundaries for this snapshot.
 */
const prepareLegacyReplacement = (manager, dispatch, ids, owned = new Map()) => {
    if (!Array.isArray(ids) || ids.length > 64 || new Set(ids).size !== ids.length ||
        ids.some(id => typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(id))) {
        throw failure('INVALID_LEGACY_REPLACEMENT', 'A bounded, unique legacy ID list is required');
    }
    if (!ids.length) return Object.freeze({commit: async () => {}, rollback: () => {}});
    if (active.has(manager)) throw failure('PROJECT_BUSY', 'A legacy replacement is already pending');
    const runtime = manager.runtime;
    if (!(manager._loadedExtensions instanceof Map) || !manager.workerURLs || !runtime ||
        !Array.isArray(runtime._blockInfo) || TABLES.some(name => !runtime[name]) ||
        !dispatch.services || !Array.isArray(dispatch.workers)) {
        throw failure('UNSUPPORTED_HOST', 'The VM does not expose legacy registration ownership');
    }
    const loaded = manager._loadedExtensions;
    const urls = manager.workerURLs;
    const services = dispatch.services;
    const tables = Object.fromEntries(TABLES.map(name => [name, runtime[name]]));
    const selected = new Set(ids);
    const records = ids.map(id => {
        const service = loaded.get(id);
        const parsed = parseService(service);
        const provider = services[service];
        if (manager.isBuiltinExtension(id) || !parsed || !own(services, service) || !provider ||
            owned.has(service) || (parsed.kind === 'unsandboxed' && parsed.suffix !== id) ||
            typeof urls[parsed.workerId] !== 'string') {
            throw failure('UNSUPPORTED_LEGACY_EXTENSION', `Legacy ownership is not proven for ${id}`);
        }
        const remote = parsed.kind === 'extension';
        if (remote ? !dispatch.workers.includes(provider) || typeof provider.terminate !== 'function' :
            dispatch.workers.includes(provider) || provider.isRemote) {
            throw failure('UNSUPPORTED_LEGACY_EXTENSION', `Legacy service type is inconsistent for ${id}`);
        }
        const entries = Object.fromEntries(TABLES.map(name => [name, properties(tables[name], `${id}_`)]));
        const compiler = Object.getOwnPropertyDescriptor(runtime, `ext_${id}`);
        if (Object.values(entries).some(table => Object.values(table).some(value => !value.configurable)) ||
            (compiler && !compiler.configurable)) {
            throw failure('UNSUPPORTED_LEGACY_EXTENSION', `Legacy runtime bindings cannot be detached for ${id}`);
        }
        return {id,
            service,
            provider,
            remote,
            workerId: parsed.workerId,
            url: urls[parsed.workerId],
            entries,
            compiler,
            categories: runtime._blockInfo.map((category, index) => ({category, index}))
                .filter(item => item.category.id === id)};
    });
    const requestedServices = new Set(records.map(record => record.service));
    const workerIds = new Set(records.map(record => record.workerId));
    for (const [id, service] of loaded) {
        const parsed = parseService(service);
        if (parsed && workerIds.has(parsed.workerId) && !selected.has(id)) {
            throw failure('LEGACY_SHARED_SOURCE',
                'Every extension sharing this legacy source must be replaced together');
        }
    }
    for (const record of records.filter(item => item.remote)) {
        if (Object.entries(services).some(([name, provider]) =>
            provider === record.provider && !requestedServices.has(name))) {
            throw failure('LEGACY_SHARED_SOURCE', 'The legacy worker also owns services outside this replacement');
        }
    }
    const checkOwnership = () => {
        if (manager.runtime !== runtime || manager._loadedExtensions !== loaded || manager.workerURLs !== urls ||
            dispatch.services !== services || TABLES.some(name => runtime[name] !== tables[name])) {
            throw failure('HOST_RECOVERY_REQUIRED', 'Legacy registration ownership changed');
        }
        for (const record of records) {
            if (services[record.service] !== record.provider || urls[record.workerId] !== record.url ||
                (record.remote && !dispatch.workers.includes(record.provider))) {
                throw failure('HOST_RECOVERY_REQUIRED', 'Legacy service or worker ownership changed');
            }
        }
        for (const [id, service] of loaded) {
            const parsed = parseService(service);
            if (parsed && workerIds.has(parsed.workerId) && (!selected.has(id) ||
                !records.some(record => record.id === id && record.service === service))) {
                throw failure('HOST_RECOVERY_REQUIRED', 'A legacy worker gained another registration');
            }
        }
    };
    let state = 'prepared';
    const checkRollback = () => {
        checkOwnership();
        for (const record of records) {
            if (loaded.has(record.id) || own(runtime, `ext_${record.id}`) ||
                runtime._blockInfo.some(category => category.id === record.id) ||
                TABLES.some(name => Object.keys(tables[name]).some(key => key.startsWith(`${record.id}_`)))) {
                throw failure('HOST_RECOVERY_REQUIRED',
                    'Replacement registration must be rolled back before restoring legacy state');
            }
        }
    };
    const restore = () => {
        for (const record of records) {
            for (const name of TABLES) Object.defineProperties(tables[name], record.entries[name]);
            if (record.compiler) Object.defineProperty(runtime, `ext_${record.id}`, record.compiler);
            loaded.set(record.id, record.service);
        }
        const categories = records.flatMap(record => record.categories).sort((a, b) => a.index - b.index);
        for (const {category, index} of categories) {
            if (!runtime._blockInfo.includes(category)) {
                runtime._blockInfo.splice(Math.min(index, runtime._blockInfo.length), 0, category);
            }
        }
    };
    checkOwnership();
    if (records.some(record => loaded.get(record.id) !== record.service)) {
        throw failure('HOST_RECOVERY_REQUIRED', 'Legacy ID ownership changed');
    }
    runtime.stopAll();
    checkOwnership();
    if (records.some(record => loaded.get(record.id) !== record.service)) {
        throw failure('HOST_RECOVERY_REQUIRED', 'Legacy ID ownership changed while stopping threads');
    }
    active.add(manager);
    try {
        for (const record of records) {
            for (const name of TABLES) for (const key of Object.keys(record.entries[name])) delete tables[name][key];
            delete runtime[`ext_${record.id}`];
            loaded.delete(record.id);
        }
        runtime._blockInfo = runtime._blockInfo.filter(category => !selected.has(category.id));
        runtime.resetAllCaches();
    } catch (error) {
        restore();
        active.delete(manager);
        throw error;
    }
    return Object.freeze({
        rollback () {
            if (state === 'rolled-back') return;
            if (state !== 'prepared') {
                throw failure('HOST_RECOVERY_REQUIRED', 'Retired legacy services cannot be restored');
            }
            checkRollback();
            restore();
            state = 'rolled-back';
            active.delete(manager);
            runtime.resetAllCaches();
        },
        async commit ({allowMissingReplacement = false} = {}) {
            if (state === 'committed') return;
            if (state !== 'prepared') {
                throw failure('HOST_RECOVERY_REQUIRED', 'Legacy replacement is already finalized');
            }
            checkOwnership();
            for (const record of records) {
                const replacement = loaded.get(record.id);
                const parsed = parseService(replacement);
                if ((!allowMissingReplacement && !parsed) || replacement === record.service ||
                    (parsed && (workerIds.has(parsed.workerId) || !own(services, replacement)))) {
                    throw failure('HOST_RECOVERY_REQUIRED',
                        'A new owned registration is required before retiring legacy services');
                }
            }
            const replacements = records.map(record => {
                const service = loaded.get(record.id);
                const parsed = parseService(service);
                return {id: record.id,
                    service,
                    provider: services[service],
                    workerId: parsed && parsed.workerId,
                    url: parsed && urls[parsed.workerId]};
            });
            state = 'committing';
            // Arbitrary dispose callbacks may have side effects. Never run them during reversible staging.
            const errors = [];
            const disposed = new Set();
            for (const record of records) {
                if (record.remote || disposed.has(record.provider)) continue;
                disposed.add(record.provider);
                try {
                    if (typeof record.provider.dispose === 'function') await record.provider.dispose();
                } catch (error) {
                    errors.push(error);
                }
            }
            try {
                checkOwnership();
            } catch (error) {
                errors.push(error);
            }
            for (const replacement of replacements) {
                if (loaded.get(replacement.id) !== replacement.service ||
                    (replacement.service && (services[replacement.service] !== replacement.provider ||
                        urls[replacement.workerId] !== replacement.url))) {
                    errors.push(failure('HOST_RECOVERY_REQUIRED',
                        'Replacement ownership changed during legacy disposal'));
                }
            }
            if (!errors.length) {
                for (const record of records) delete services[record.service];
                for (const worker of new Set(records.filter(record => record.remote).map(record => record.provider))) {
                    dispatch.workers = dispatch.workers.filter(item => item !== worker);
                    try {
                        worker.terminate();
                    } catch (error) {
                        errors.push(error);
                    }
                }
                for (const workerId of workerIds) delete urls[workerId];
            }
            state = 'committed';
            active.delete(manager);
            if (errors.length) {
                throw Object.assign(new AggregateError(errors, 'Legacy cleanup failed after replacement'),
                    {code: 'HOST_RECOVERY_REQUIRED', committed: true});
            }
        }
    });
};

module.exports = prepareLegacyReplacement;
