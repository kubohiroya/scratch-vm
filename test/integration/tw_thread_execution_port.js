const {test} = require('node:test');
const assert = require('node:assert');
const VM = require('../../src/virtual-machine');
const Thread = require('../../src/engine/thread');
const {BlockType, ArgumentType} = require('../../src/extension-support/tw-extension-api-common');

// Each test project keeps its scripts on the stage. Scripts named by their top block ID:
// - main: when flag clicked, then whatever the test puts in `mainBody`, then set [after] to "yes"
// - countTo10: repeat 10 { change [counter] by 1 }
// - countForever: forever { change [counter] by 1 }
// - waitForever: a block that returns a promise that never resolves
// - nested: run countTo10 now, then change [counter] by 100

const number = value => [1, [4, String(value)]];
const text = value => [1, [10, String(value)]];
const counterField = {VARIABLE: ['counter', 'counter']};

const runBlock = (id, script, limit, next, parent) => ({
    [id]: {
        opcode: 'testport_run',
        next: next || null,
        parent: parent || null,
        inputs: {SCRIPT: text(script), LIMIT: number(limit)},
        fields: {},
        shadow: false,
        topLevel: false
    }
});

const projectWith = mainBody => {
    const blocks = {
        main: {opcode: 'event_whenflagclicked',
            next: 'mainFirst',
            parent: null,
            inputs: {},
            fields: {},
            shadow: false,
            topLevel: true,
            x: 0,
            y: 0},
        after: {opcode: 'data_setvariableto',
            next: null,
            parent: null,
            inputs: {VALUE: text('yes')},
            fields: {VARIABLE: ['after', 'after']},
            shadow: false,
            topLevel: false},

        countTo10: {opcode: 'control_repeat',
            next: null,
            parent: null,
            inputs: {TIMES: number(10), SUBSTACK: [2, 'countTo10Body']},
            fields: {},
            shadow: false,
            topLevel: true,
            x: 0,
            y: 200},
        countTo10Body: {opcode: 'data_changevariableby',
            next: null,
            parent: 'countTo10',
            inputs: {VALUE: number(1)},
            fields: counterField,
            shadow: false,
            topLevel: false},

        countForever: {opcode: 'control_forever',
            next: null,
            parent: null,
            inputs: {SUBSTACK: [2, 'countForeverBody']},
            fields: {},
            shadow: false,
            topLevel: true,
            x: 0,
            y: 400},
        countForeverBody: {opcode: 'data_changevariableby',
            next: null,
            parent: 'countForever',
            inputs: {VALUE: number(1)},
            fields: counterField,
            shadow: false,
            topLevel: false},

        waitForever: {opcode: 'testport_waitForever',
            next: null,
            parent: null,
            inputs: {},
            fields: {},
            shadow: false,
            topLevel: true,
            x: 0,
            y: 600},

        nested: {opcode: 'testport_run',
            next: 'nestedAfter',
            parent: null,
            inputs: {SCRIPT: text('countTo10'), LIMIT: number(500)},
            fields: {},
            shadow: false,
            topLevel: true,
            x: 0,
            y: 800},
        nestedAfter: {opcode: 'data_changevariableby',
            next: null,
            parent: 'nested',
            inputs: {VALUE: number(100)},
            fields: counterField,
            shadow: false,
            topLevel: false},

        ...mainBody
    };
    // Chain main -> mainBody blocks -> after.
    const bodyIds = Object.keys(mainBody);
    blocks.main.next = bodyIds[0];
    bodyIds.forEach((id, index) => {
        blocks[id].parent = index === 0 ? 'main' : bodyIds[index - 1];
        blocks[id].next = bodyIds[index + 1] || 'after';
    });
    blocks.after.parent = bodyIds[bodyIds.length - 1];

    return {
        targets: [{
            isStage: true,
            name: 'Stage',
            variables: {counter: ['counter', 0], after: ['after', '']},
            lists: {},
            broadcasts: {},
            blocks,
            comments: {},
            currentCostume: 0,
            costumes: [],
            sounds: [],
            volume: 100,
            layerOrder: 0,
            tempo: 60,
            videoTransparency: 50,
            videoState: 'on',
            textToSpeechLanguage: null
        }],
        monitors: [],
        extensions: ['testport'],
        meta: {semver: '3.0.0', vm: '0.2.0', agent: ''}
    };
};

const setup = async (mainBody, compilerEnabled) => {
    const log = [];
    class TestPortExtension {
        constructor (runtime) {
            this.runtime = runtime;
        }
        getInfo () {
            return {
                id: 'testport',
                name: 'Test Port',
                blocks: [
                    {
                        opcode: 'run',
                        blockType: BlockType.COMMAND,
                        text: 'run [SCRIPT] now for [LIMIT] ms',
                        arguments: {
                            SCRIPT: {type: ArgumentType.STRING},
                            LIMIT: {type: ArgumentType.NUMBER}
                        }
                    },
                    {opcode: 'runSelf', blockType: BlockType.COMMAND, text: 'run this thread now'},
                    {opcode: 'waitForever', blockType: BlockType.COMMAND, text: 'wait forever'}
                ]
            };
        }
        run (args, util) {
            const port = this.runtime.getThreadExecutionPort();
            const stage = this.runtime.getTargetForStage();
            const thread = port.startScript(String(args.SCRIPT), stage);
            const status = port.runNow(thread, {timeLimitMs: Number(args.LIMIT)});
            log.push({
                script: String(args.SCRIPT),
                status,
                thread,
                caller: util.thread,
                counter: stage.lookupVariableById('counter').value
            });
        }
        runSelf (args, util) {
            try {
                this.runtime.getThreadExecutionPort().runNow(util.thread);
                log.push({error: null});
            } catch (e) {
                log.push({error: e.message});
            }
        }
        waitForever () {
            return new Promise(() => {});
        }
    }

    const vm = new VM();
    vm.setCompilerOptions({enabled: compilerEnabled});
    vm.extensionManager.addBuiltinExtension('testport', TestPortExtension);
    await vm.loadProject(projectWith(mainBody));
    const stage = vm.runtime.getTargetForStage();
    const value = id => stage.lookupVariableById(id).value;
    return {vm, log, stage, value};
};

