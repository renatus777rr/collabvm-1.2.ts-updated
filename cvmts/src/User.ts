import * as Utilities from './Utilities.js';
import * as cvm from '@cvmts/cvm-rs';
import { IPData } from './IPData.js';
import IConfig from './IConfig.js';
import RateLimiter from './RateLimiter.js';
import { NetworkClient } from './net/NetworkClient.js';
import { CollabVMCapabilities } from '@cvmts/collab-vm-1.2-binary-protocol';
import { pino, type Logger } from 'pino';
import { v4 as uuid4 } from 'uuid';
import { BanManager } from './BanManager.js';
import { 
  IProtocol, 
  IProtocolMessageHandler, 
  ListEntry, 
  ProtocolAddUser, 
  ProtocolChatHistory, 
  ProtocolFlag, 
  ProtocolRenameStatus, 
  ProtocolUpgradeCapability, 
  ScreenRect 
} from './protocol/Protocol.js';
import { TheProtocolManager } from './protocol/Manager.js';

export enum Rank {
  Unregistered = 0,
  Registered = 1,
  Admin = 2,
  Moderator = 3
}

interface UserState {
  readonly socket: NetworkClient;
  readonly uuid: string;
  readonly logger: Logger;
  _username?: string;
  connectedToNode: boolean;
  viewMode: number;
  rank: Rank;
  turnWhitelist: boolean;
  noFlag: boolean;
  countryCode: string | null;
  msgsSent: number;
  config: IConfig;
  ip: IPData;
  capabilities: CollabVMCapabilities;
  protocol: IProtocol;
}

export class User {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly rateLimits = new Map<string, RateLimiter>();

  constructor(
    socket: NetworkClient, 
    protocol: string, 
    ip: IPData, 
    config: IConfig, 
    username?: string, 
    node?: string
  ) {
    this.state = {
      socket,
      uuid: uuid4(),
      logger: pino().child({ name: "CVMTS.User", "uuid/user": uuid4(), ip: ip.address }),
      connectedToNode: false,
      viewMode: -1,
      rank: Rank.Unregistered,
      turnWhitelist: false,
      noFlag: false,
      countryCode: null,
      msgsSent: 0,
      config,
      ip,
      capabilities: new CollabVMCapabilities(),
      protocol: TheProtocolManager.getProtocol(protocol)
    };

    this.setupSocketHandlers();
    this.setupRateLimiters(config);
    this.startHeartbeat();
    this.setupIPRef(ip);
    
    if (username) this.username = username;
  }

  private state: UserState;

  private setupSocketHandlers() {
    this.state.socket.on('disconnect', () => {
      this.state.ip.Unref();
      this.clearAllTimers();
      this.state.logger.debug({ event: "user/disconnected" });
    });
  }

  private setupRateLimiters(config: IConfig) {
    const limits = [
      ['chat', config.collabvm.automute.messages, config.collabvm.automute.seconds, () => this.mute(false)],
      ['rename', 3, 60, () => this.close()],
      ['login', 4, 3, () => this.close()],
      ['turn', 5, 3, () => this.close()],
      ['vote', 3, 3, () => this.close()]
    ];

    limits.forEach(([name, max, window, onLimit]) => {
      const limiter = new RateLimiter(max, window);
      limiter.on('limit', onLimit);
      this.rateLimits.set(name, limiter);
    });
  }

  private setupIPRef(ip: IPData) {
    ip.Ref();
  }

  private startHeartbeat() {
    this.setTimer('nopSend', setInterval(() => this.sendNop(), 5000), 5000);
    this.setTimer('msgCheck', setInterval(() => this.checkMsgTimeout(), 10000), 10000);
    this.sendNop();
  }

  assignGuestName(existing: string[]): string {
    let name: string;
    do {
      name = `guest${Utilities.Randint(10000, 99999)}`;
    } while (existing.includes(name));
    
    this.username = name;
    return name;
  }

  get username(): string {
    return this.state._username!;
  }

  set username(name: string) {
    this.state.logger = this.state.logger.child({ username: name });
    this.state._username = name;
  }

  get ChatRateLimit(): RateLimiter { return this.rateLimits.get('chat')!; }
  get RenameRateLimit(): RateLimiter { return this.rateLimits.get('rename')!; }
  get LoginRateLimit(): RateLimiter { return this.rateLimits.get('login')!; }
  get TurnRateLimit(): RateLimiter { return this.rateLimits.get('turn')!; }
  get VoteRateLimit(): RateLimiter { return this.rateLimits.get('vote')!; }

  onNop() {
    this.clearTimer('nopTimeout');
    this.resetMsgCheck();
  }

  sendMsg(msg: string) {
    if (this.state.socket.isOpen()) {
      this.resetNopTimer();
      this.state.socket.send(msg);
    }
  }

  private resetNopTimer() {
    this.clearTimer('nopSend');
    this.setTimer('nopSend', setInterval(() => this.sendNop(), 5000), 5000);
  }

  private checkMsgTimeout() {
    this.sendNop();
    this.setTimer('nopTimeout', setTimeout(() => this.close(), 3000), 3000);
  }

