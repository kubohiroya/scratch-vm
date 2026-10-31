const {test} = require('node:test');
const assert = require('node:assert/strict');
const prepare = require('../../src/extension-support/tw-host-legacy-replacement');

const fixture = (kind = 'unsandboxed', ids = ['sample']) => {
    let disposed = 0;
    let terminated = 0;
    const workerId = 4;
    const worker = {isRemote: true,
        terminate () {
            terminated++;
        }};
    const dispatch = {services: {}, workers: kind === 'extension' ? [worker] : []};
    const runtime = {_primitives: {other_value: () => 'other'},
        _hats: {},
        _flowing: {},
        _blockInfo: [{id: 'other'}],
        stops: 0,
        resets: 0,
        stopAll () {
            this.stops++;
        },
        resetAllCaches () {
            this.resets++;
        }};
    const manager = {runtime, _loadedExtensions: new Map(), workerURLs: [], isBuiltinExtension: id => id === 'pen'};
    manager.workerURLs[workerId] = 'https://legacy.test/source.js';
    const records = [];
    const dispose = () => {
        disposed++;
    };
    for (const [index, id] of ids.entries()) {
        const provider = kind === 'extension' ? worker : {dispose};
        const service = `${kind}.${workerId}.${kind === 'extension' ? index : id}`;
        dispatch.services[service] = provider;
        manager._loadedExtensions.set(id, service);
        runtime._primitives[`${id}_value`] = () => id;
        runtime._hats[`${id}_hat`] = {edgeActivated: true};
        runtime._flowing[`${id}_flow`] = true;
        const category = {id, name: id};
        runtime._blockInfo.push(category);
        runtime[`ext_${id}`] = provider;
        records.push({id, service, provider, category, primitive: runtime._primitives[`${id}_value`]});
    }
    const installNew = (id, newKind = kind === 'extension' ? 'unsandboxed' : 'extension') => {
        const newWorkerId = 20 + ids.indexOf(id);
        const provider = newKind === 'extension' ? {isRemote: true,
            terminate () {
                throw new Error('must not terminate new worker');
            }} : {};
        const service = `${newKind}.${newWorkerId}.${newKind === 'extension' ? 0 : id}`;
        if (newKind === 'extension') dispatch.workers.push(provider);
        dispatch.services[service] = provider;
        manager.workerURLs[newWorkerId] = `data:application/javascript,${id}`;
        manager._loadedExtensions.set(id, service);
        const primitive = () => `new ${id}`;
        runtime._primitives[`${id}_value`] = primitive;
        runtime._hats[`${id}_newhat`] = {edgeActivated: false};
        runtime._flowing[`${id}_newflow`] = true;
        const category = {id, name: `new ${id}`};
        runtime._blockInfo.push(category);
        runtime[`ext_${id}`] = provider;
        return {provider, service, primitive, category, workerId: newWorkerId};
    };
    return {manager,
        runtime,
        dispatch,
        worker,
        workerId,
        records,
        installNew,
        disposed: () => disposed,
        terminated: () => terminated};
};