for (const compilerEnabled of [true, false]) {
    const mode = compilerEnabled ? 'compiled' : 'interpreted';

    test(`${mode}: runs a script to completion inside the calling block`, async () => {
        const {vm, log, value} = await setup(runBlock('call', 'countTo10', 500), compilerEnabled);
        vm.greenFlag();
        vm.runtime._step();

        assert.strictEqual(log.length, 1);
        assert.strictEqual(log[0].status, 'done');
        assert.strictEqual(log[0].counter, 10, 'loop finished before the call returned');
        assert.strictEqual(log[0].caller.topBlock, 'main', 'calling block still sees its own thread');
        assert.strictEqual(log[0].caller.isCompiled, compilerEnabled);
        assert.strictEqual(value('after'), 'yes', 'caller continued in the same step');
        // The caller can only retire itself if the compiler state was restored.
        assert.strictEqual(log[0].caller.status, Thread.STATUS_DONE);
        assert.deepStrictEqual(vm.runtime.threads, []);
    });

    test(`${mode}: nested calls restore every caller`, async () => {
        const {vm, log, value} = await setup(runBlock('call', 'nested', 500), compilerEnabled);
        vm.greenFlag();
        vm.runtime._step();

        assert.deepStrictEqual(log.map(entry => [entry.script, entry.status, entry.counter]), [
            ['countTo10', 'done', 10],
            ['nested', 'done', 110]
        ]);
        assert.strictEqual(log[0].caller, log[1].thread, 'inner call ran inside the nested thread');
        assert.strictEqual(log[1].caller.topBlock, 'main');
        assert.strictEqual(value('after'), 'yes');
        assert.deepStrictEqual(vm.runtime.threads, []);
    });

    test(`${mode}: hands a script that waits back to the sequencer`, async () => {
        const {vm, log, value} = await setup(runBlock('call', 'waitForever', 500), compilerEnabled);
        vm.greenFlag();
        vm.runtime._step();

        assert.strictEqual(log[0].status, 'waiting');
        // The waiting block ran through the shared compatibility-layer utility.
        assert.strictEqual(log[0].caller.topBlock, 'main');
        assert.strictEqual(value('after'), 'yes');
        assert.deepStrictEqual(vm.runtime.threads, [log[0].thread]);
        vm.stopAll();
    });

    test(`${mode}: stops at the time limit and lets the sequencer continue`, async () => {
        const {vm, log, value} = await setup({
            ...runBlock('first', 'countForever', 0),
            ...runBlock('second', 'countForever', 0)
        }, compilerEnabled);
        vm.greenFlag();
        vm.runtime._step();

        assert.deepStrictEqual(log.map(entry => entry.status), ['yielded', 'yielded']);
        assert.notStrictEqual(log[0].thread, log[1].thread, 'same script runs twice at once');
        assert.ok(vm.runtime.threads.includes(log[0].thread));
        assert.ok(vm.runtime.threads.includes(log[1].thread));
        assert.strictEqual(value('after'), 'yes');
        vm.stopAll();
    });

    test(`${mode}: refuses to run the thread that is executing`, async () => {
        const {vm, log, value} = await setup({
            self: {opcode: 'testport_runSelf', inputs: {}, fields: {}, shadow: false, topLevel: false}
        }, compilerEnabled);
        vm.greenFlag();
        vm.runtime._step();

        assert.deepStrictEqual(log, [{error: 'Thread is already executing'}]);
        assert.strictEqual(value('after'), 'yes');
    });
}

test('port is stable and frozen', async () => {
    const {vm} = await setup(runBlock('call', 'countTo10', 500), true);
    const port = vm.runtime.getThreadExecutionPort();
    assert.strictEqual(vm.runtime.getThreadExecutionPort(), port);
    assert.ok(Object.isFrozen(port));
    assert.strictEqual(port.version, 1);
});

test('startScript and runNow reject what is not theirs to run', async () => {
    const {vm, stage} = await setup(runBlock('call', 'countTo10', 500), true);
    const other = await setup(runBlock('call', 'countTo10', 500), true);
    const port = vm.runtime.getThreadExecutionPort();

    assert.throws(() => port.startScript('missing', stage), /not the top of a script/);
    assert.throws(() => port.startScript('countTo10Body', stage), /not the top of a script/);
    assert.throws(() => port.startScript('countTo10', other.stage), /not part of this runtime/);

    const foreign = other.vm.runtime.getThreadExecutionPort().startScript('countTo10', other.stage);
    assert.throws(() => port.runNow(foreign), /not running in this runtime/);
    assert.throws(() => port.runNow({}), /not running in this runtime/);
});

test('runNow outside a step finishes the script', async () => {
    const {vm, stage, value} = await setup(runBlock('call', 'countTo10', 500), true);
    const port = vm.runtime.getThreadExecutionPort();
    const thread = port.startScript('countTo10', stage);
    assert.strictEqual(port.runNow(thread), 'done');
    assert.strictEqual(value('counter'), 10);
    assert.strictEqual(vm.runtime.sequencer.activeThread, null);
});
