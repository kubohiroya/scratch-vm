const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {test} = require('node:test');
const JSZip = require('@turbowarp/jszip');
const VirtualMachine = require('../../src/virtual-machine');

const data = Buffer.concat(Array.from({length: 10000}, (_, index) => createHash('sha256')
    .update(String(index))
    .digest()));
const project = JSON.stringify({targets: [], data: data.toString('base64')});
const asset = Uint8Array.of(1, 2, 3);
const NativeCompressionStream = global.CompressionStream;
const date = new Date(1591657163000);

const saveFixture = (json = project, {bytes = false} = {}) => {
    const vm = new VirtualMachine();
    vm._saveProjectZip = () => new JSZip()
        .file('project.json', bytes ? new TextEncoder().encode(json) : json, {date, compression: 'DEFLATE'})
        .file('asset.png', asset, {date, compression: 'STORE'});
    return vm;
};

const checkArchive = async (archive, json) => {
    const zip = await JSZip.loadAsync(archive, {checkCRC32: true});
    assert.equal(await zip.file('project.json').async('string'), json);
    assert.equal(zip.file('project.json')._data.compression.magic, '\x08\x00');
    assert.equal(zip.file('asset.png')._data.compression.magic, '\x00\x00');
    assert.deepEqual(await zip.file('asset.png').async('uint8array'), asset);
};

test('native SB3 compression keeps exact bytes, CRC and ZIP methods in both save APIs', async t => {
    let calls = 0;
    t.mock.method(global, 'CompressionStream', class extends NativeCompressionStream {
        constructor (format) {
            super(format);
            calls++;
        }
    });
    await checkArchive(await saveFixture().saveProjectSb3('arraybuffer'), project);
    const stream = saveFixture(project, {bytes: true}).saveProjectSb3Stream('uint8array');
    const chunks = [];
    const archive = await new Promise((resolve, reject) => {
        stream.on('data', chunk => {
            chunks.push(Buffer.from(chunk));
            if (chunks.length === 1) {
                stream.pause();
                setImmediate(() => stream.resume());
            }
        })
            .on('end', () => resolve(Buffer.concat(chunks)))
            .on('error', reject);
        assert.equal(calls, 1);
        stream.resume();
    });
    await checkArchive(archive, project);
    assert.equal(calls, 2);
});

test('native compression uses the legacy UTF-8 bytes even when a surrogate pair spans ZIP chunks', async () => {
    const prefix = '{"value":"';
    const padding = 'x'.repeat((64 * 1024) - prefix.length - 1);
    const boundary = `${prefix}${padding}🐱${data.toString('base64')}"}}`;
    const vm = saveFixture(boundary);
    const reference = await vm._saveProjectZip().file('project.json')
        .async('uint8array');
    const archive = await JSZip.loadAsync(await vm.saveProjectSb3('arraybuffer'), {checkCRC32: true});
    assert.deepEqual(await archive.file('project.json').async('uint8array'), reference);
});

test('unsupported and failed native compression use the same ZIP writer as small projects', async t => {
    const legacyZip = await saveFixture()._saveProjectZip()
        .generateAsync({type: 'arraybuffer'});
    let failed = 0;
    const mock = t.mock.method(global, 'CompressionStream', class {
        constructor () {
            failed++;
            return new TransformStream({
                transform () {
                    throw new Error('Native backend failed');
                }
            });
        }
    });
    const retried = await saveFixture().saveProjectSb3('arraybuffer');
    await checkArchive(retried, project);
    assert.deepEqual(retried, legacyZip);
    assert.equal(failed, 1);
    mock.mock.restore();

    const ratio = t.mock.method(global, 'CompressionStream', class {
        constructor () {
            return new TransformStream({
                flush (controller) {
                    controller.enqueue(Uint8Array.of(0));
                }
            });
        }
    });
    assert.deepEqual(await saveFixture().saveProjectSb3('arraybuffer'), legacyZip);
    ratio.mock.restore();

    const descriptor = Object.getOwnPropertyDescriptor(global, 'CompressionStream');
    delete global.CompressionStream;
    try {
        const saved = await saveFixture().saveProjectSb3('arraybuffer');
        await checkArchive(saved, project);
        assert.deepEqual(saved, legacyZip);
    } finally {
        Object.defineProperty(global, 'CompressionStream', descriptor);
    }

    let smallCalls = 0;
    t.mock.method(global, 'CompressionStream', class extends NativeCompressionStream {
        constructor (format) {
            super(format);
            smallCalls++;
        }
    });
    const small = '{"targets":[]}';
    await checkArchive(await saveFixture(small).saveProjectSb3('arraybuffer'), small);
    assert.equal(smallCalls, 0);
    await checkArchive(legacyZip, project);
});