for (const kind of ['unsandboxed', 'extension']) {
    test(`legacy ${kind} detach and rollback preserve exact old bindings, services and worker URL`, () => {
        const f = fixture(kind);
        const [record] = f.records;
        const other = f.runtime._primitives.other_value;
        const stage = prepare(f.manager, f.dispatch, ['sample']);
        assert.equal(f.manager._loadedExtensions.has('sample'), false);
        assert.equal(f.runtime._primitives.sample_value, undefined);
        assert.equal(f.runtime._hats.sample_hat, undefined);
        assert.equal(f.runtime._flowing.sample_flow, undefined);
        assert.equal(f.runtime.ext_sample, undefined);
        assert.deepEqual(f.runtime._blockInfo.map(item => item.id), ['other']);
        assert.equal(f.dispatch.services[record.service], record.provider);
        assert.equal(f.manager.workerURLs[f.workerId], 'https://legacy.test/source.js');
        assert.equal(f.disposed(), 0);
        assert.equal(f.terminated(), 0);
        stage.rollback();
        stage.rollback();
        assert.equal(f.manager._loadedExtensions.get('sample'), record.service);
        assert.equal(f.runtime._primitives.sample_value, record.primitive);
        assert.equal(f.runtime.ext_sample, record.provider);
        assert.equal(f.runtime._blockInfo[1], record.category);
        assert.equal(f.runtime._primitives.other_value, other);
        assert.equal(f.dispatch.services[record.service], record.provider);
        assert.equal(f.disposed(), 0);
        assert.equal(f.terminated(), 0);
    });

    test(`legacy ${kind} commit preserves new execution mode and all new tables`, async () => {
        const f = fixture(kind);
        const stage = prepare(f.manager, f.dispatch, ['sample']);
        const replacement = f.installNew('sample');
        await stage.commit();
        await stage.commit();
        assert.equal(f.manager._loadedExtensions.get('sample'), replacement.service);
        assert.equal(f.dispatch.services[replacement.service], replacement.provider);
        assert.equal(f.runtime._primitives.sample_value, replacement.primitive);
        assert.equal(f.runtime._hats.sample_newhat.edgeActivated, false);
        assert.equal(f.runtime._flowing.sample_newflow, true);
        assert.equal(f.runtime.ext_sample, replacement.provider);
        assert.equal(f.runtime._blockInfo.find(item => item.id === 'sample'), replacement.category);
        assert.equal(f.manager.workerURLs[replacement.workerId], 'data:application/javascript,sample');
        assert.equal(f.dispatch.services[f.records[0].service], undefined);
        assert.equal(f.manager.workerURLs[f.workerId], undefined);
        assert.equal(f.disposed(), kind === 'unsandboxed' ? 1 : 0);
        assert.equal(f.terminated(), kind === 'extension' ? 1 : 0);
        assert.equal(f.runtime._primitives.other_value(), 'other');
        assert.throws(() => stage.rollback(), {code: 'HOST_RECOVERY_REQUIRED'});
    });

    test(`legacy ${kind} shared-source subsets fail before changing any registration`, async () => {
        const f = fixture(kind, ['sample', 'sibling']);
        assert.throws(() => prepare(f.manager, f.dispatch, ['sample']), {code: 'LEGACY_SHARED_SOURCE'});
        assert.equal(f.manager._loadedExtensions.size, 2);
        assert.equal(f.runtime._primitives.sample_value(), 'sample');
        assert.equal(f.runtime.stops, 0);
        const stage = prepare(f.manager, f.dispatch, ['sample', 'sibling']);
        const first = f.installNew('sample');
        const second = f.installNew('sibling');
        await stage.commit();
        assert.equal(f.manager._loadedExtensions.get('sample'), first.service);
        assert.equal(f.manager._loadedExtensions.get('sibling'), second.service);
        assert.equal(f.runtime._primitives.sample_value(), 'new sample');
        assert.equal(f.runtime._primitives.sibling_value(), 'new sibling');
        assert.equal(f.disposed(), kind === 'unsandboxed' ? 2 : 0);
        assert.equal(f.terminated(), kind === 'extension' ? 1 : 0);
    });
}

test('shared worker services outside the selected manager registrations cannot be terminated', () => {
    const f = fixture('extension');
    f.dispatch.services['unrelated-channel'] = f.worker;
    assert.throws(() => prepare(f.manager, f.dispatch, ['sample']), {code: 'LEGACY_SHARED_SOURCE'});
    assert.equal(f.manager._loadedExtensions.get('sample'), f.records[0].service);
    assert.equal(f.terminated(), 0);
});

test('builtins, general services and Plus-owned registrations are refused without mutation', () => {
    const builtin = fixture();
    builtin.manager._loadedExtensions.set('pen', builtin.records[0].service);
    assert.throws(() => prepare(builtin.manager, builtin.dispatch, ['pen']), {code: 'UNSUPPORTED_LEGACY_EXTENSION'});
    const general = fixture();
    general.manager._loadedExtensions.set('sample', 'runtime');
    general.dispatch.services.runtime = {};
    assert.throws(() => prepare(general.manager, general.dispatch, ['sample']), {code: 'UNSUPPORTED_LEGACY_EXTENSION'});
    const owned = fixture();
    assert.throws(() => prepare(owned.manager, owned.dispatch, ['sample'],
        new Map([[owned.records[0].service, owned.records[0].provider]])), {code: 'UNSUPPORTED_LEGACY_EXTENSION'});
    assert.equal(owned.runtime.stops, 0);
});

