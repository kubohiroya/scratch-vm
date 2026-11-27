const {test} = require('node:test');
const assert = require('node:assert');
const path = require('path');
const readFileToBuffer = require('../fixtures/readProjectFile').readFileToBuffer;
const makeTestStorage = require('../fixtures/make-test-storage');
const VirtualMachine = require('../../src/virtual-machine');

// Test that loading a project does not emit a project change
// This is in its own file so that it does not affect the test setup
// and results of the other project changed state tests
test('Loading a project should not emit a project changed event', async () => {
    const projectUri = path.resolve(__dirname, '../fixtures/default.sb2');
    const project = readFileToBuffer(projectUri);

    const vm = new VirtualMachine();

    let projectChanged = false;
    vm.runtime.addListener('PROJECT_CHANGED', () => {
        projectChanged = true;
    });

    vm.attachStorage(makeTestStorage());
    await vm.loadProject(project);
    assert.strictEqual(projectChanged, false);
});

test('Loading SB3 blocks preserves PROJECT_LOADED and importing a sprite marks the project changed', async () => {
    const projectUri = path.resolve(__dirname, '../fixtures/comments.sb3');
    const project = readFileToBuffer(projectUri);
    const vm = new VirtualMachine();
    const events = [];

    vm.runtime.on('PROJECT_CHANGED', () => events.push('PROJECT_CHANGED'));
    vm.runtime.on('PROJECT_LOADED', () => events.push('PROJECT_LOADED'));
    vm.attachStorage(makeTestStorage());

    await vm.loadProject(project);
    assert.deepStrictEqual(events, ['PROJECT_LOADED']);
    const target = vm.runtime.targets.find(candidate => !candidate.isStage);
    assert.ok(target.blocks.getScripts().length > 0);

    const sprite = await vm.exportSprite(target.id, 'nodebuffer');
    const eventCount = events.length;
    await vm.addSprite(sprite);
    assert.ok(events.slice(eventCount).includes('PROJECT_CHANGED'));
    assert.deepStrictEqual(vm.editingTarget.blocks.getScripts(), target.blocks.getScripts());
});
