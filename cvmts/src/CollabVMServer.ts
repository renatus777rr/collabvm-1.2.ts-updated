import IConfig from './IConfig.js';
import * as Utilities from './Utilities.js';
import { User, Rank } from './User.js';
import CircularBuffer from 'mnemonist/circular-buffer.js';
import Queue from 'mnemonist/queue.js';
import { createHash } from 'crypto';
import { VMState } from '@computernewb/superqemu';
import { IPDataManager } from './IPData.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AuthManager from './AuthManager.js';
import { JPEGEncoder } from './JPEGEncoder.js';
import VM from './vm/interface.js';
import { ReaderModel } from '@maxmind/geoip2-node';
import { Size, Rect } from './Utilities.js';
import pino from 'pino';
import { BanManager } from './BanManager.js';
import { TheAuditLog } from './AuditLog.js';
import { 
  IProtocolMessageHandler, 
  ListEntry, 
  ProtocolAddUser, 
  ProtocolFlag, 
  ProtocolRenameStatus, 
  ProtocolUpgradeCapability 
} from './protocol/Protocol.js';
import { TheProtocolManager } from './protocol/Manager.js';

const __dirname = import.meta.dirname;
const kCVMTSAssetsRoot = path.resolve(__dirname, '../../assets');
const kRestartTimeout = 5000;

interface ChatHistoryEntry { user: string; msg: string; }
interface VoteTally { yes: number; no: number; }
interface VoteState { inProgress: boolean; timeLeft: number; cooldown: number; interval?: NodeJS.Timeout; }
interface TurnStateData { 
  queue: Queue<User>; 
  timeLeft: number; 
  interval?: NodeJS.Timeout; 
  currentUser: User | null; 
  indefiniteUser: User | null; 
}

export default class CollabVMServer implements IProtocolMessageHandler {
  private readonly config: IConfig;
  private readonly logger = pino({ name: 'CVMTS.Server', level: process.env.LOG_LEVEL || 'info' });
  private readonly clients = new Map<string, User>();
  private readonly clientByName = new Map<string, User>();
  private readonly connectedClients = new Set<User>();
  private readonly adminClients = new Set<User>();
  
  private chatHistory: CircularBuffer<ChatHistoryEntry>;
  private turnState: TurnStateData;
  private voteState: VoteState;
  private vm: VM;
  private displaySize: Size = { width: 0, height: 0 };
  private rectQueue: Rect[] = [];
  private readonly screenHiddenImg: Buffer;
  private readonly screenHiddenThumb: Buffer;
  private readonly modPerms: number;
  private screenHidden = false;
  private turnsAllowed = true;

  constructor(
    config: IConfig, 
    vm: VM, 
    private readonly banmgr: BanManager,
    auth: AuthManager | null = null, 
    geoipReader: ReaderModel | null = null
  ) {
    this.config = config;
    this.chatHistory = new CircularBuffer<ChatHistoryEntry>(Array, config.collabvm.maxChatHistoryLength);
    this.turnState = { queue: new Queue<User>(), timeLeft: 0, currentUser: null, indefiniteUser: null };
    this.voteState = { inProgress: false, timeLeft: 0, cooldown: 0 };
    
    this.screenHiddenImg = readFileSync(path.join(kCVMTSAssetsRoot, 'screenhidden.jpeg'));
    this.screenHiddenThumb = readFileSync(path.join(kCVMTSAssetsRoot, 'screenhiddenthumb.jpeg'));
    this.modPerms = Utilities.MakeModPerms(config.collabvm.moderatorPermissions);
    
    this.vm = vm;
    this.setupVMHandlers();
    this.auth = auth;
    this.geoipReader = geoipReader;
  }