test('rollback refuses replacement bindings and foreign changes instead of overwriting them', () => {
    const f = fixture();
    const stage = prepare(f.manager, f.dispatch, ['sample']);
    const replacement = f.installNew('sample');
    assert.throws(() => stage.rollback(), {code: 'HOST_RECOVERY_REQUIRED'});
    assert.equal(f.manager._loadedExtensions.get('sample'), replacement.service);
    assert.equal(f.runtime._primitives.sample_value, replacement.primitive);
    const foreign = fixture();
    const otherStage = prepare(foreign.manager, foreign.dispatch, ['sample']);
    const provider = {};
    foreign.dispatch.services[foreign.records[0].service] = provider;
    assert.throws(() => otherStage.rollback(), {code: 'HOST_RECOVERY_REQUIRED'});
    assert.equal(foreign.dispatch.services[foreign.records[0].service], provider);
});

test('commit checks new registration and allows external project switches to retire legacy services', async () => {
    const f = fixture('extension');
    const stage = prepare(f.manager, f.dispatch, ['sample']);
    await assert.rejects(stage.commit(), {code: 'HOST_RECOVERY_REQUIRED'});
    assert.equal(f.terminated(), 0);
    await stage.commit({allowMissingReplacement: true});
    assert.equal(f.terminated(), 1);
    assert.equal(f.manager._loadedExtensions.size, 0);
    assert.equal(f.runtime._primitives.sample_value, undefined);
    assert.equal(f.runtime._primitives.other_value(), 'other');
});

test('dispose cannot silently remove a replacement registration and then report a successful commit', async () => {
    const f = fixture();
    f.records[0].provider.dispose = () => {
        f.manager._loadedExtensions.delete('sample');
    };
    const stage = prepare(f.manager, f.dispatch, ['sample']);
    const replacement = f.installNew('sample');
    await assert.rejects(stage.commit(), error => error.code === 'HOST_RECOVERY_REQUIRED' && error.committed === true);
    assert.equal(f.runtime._primitives.sample_value, replacement.primitive);
    assert.equal(f.dispatch.services[replacement.service], replacement.provider);
    assert.throws(() => stage.rollback(), {code: 'HOST_RECOVERY_REQUIRED'});
});

test('service and worker URL ownership changes are detected before disposal', async () => {
    for (const mutate of [
        f => {
            f.dispatch.services[f.records[0].service] = {};
        },
        f => {
            f.manager.workerURLs[f.workerId] = 'https://foreign.test/code.js';
        }
    ]) {
        const f = fixture();
        const stage = prepare(f.manager, f.dispatch, ['sample']);
        f.installNew('sample');
        mutate(f);
        await assert.rejects(stage.commit(), {code: 'HOST_RECOVERY_REQUIRED'});
        assert.equal(f.disposed(), 0);
    }
});

test('reentrant replacement, concurrent finalization and invalid IDs are rejected safely', async () => {
    const f = fixture();
    for (const ids of [['sample', 'sample'], ['../sample'], null]) {
        assert.throws(() => prepare(f.manager, f.dispatch, ids), {code: 'INVALID_LEGACY_REPLACEMENT'});
    }
    const stage = prepare(f.manager, f.dispatch, ['sample']);
    assert.throws(() => prepare(f.manager, f.dispatch, ['sample']), {code: 'PROJECT_BUSY'});
    let release;
    f.records[0].provider.dispose = () => new Promise(resolve => {
        release = resolve;
    });
    f.installNew('sample');
    const committing = stage.commit();
    assert.throws(() => stage.rollback(), {code: 'HOST_RECOVERY_REQUIRED'});
    await assert.rejects(stage.commit(), {code: 'HOST_RECOVERY_REQUIRED'});
    release();
    await committing;
});
