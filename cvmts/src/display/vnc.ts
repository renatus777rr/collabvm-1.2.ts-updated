import { VncClient } from '@computernewb/nodejs-rfb';
import { EventEmitter } from 'node:events';
import { Clamp, Size, Rect } from '../Utilities.js';
import { BatchRects } from './batch.js';
import { VMDisplay } from './interface.js';

const kVncBaseFramerate = 60;
const kMaxReconnectAttempts = 5;
const kReconnectDelayMs = 2000;

interface VncState {
  vnc: VncClient;
  connectOpts: Record<string, unknown>;
  reconnectAttempts: number;
  shouldReconnect: boolean;
  rectBuffer: Rect[];
}

export class VncDisplay extends EventEmitter implements VMDisplay {
  private state: VncState;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(connectOpts: Record<string, unknown>) {
    super();
    this.state = {
      vnc: new VncClient({
        debug: false,
        fps: kVncBaseFramerate,
        encodings: [
          VncClient.consts.encodings.raw,
          VncClient.consts.encodings.pseudoDesktopSize
        ]
      }),
      connectOpts,
      reconnectAttempts: 0,
      shouldReconnect: false,
      rectBuffer: []
    };

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    const vnc = this.state.vnc;
    
    vnc.on('connectTimeout', () => this.scheduleReconnect());
    vnc.on('authError', () => this.scheduleReconnect());
    vnc.on('disconnect', () => this.scheduleReconnect());
    vnc.on('closed', () => this.scheduleReconnect());
    
    vnc.on('firstFrameUpdate', () => {
      vnc.changeFps(kVncBaseFramerate);
      this.emitConnected();
    });
    
    vnc.on('desktopSizeChanged', (size: Size) => this.emit('resize', size));
    
    vnc.on('rectUpdateProcessed', (rect: Rect) => {
      this.state.rectBuffer.push(rect);
    });
    
    vnc.on('frameUpdated', () => {
      const batchedRects = BatchRects(this.Size(), this.state.rectBuffer);
      this.emit('rect', batchedRects);
      this.state.rectBuffer = [];
      this.emit('frame');
    });
  }

  Connect() {
    this.state.shouldReconnect = true;
    this.connect();
  }

  Disconnect() {
    this.state.shouldReconnect = false;
    this.clearReconnect();
    this.state.vnc.removeAllListeners();
    this.removeAllListeners();
    this.state.vnc.disconnect();
  }

  Connected(): boolean {
    return this.state.vnc.connected;
  }

  Buffer(): Buffer {
    return this.state.vnc.fb;
  }

  Size(): Size {
    if (!this.Connected()) return { width: 0, height: 0 };
    return {
      width: this.state.vnc.clientWidth,
      height: this.state.vnc.clientHeight
    };
  }

  MouseEvent(x: number, y: number, buttons: number): void {
    if (this.Connected()) {
      this.state.vnc.sendPointerEvent(
        Clamp(x, 0, this.state.vnc.clientWidth),
        Clamp(y, 0, this.state.vnc.clientHeight),
        buttons
      );
    }
  }

  KeyboardEvent(keysym: number, pressed: boolean): void {
    if (this.Connected()) {
      this.state.vnc.sendKeyEvent(keysym, pressed);
    }
  }

  private connect() {
    if (!this.state.vnc.connected) {
      this.state.vnc.connect(this.state.connectOpts);
    }
  }

  private scheduleReconnect() {
    if (!this.state.shouldReconnect || this.state.reconnectAttempts >= kMaxReconnectAttempts) {
      return;
    }

    this.state.reconnectAttempts++;
    this.clearReconnect();
    
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, kReconnectDelayMs * this.state.reconnectAttempts);
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private emitConnected() {
    this.emit('connected');
    this.emit('resize', this.Size());
  }
}