  private setupVMHandlers() {
    this.vm.Events().on('statechange', (newState: VMState) => {
      if (newState === VMState.Started) {
        this.vm.StartDisplay();
        const display = this.vm.GetDisplay();
        display?.on('resize', (size: Size) => this.onDisplayResize(size));
        display?.on('rect', (rect: Rect) => this.rectQueue.push(rect));
        display?.on('frame', () => this.processFrame());
      } else if (newState === VMState.Stopped) {
        setTimeout(() => this.vm.Start(), kRestartTimeout);
      }
    });
  }

  /** Core Connection Flow */
  connectionOpened(user: User): void {
    if (this.getClientsByIP(user.IP.address).length >= this.config.collabvm.maxConnections) {
      this.getClientsByIP(user.IP.address)[0]?.kick();
    }

    this.clients.set(user.IP.address, user);
    this.connectedClients.add(user);
    this.resolveGeoIP(user);
    this.setupUserHandlers(user);
    this.sendInitialData(user);
  }

  private connectionClosed(user: User): void {
    this.clients.delete(user.IP.address);
    this.clientByName.delete(user.username ?? '');
    this.connectedClients.delete(user);
    this.adminClients.delete(user);
    this.cleanupUserState(user);
    this.broadcastUserRemoval(user.username ?? '');
  }

  private setupUserHandlers(user: User) {
    user.socket.on('msg', (buf: Buffer) => {
      try {
        user.processMessage(this, buf);
      } catch {
        user.kick();
      }
    });
    user.socket.on('disconnect', () => this.connectionClosed(user));
  }

  /** Optimized Operations */
  private getClientsByIP(ip: string): User[] {
    return Array.from(this.clients.values()).filter(c => c.IP.address === ip);
  }

  private broadcastChat(username: string, message: string): void {
    this.connectedClients.forEach(c => c.sendChatMessage(username, message));
    if (message.trim()) {
      this.chatHistory.push({ user: username, msg: Utilities.HTMLSanitize(message).slice(0, this.config.collabvm.maxChatLength) });
    }
  }

  private sendTurnUpdate(): void {
    const users = this.turnState.queue.toArray().map(u => u.username!);
    const turnTime = this.turnState.indefiniteUser ? 9999999999 : this.turnState.timeLeft * 1000;
    
    this.connectedClients.forEach(client => {
      if (client.connectedToNode) {
        const pos = this.turnState.queue.toArray().indexOf(client);
        if (pos > 0) {
          client.sendTurnQueueWaiting(turnTime, users, (pos - 1) * this.config.collabvm.turnTime * 1000);
        } else {
          client.sendTurnQueue(turnTime, users);
        }
      }
    });
  }

  /** Turn System */
  onTurnRequest(user: User, forfeit: boolean): void {
    if (!this.canTakeTurn(user)) return;
    
    if (forfeit) {
      this.endTurn(user);
    } else if (!this.turnState.queue.toArray().includes(user)) {
      if (this.checkTurnLimit(user)) {
        this.turnState.queue.enqueue(user);
        if (this.turnState.queue.size === 1) this.nextTurn();
      }
    }
    this.sendTurnUpdate();
  }

  private canTakeTurn(user: User): boolean {
    return (this.turnsAllowed || this.hasTurnPrivileges(user)) && 
           user.connectedToNode && 
           user.TurnRateLimit.request() && 
           this.authCheck(user, this.config.auth.guestPermissions.turn) &&
           !user.IP.muted;
  }

  private checkTurnLimit(user: User): boolean {
    if (!this.config.collabvm.turnlimit.enabled) return true;
    const ipCount = this.turnState.queue.toArray().filter(u => u.IP.address === user.IP.address).length;
    return ipCount < this.config.collabvm.turnlimit.maximum;
  }

  private hasTurnPrivileges(user: User): boolean {
    return user.rank >= Rank.Moderator || user.turnWhitelist;
  }

  private nextTurn(): void {
    this.clearTurnInterval();
    if (this.turnState.queue.size === 0) return;

    this.turnState.timeLeft = this.config.collabvm.turnTime;
    this.turnState.currentUser = this.turnState.queue.peek()!;
    this.turnState.interval = setInterval(() => {
      if (!this.turnState.indefiniteUser && --this.turnState.timeLeft < 1) {
        this.turnState.queue.dequeue();
        this.nextTurn();
      }
    }, 1000);
    this.sendTurnUpdate();
  }