  private resetMsgCheck() {
    this.clearTimer('msgCheck');
    this.setTimer('msgCheck', setInterval(() => this.checkMsgTimeout(), 10000), 10000);
  }

  processMessage(handler: IProtocolMessageHandler, buffer: Buffer) {
    this.state.protocol.processMessage(this, handler, buffer);
  }

  sendNop() {
    this.state.protocol.sendNop(this);
  }

  sendSync(now: number) {
    this.state.protocol.sendSync(this, now);
  }

  sendAuth(url: string) {
    this.state.protocol.sendAuth(this, url);
  }

  sendCapabilities(caps: ProtocolUpgradeCapability[]) {
    this.state.protocol.sendCapabilities(this, caps);
  }

  sendConnectFailResponse() {
    this.state.protocol.sendConnectFailResponse(this);
  }

  sendConnectOKResponse(votes: boolean) {
    this.state.protocol.sendConnectOKResponse(this, votes);
  }

  sendLoginResponse(ok: boolean, message?: string) {
    this.state.protocol.sendLoginResponse(this, ok, message);
  }

  sendAdminLoginResponse(ok: boolean, modPerms?: number) {
    this.state.protocol.sendAdminLoginResponse(this, ok, modPerms);
  }

  sendAdminMonitorResponse(output: string) {
    this.state.protocol.sendAdminMonitorResponse(this, output);
  }

  sendAdminIPResponse(username: string, ip: string) {
    this.state.protocol.sendAdminIPResponse(this, username, ip);
  }

  sendChatMessage(username: string | '', message: string) {
    this.state.protocol.sendChatMessage(this, username, message);
  }

  sendChatHistoryMessage(history: ProtocolChatHistory[]) {
    this.state.protocol.sendChatHistoryMessage(this, history);
  }

  sendAddUser(users: ProtocolAddUser[]) {
    this.state.protocol.sendAddUser(this, users);
  }

  sendRemUser(users: string[]) {
    this.state.protocol.sendRemUser(this, users);
  }

  sendFlag(flags: ProtocolFlag[]) {
    this.state.protocol.sendFlag(this, flags);
  }

  sendSelfRename(status: ProtocolRenameStatus, username: string, rank: Rank) {
    this.state.protocol.sendSelfRename(this, status, username, rank);
  }

  sendRename(old: string, newName: string, rank: Rank) {
    this.state.protocol.sendRename(this, old, newName, rank);
  }

  sendListResponse(list: ListEntry[]) {
    this.state.protocol.sendListResponse(this, list);
  }

  sendTurnQueue(time: number, users: string[]) {
    this.state.protocol.sendTurnQueue(this, time, users);
  }

  sendTurnQueueWaiting(time: number, users: string[], wait: number) {
    this.state.protocol.sendTurnQueueWaiting(this, time, users, wait);
  }

  sendVoteStarted() {
    this.state.protocol.sendVoteStarted(this);
  }

  sendVoteStats(ms: number, yes: number, no: number) {
    this.state.protocol.sendVoteStats(this, ms, yes, no);
  }

  sendVoteEnded() {
    this.state.protocol.sendVoteEnded(this);
  }

  sendVoteCooldown(ms: number) {
    this.state.protocol.sendVoteCooldown(this, ms);
  }

  sendScreenResize(width: number, height: number) {
    this.state.protocol.sendScreenResize(this, width, height);
  }

  sendScreenUpdate(rect: ScreenRect) {
    this.state.protocol.sendScreenUpdate(this, rect);
  }

  onChatMsgSent() {
    if (!this.state.config.collabvm.automute.enabled || this.state.rank >= Rank.Moderator) return;
    this.ChatRateLimit.request();
  }

  mute(permanent: boolean) {
    this.state.ip.muted = true;
    this.sendMsg(cvm.guacEncode('chat', '', 
      `You have been muted${permanent ? '' : ` for ${this.state.config.collabvm.tempMuteTime}s`}`
    ));
    
    if (!permanent) {
      this.setTimer('muteExpire', setTimeout(() => this.unmute(), this.state.config.collabvm.tempMuteTime * 1000), 0);
    }
  }

  unmute() {
    this.clearTimer('muteExpire');
    this.state.ip.muted = false;
    this.sendMsg(cvm.guacEncode('chat', '', 'You are no longer muted.'));
  }

  async ban(banmgr: BanManager) {
    this.state.ip.muted = true;
    await banmgr.BanUser(this.state.ip.address, this.username);
    await this.kick();
  }

  async kick() {
    this.sendMsg('10.disconnect;');
    this.state.socket.close();
  }

  close() {
    this.state.socket.send(cvm.guacEncode('disconnect'));
    this.state.socket.close();
  }

  private setTimer(name: string, timer: NodeJS.Timeout, duration: number) {
    this.clearTimer(name);
    this.timers.set(name, timer);
  }

  private clearTimer(name: string) {
    const timer = this.timers.get(name);
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
      this.timers.delete(name);
    }
  }

  private clearAllTimers() {
    this.timers.forEach(timer => {
      clearTimeout(timer);
      clearInterval(timer);
    });
    this.timers.clear();
  }
}
