const Sequencer = require('./sequencer');
const Thread = require('./thread');
const Timer = require('../util/timer');
const execute = require('./execute');
const compilerExecute = require('../compiler/jsexecute');
const compatBlockUtility = require('../compiler/compat-block-utility');

/**
 * Lets a block start a script and run it to completion within the current
 * step, the way a "run without screen refresh" procedure call does. The
 * compiler keeps the executing thread in module state, and both the
 * interpreter and the compiler's compatibility layer pass one shared
 * BlockUtility to every block. Running a second thread from inside a block
 * overwrites all three, so this port saves them and puts them back for the
 * calling block.
 *
 * runNow() reports one of:
 * - 'done': the script finished.
 * - 'waiting': the script waits for a promise or is paused. The sequencer resumes it.
 * - 'yielded': the time limit ran out or the script yielded until the next tick.
 *   The sequencer continues it.
 */

const isFinished = thread => thread.stack.length === 0 || thread.status === Thread.STATUS_DONE;

const classify = thread => {
    if (isFinished(thread)) return 'done';
    if (thread.status === Thread.STATUS_PROMISE_WAIT) return 'waiting';
    if (thread.status === Thread.STATUS_YIELD_TICK) return 'yielded';
    return null;
};

const saveUtility = utility => ({
    utility,
    thread: utility.thread,
    sequencer: utility.sequencer,
    startedBranch: utility._startedBranch
});

const restoreUtility = saved => {
    saved.utility.thread = saved.thread;
    saved.utility.sequencer = saved.sequencer;
    if ('_startedBranch' in saved.utility) saved.utility._startedBranch = saved.startedBranch;
};

/**
 * @param {Runtime} runtime The runtime that owns the port.
 * @returns {object} Frozen port object.
 */
const createThreadExecutionPort = runtime => {
    // Threads whose code is on the JavaScript stack right now.
    const busy = new Set();

    /**
     * Start a new thread at the top of a script, even if another thread runs the same script.
     * @param {string} topBlockId ID of the script's top block.
     * @param {Target} target Target that owns the script.
     * @returns {Thread} The new thread. The sequencer steps it unless runNow() finishes it first.
     */
    const startScript = (topBlockId, target) => {
        if (!target || !runtime.targets.includes(target)) {
            throw new Error('Target is not part of this runtime');
        }
        const block = target.blocks.getBlock(topBlockId);
        if (!block || block.parent) {
            throw new Error('Block is not the top of a script');
        }
        return runtime._pushThread(topBlockId, target);
    };

    /**
     * Step a thread until it finishes, waits, or uses up the time limit.
     * @param {Thread} thread A thread of this runtime that is not executing.
     * @param {{timeLimitMs?: number}} [options] Limit, capped at Sequencer.WARP_TIME.
     * @returns {'done'|'waiting'|'yielded'} Where the thread stopped.
     */
    const runNow = (thread, options) => {
        if (!(thread instanceof Thread) || !runtime.threads.includes(thread)) {
            throw new Error('Thread is not running in this runtime');
        }
        const sequencer = runtime.sequencer;
        const caller = sequencer.activeThread;
        if (busy.has(thread) || thread === caller) {
            throw new Error('Thread is already executing');
        }
        const settled = classify(thread);
        if (settled) return settled;

        const requestedLimit = options ? Number(options.timeLimitMs) : NaN;
        const timeLimit = requestedLimit >= 0 ?
            Math.min(requestedLimit, Sequencer.WARP_TIME) :
            Sequencer.WARP_TIME;

        const addedCaller = Boolean(caller) && !busy.has(caller);
        if (addedCaller) busy.add(caller);
        busy.add(thread);
        compilerExecute.saveGlobalState();
        const utilities = [saveUtility(execute.blockUtility), saveUtility(compatBlockUtility)];
        const timer = new Timer();
        timer.start();
        try {
            sequencer.activeThread = thread;
            for (;;) {
                sequencer.stepThread(thread);
                thread.warpTimer = null;
                const status = classify(thread);
                if (status) return status;
                if (thread.status === Thread.STATUS_YIELD) {
                    thread.status = Thread.STATUS_RUNNING;
                }
                if (timer.timeElapsed() >= timeLimit) return 'yielded';
            }
        } finally {
            sequencer.activeThread = caller;
            compilerExecute.restoreGlobalState();
            utilities.forEach(restoreUtility);
            busy.delete(thread);
            if (addedCaller) busy.delete(caller);
        }
    };

    return Object.freeze({
        version: 1,
        startScript,
        runNow
    });
};

module.exports = createThreadExecutionPort;