  private endTurn(user: User): void {
    if (this.turnState.indefiniteUser === user) this.turnState.indefiniteUser = null;
    this.removeFromTurnQueue(user);
    this.sendTurnUpdate();
  }

  private removeFromTurnQueue(user: User): void {
    const wasCurrent = this.turnState.currentUser === user;
    this.turnState.queue = new Queue(this.turnState.queue.toArray().filter(u => u !== user));
    this.turnState.currentUser = this.turnState.queue.peek() || null;
    if (wasCurrent) this.nextTurn();
  }

  private clearTurnInterval(): void {
    this.turnState.interval && clearInterval(this.turnState.interval);
    this.turnState.interval = undefined;
  }

  /** Vote System */
  onVote(user: User, choice: number): void {
    if (choice === 1 && !this.voteState.inProgress) {
      if (this.voteState.cooldown > 0 || !this.authCheck(user, this.config.auth.guestPermissions.callForReset)) {
        user.sendVoteCooldown(this.voteState.cooldown);
        return;
      }
      this.startVote();
      this.broadcastChat('', `${user.username} has started a vote to reset the VM.`);
    }

    if (!this.canVote(user)) return;

    const voteValue = choice === 1;
    if (user.IP.vote !== voteValue) {
      this.broadcastChat('', `${user.username} has voted ${voteValue ? 'yes' : 'no'}.`);
    }
    user.IP.vote = voteValue;
    this.sendVoteUpdate();
  }

  private canVote(user: User): boolean {
    return this.vm.SnapshotsSupported() && 
           user.connectedToNode && 
           user.VoteRateLimit.request() && 
           this.authCheck(user, this.config.auth.guestPermissions.vote);
  }

  private startVote(): void {
    this.voteState.inProgress = true;
    this.voteState.timeLeft = this.config.collabvm.voteTime;
    this.voteState.interval = setInterval(() => {
      if (--this.voteState.timeLeft < 1) this.endVote();
    }, 1000);
  }

  private endVote(): void {
    this.voteState.inProgress = false;
    clearInterval(this.voteState.interval!);
    
    const { yes, no } = this.getVoteCounts();
    const votePassed = yes >= no;
    
    this.broadcast((c) => c.sendVoteEnded(), null);
    this.broadcastChat('', `The vote to reset the VM has ${votePassed ? 'won' : 'lost'}.`);
    
    if (votePassed) this.vm.Reset();
    
    IPDataManager.ForEachIPData(ip => { ip.vote = null; });
    this.voteState.cooldown = this.config.collabvm.voteCooldown;
    
    const cooldownInt = setInterval(() => {
      if (--this.voteState.cooldown < 1) clearInterval(cooldownInt);
    }, 1000);
  }

  private sendVoteUpdate(): void {
    if (!this.voteState.inProgress) return;
    const { yes, no } = this.getVoteCounts();
    this.connectedClients.forEach(c => c.sendVoteStats(this.voteState.timeLeft * 1000, yes, no));
  }

  private getVoteCounts(): VoteTally {
    let yes = 0, no = 0;
    IPDataManager.ForEachIPData(ip => {
      if (ip.vote === true) yes++;
      if (ip.vote === false) no++;
    });
    return { yes, no };
  }

  /** Input Handling */
  onKey(user: User, keysym: number, pressed: boolean): void {
    if (this.turnState.currentUser !== user && user.rank !== Rank.Admin) return;
    this.vm.GetDisplay()?.KeyboardEvent(keysym, pressed);
  }

  onMouse(user: User, x: number, y: number, buttonMask: number): void {
    if (this.turnState.currentUser !== user && user.rank !== Rank.Admin) return;
    this.vm.GetDisplay()?.MouseEvent(x, y, buttonMask);
  }

