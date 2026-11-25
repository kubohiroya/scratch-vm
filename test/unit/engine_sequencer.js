const {test} = require('node:test');
const assert = require('node:assert');
const Sequencer = require('../../src/engine/sequencer');
const Runtime = require('../../src/engine/runtime');
const Thread = require('../../src/engine/thread');
const RenderedTarget = require('../../src/sprites/rendered-target');
const Sprite = require('../../src/sprites/sprite');

test('spec', () => {
    assert.strictEqual(typeof Sequencer, 'function');
    
    const r = new Runtime();
    const s = new Sequencer(r);

    assert.strictEqual(typeof s, 'object');
    assert.ok(s instanceof Sequencer);
    
    assert.strictEqual(typeof s.stepThreads, 'function');
    assert.strictEqual(typeof s.stepThread, 'function');
    assert.strictEqual(typeof s.stepToBranch, 'function');
    assert.strictEqual(typeof s.stepToProcedure, 'function');
    assert.strictEqual(typeof s.retireThread, 'function');
});

test('an execution observer pauses before the command and resumes the original thread', () => {
    const r = new Runtime();
    r.currentStepTime = 1000;
    const target = new RenderedTarget(new Sprite(null, r), r);
    const commands = [];
    const completed = [];
    r._primitives.test_command = (_args, util) => commands.push(util.thread.peekStack());
    for (const [id, next] of [['before', 'conflict'], ['conflict', null], ['parallel', null]]) {
        target.blocks.createBlock({
            id,
            next,
            opcode: 'test_command',
            inputs: {},
            fields: {},
            topLevel: id !== 'conflict',
            parent: id === 'conflict' ? 'before' : null
        }, true);
    }
    let stopAtConflict = true;
    const observer = {
        paused: false,
        before (_thread, id) {
            if (id !== 'conflict' || !stopAtConflict) return true;
            this.paused = true;
            return false;
        },
        after (_thread, id) {
            completed.push(id);
        }
    };
    r.setBlockExecutionObserver(observer);
    const first = r._pushThread('before', target);
    r._pushThread('parallel', target);
    r.sequencer.stepThreads();
    assert.deepStrictEqual(commands, ['before']);
    assert.deepStrictEqual(completed, ['before']);
    assert.strictEqual(first.peekStack(), 'conflict');
    r._step();
    assert.deepStrictEqual(commands, ['before']);
    stopAtConflict = false;
    observer.paused = false;
    r.sequencer.stepThreads();
    assert.deepStrictEqual(commands, ['before', 'conflict', 'parallel']);
    assert.deepStrictEqual(completed, commands);
});

const randomString = function () {
    const top = Math.random().toString(36);
    return top.substring(7);
};

const generateBlock = function (id) {
    const block = {fields: Object,
        id: id,
        inputs: {},
        STEPS: Object,
        block: 'fakeBlock',
        name: 'fakeName',
        next: null,
        opcode: 'procedures_definition',
        mutation: {proccode: 'fakeCode'},
        parent: null,
        shadow: false,
        topLevel: true,
        x: 0,
        y: 0
    };
    return block;
};

const generateBlockInput = function (id, next, inp) {
    const block = {fields: Object,
        id: id,
        inputs: {SUBSTACK: {block: inp, name: 'SUBSTACK'}},
        STEPS: Object,
        block: 'fakeBlock',
        name: 'fakeName',
        next: next,
        opcode: 'procedures_definition',
        mutation: {proccode: 'fakeCode'},
        parent: null,
        shadow: false,
        topLevel: true,
        x: 0,
        y: 0
    };
    return block;
};

const generateThread = function (runtime) {
    const s = new Sprite(null, runtime);
    const rt = new RenderedTarget(s, runtime);
    const th = new Thread(randomString());
    
    let next = randomString();
    let inp = randomString();
    let name = th.topBlock;

    const pushStack = id => {
        th.pushStack(id);
        th.peekStackFrame().op = {id};
    };
    
    rt.blocks.createBlock(generateBlockInput(name, next, inp));
    pushStack(name);
    rt.blocks.createBlock(generateBlock(inp));
    
    for (let i = 0; i < 10; i++) {
        name = next;
        next = randomString();
        inp = randomString();
        
        rt.blocks.createBlock(generateBlockInput(name, next, inp));
        pushStack(name);
        rt.blocks.createBlock(generateBlock(inp));
    }
    rt.blocks.createBlock(generateBlock(next));
    pushStack(next);
    th.target = rt;
    th.blockContainer = rt.blocks;

    runtime.threads.push(th);

    return th;
};

test('stepThread', () => {
    const r = new Runtime();
    const s = new Sequencer(r);
    let th = generateThread(r);
    assert.notStrictEqual(th.status, Thread.STATUS_DONE);
    s.stepThread(th);
    assert.strictEqual(th.status, Thread.STATUS_DONE);
    th = generateThread(r);
    th.status = Thread.STATUS_YIELD;
    s.stepThread(th);
    assert.notStrictEqual(th.status, Thread.STATUS_DONE);
    th.status = Thread.STATUS_PROMISE_WAIT;
    s.stepThread(th);
    assert.notStrictEqual(th.status, Thread.STATUS_DONE);
    
});

test('stepToBranch', () => {
    const r = new Runtime();
    const s = new Sequencer(r);
    const th = generateThread(r);
    s.stepToBranch(th, 2, false);
    assert.strictEqual(th.peekStack(), null);
    th.popStack();
    s.stepToBranch(th, 1, false);
    assert.strictEqual(th.peekStack(), null);
    th.popStack();
    th.popStack();
    s.stepToBranch(th, 1, false);
    assert.notStrictEqual(th.peekStack(), null);
    
});

test('retireThread', () => {
    const r = new Runtime();
    const s = new Sequencer(r);
    const th = generateThread(r);
    assert.strictEqual(th.stack.length, 12);
    s.retireThread(th);
    assert.strictEqual(th.stack.length, 0);
    assert.strictEqual(th.status, Thread.STATUS_DONE);
    
});

test('stepToProcedure', () => {
    const r = new Runtime();
    const s = new Sequencer(r);
    const th = generateThread(r);
    let expectedBlock = th.peekStack();
    s.stepToProcedure(th, '');
    assert.strictEqual(th.peekStack(), expectedBlock);
    s.stepToProcedure(th, 'faceCode');
    assert.strictEqual(th.peekStack(), expectedBlock);

    th.target.blocks.createBlock({
        id: 'internalId',
        opcode: 'procedures_prototype',
        mutation: {
            proccode: 'othercode'
        }
    });
    expectedBlock = th.stack[th.stack.length - 4];
    th.target.blocks.getBlock(expectedBlock).inputs.custom_block = {
        type: 'custom_block',
        block: 'internalId'
    };
    s.stepToProcedure(th, 'othercode');
    assert.strictEqual(th.peekStack(), expectedBlock);
    
    
});

test('stepThreads', () => {
    const r = new Runtime();
    r.currentStepTime = Infinity;
    const s = new Sequencer(r);
    assert.strictEqual(s.stepThreads().length, 0);
    generateThread(r);
    assert.strictEqual(r.threads.length, 1);
    // Threads should be marked DONE and removed in the same step they finish.
    assert.strictEqual(s.stepThreads().length, 1);
    
});
