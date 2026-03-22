export const perf = {
  wsMessages: 0,
  wsBytes: 0,
  flushCount: 0,
  lastFlushMs: 0,
  lastLayoutMs: 0,

  _prevTime: performance.now(),
  _prevMsgs: 0,
  _prevBytes: 0,
  _prevFlushes: 0,

  wsMsgRate: 0,
  wsKBps: 0,
  flushRate: 0,

  sample() {
    const now = performance.now();
    const dt = (now - this._prevTime) / 1000;
    if (dt < 0.5) return;
    this.wsMsgRate = (this.wsMessages - this._prevMsgs) / dt;
    this.wsKBps = (this.wsBytes - this._prevBytes) / dt / 1024;
    this.flushRate = (this.flushCount - this._prevFlushes) / dt;
    this._prevTime = now;
    this._prevMsgs = this.wsMessages;
    this._prevBytes = this.wsBytes;
    this._prevFlushes = this.flushCount;
  },
};