  /** Display System */
  private onDisplayResize(size: Size): void {
    this.displaySize = size;
    this.connectedClients.forEach(c => {
      if (!this.screenHidden || c.rank !== Rank.Unregistered) {
        c.sendScreenResize(size.width, size.height);
      }
    });
  }

  private async processFrame(): Promise<void> {
    if (this.rectQueue.length === 0) return;
    
    const rects = this.rectQueue.splice(0);
    const promises = rects.map(rect => this.encodeAndBroadcastRect(rect));
    await Promise.all(promises);
  }

  private async encodeAndBroadcastRect(rect: Rect): Promise<void> {
    const encoded = await this.encodeRect(rect);
    this.connectedClients.forEach(c => {
      if (!this.screenHidden || c.rank !== Rank.Unregistered) {
        c.sendScreenUpdate({ x: rect.x, y: rect.y, data: encoded });
      }
    });
  }

  private async encodeRect(rect: Rect): Promise<Buffer> {
    const display = this.vm.GetDisplay();
    return display?.Connected() ? 
      JPEGEncoder.Encode(display.Buffer()!, display.Size(), rect) : 
      Buffer.alloc(0);
  }

  /** Protocol Handlers - Cleaned Up */
  onNop(user: User): void { user.onNop(); }

  onNoFlag(user: User): void { if (!user.connectedToNode) user.noFlag = true; }

  onCapabilityUpgrade(user: User, capabilities: string[]): boolean {
    if (user.connectedToNode) return false;
    
    const enabled: ProtocolUpgradeCapability[] = [];
    for (const cap of capabilities) {
      if (cap === ProtocolUpgradeCapability.BinRects) {
        enabled.push(cap as ProtocolUpgradeCapability);
        user.Capabilities.bin = true;
        user.protocol = TheProtocolManager.getProtocol('binary1');
      }
    }
    user.sendCapabilities(enabled);
    return true;
  }

  onChat(user: User, message: string): void {
    if (!user.username || user.IP.muted || !this.authCheck(user, this.config.auth.guestPermissions.chat)) return;
    
    const cleanMsg = Utilities.HTMLSanitize(message).slice(0, this.config.collabvm.maxChatLength).trim();
    if (!cleanMsg) return;
    
    this.broadcastChat(user.username!, cleanMsg);
    user.onChatMsgSent();
  }

  onRename(user: User, newName?: string): void {
    if (!user.RenameRateLimit.request() || (user.connectedToNode && user.IP.muted)) return;
    if (this.config.auth.enabled && user.rank !== Rank.Unregistered) return;
    
    this.renameUser(user, newName);
  }

  private renameUser(user: User, newName?: string, announce = true): void {
    const oldName = user.username;
    let status = ProtocolRenameStatus.Ok;

    if (!newName) {
      user.assignGuestName(Array.from(this.clientByName.keys()));
    } else {
      newName = newName.trim();
      if (this.clientByName.has(newName) || 
          !/^[a-zA-Z0-9\s\-_\.]{3,20}$/.test(newName) || 
          this.config.collabvm.usernameblacklist.includes(newName)) {
        user.assignGuestName(Array.from(this.clientByName.keys()));
        status = ProtocolRenameStatus.UsernameInvalid;
      } else {
        user.username = newName;
      }
    }

    this.clientByName.set(user.username!, user);
    if (oldName) this.clientByName.delete(oldName);

    user.sendSelfRename(status, user.username!, user.rank);
    
    if (announce) {
      if (oldName) {
        this.connectedClients.forEach(c => c.sendRename(oldName, user.username!, user.rank));
      } else {
        this.broadcastUserUpdate(user);
      }
    }
  }

  private broadcastUserUpdate(user: User): void {
    const addUser: ProtocolAddUser = { username: user.username!, rank: user.rank };
    const flag: ProtocolFlag = user.countryCode ? { username: user.username!, countryCode: user.countryCode } : undefined;
    
    this.connectedClients.forEach(c => {
      c.sendAddUser([addUser]);
      if (flag) c.sendFlag([flag]);
    });
  }

  private broadcastUserRemoval(username: string): void {
    if (username) {
      this.connectedClients.forEach(c => c.sendRemUser([username]));
    }
  }

  /** Admin Commands - Simplified */
  async onAdminLogin(user: User, password: string): Promise<void> {
    if (!user.LoginRateLimit.request() || !user.username) return;
    
    const pwdHash = createHash('sha256').update(password, 'utf-8').digest('hex');
    
    if (pwdHash === this.config.collabvm.adminpass) {
      user.rank = Rank.Admin;
      this.adminClients.add(user);
    } else if (this.config.collabvm.moderatorEnabled && pwdHash === this.config.collabvm.modpass) {
      user.rank = Rank.Moderator;
    } else if (this.config.collabvm.turnwhitelist && pwdHash === this.config.collabvm.turnpass) {
      user.turnWhitelist = true;
      user.sendChatMessage('', 'You may now take turns.');
      return;
    } else {
      user.sendAdminLoginResponse(false, undefined);
      return;
    }

    user.sendAdminLoginResponse(true, user.rank === Rank.Admin ? undefined : this.modPerms);
    this.broadcastUserUpdate(user);
  }

  onAdminKickUser(user: User, targetName: string): void {
    if (!this.hasPermission(user, 'kick')) return;
    const target = this.clientByName.get(targetName);
    if (target) {
      TheAuditLog.onKick(user, target);
      target.kick();
    }
  }

  onAdminEndTurn(user: User, targetName: string): void {
    if (!this.hasPermission(user, 'bypassturn')) return;
    const target = this.clientByName.get(targetName);
    if (target) this.endTurn(target);
  }

  private hasPermission(user: User, permission: string): boolean {
    return user.rank === Rank.Admin || 
           (user.rank === Rank.Moderator && this.config.collabvm.moderatorPermissions[permission]);
  }

  /** Utility Methods */
  private authCheck(user: User, guestPermission: boolean): boolean {
    return !this.config.auth?.enabled || 
           (user.rank !== Rank.Unregistered || guestPermission);
  }

  private resolveGeoIP(user: User): void {
    if (!this.config.geoip.enabled || !this.geoipReader) return;
    try {
      user.countryCode = this.geoipReader.country(user.IP.address).country?.isoCode ?? null;
    } catch {}
  }

  private sendInitialData(user: User): void {
    if (this.config.auth?.enabled) user.sendAuth(this.config.auth.apiEndpoint);
    user.sendAddUser(this.getUserList());
    if (this.config.geoip.enabled) user.sendFlag(this.getFlags());
    
    if (this.chatHistory.size) {
      user.sendChatHistoryMessage(this.chatHistory.toArray() as ChatHistoryEntry[]);
    }
    if (this.config.collabvm.motd) {
      user.sendChatMessage('', this.config.collabvm.motd);
    }
  }

  private getUserList(): ProtocolAddUser[] {
    return Array.from(this.clientByName.values()).map(u => ({
      username: u.username!,
      rank: u.rank
    }));
  }

  private getFlags(): ProtocolFlag[] {
    return Array.from(this.clientByName.values())
      .filter(u => u.countryCode && (!u.noFlag || u.rank === Rank.Unregistered))
      .map(u => ({ username: u.username!, countryCode: u.countryCode! }));
  }

  private sendInitialUserData(user: User) {
    user.sendAddUser(this.getUserList());
    if (this.config.geoip.enabled) user.sendFlag(this.getFlags());
  }

  private cleanupUserState(user: User): void {
    if (user.IP.vote !== null) {
      user.IP.vote = null;
      this.sendVoteUpdate();
    }
    if (this.turnState.queue.toArray().includes(user) || this.turnState.currentUser === user) {
      this.removeFromTurnQueue(user);
    }
  }

  // Remaining protocol handlers follow the same clean pattern...
}
